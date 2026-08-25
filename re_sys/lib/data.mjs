/**
 * 복기 데이터 저장소 — OKX 확정 캔들을 로컬(re_sys/data/)에 누적한다.
 *
 * backtest-lab 의 수집과 다른 점: 고정 기간 창이 아니라 "상장 시점까지 전부"를
 * 뒤로 페이지네이션하고, 이미 받은 구간과 다리가 놓이면 멈춘다(증분 누적).
 * 같은 점: 확정봉(row[8]==="1")만 받는다 — 미확정 봉은 다음 수집 때 값이 바뀐다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://www.okx.com/api/v5";
const PAGE = 100;

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = join(ROOT, "data");
export const OUT_DIR = join(ROOT, "out");

export const INST = "BTC-USDT-SWAP";

/**
 * 수집 대상 타임프레임 — capDays 가 null 이면 상장 시점까지 전부.
 * 15m·5m 은 초기 수집 폭만 제한한다. 증분 실행이 쌓이면 저장분은 그 폭을 넘어 자란다.
 * 봇(config.mjs)과 같은 "1D"(OKX 기본, UTC+8 정렬) — 복기가 다른 봉을 보면 안 된다.
 */
export const TF = {
  "1D": { bar: "1D", ms: 24 * 3_600_000, capDays: null },
  "4H": { bar: "4H", ms: 4 * 3_600_000, capDays: null },
  "1H": { bar: "1H", ms: 3_600_000, capDays: null },
  "15m": { bar: "15m", ms: 15 * 60_000, capDays: 730 },
  "5m": { bar: "5m", ms: 5 * 60_000, capDays: 60 },
};

/** 수집 종목 — 시스템(BTC) + 본인 매매 주력(DOGE). */
export const INSTRUMENTS = [
  { sym: "BTC", instId: "BTC-USDT-SWAP" },
  { sym: "DOGE", instId: "DOGE-USDT-SWAP" },
];

/** 쿼드 복기(BTC 4H·1D)가 쓰는 부분집합 — 키 이름을 기존과 같게 유지한다. */
export const BARS = { "4H": TF["4H"], "1D": TF["1D"] };

async function getJson(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return getJson(url, attempt + 1);
    }
    if (!res.ok) throw new Error(`OKX HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== "0") throw new Error(`OKX ${json.code}: ${json.msg}`);
    return json.data;
  } catch (err) {
    if (attempt < 6) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return getJson(url, attempt + 1);
    }
    throw err;
  }
}

/**
 * 뒤로 페이지네이션 — after 커서는 "이 시각보다 오래된 봉"을 준다.
 * stopAtTs 이하 봉을 만나면(이미 가진 구간과 다리가 놓이면) 멈춘다.
 * stopAtTs 가 null 이면 빈 페이지가 나올 때까지(=상장 시점까지) 간다.
 */
export async function fetchHistoryBack(bar, { stopAtTs = null, maxPages = 400 } = {}, inst = INST) {
  const out = new Map();
  let cursor = Date.now();
  for (let page = 0; page < maxPages; page += 1) {
    const rows = await getJson(
      `${BASE}/market/history-candles?instId=${inst}&bar=${bar}&after=${cursor}&limit=${PAGE}`,
    );
    if (!rows.length) break;
    let oldest = cursor;
    for (const row of rows) {
      const t = Number(row[0]);
      oldest = Math.min(oldest, t);
      if (row[8] !== "1") continue;
      out.set(t, {
        t,
        o: Number(row[1]),
        h: Number(row[2]),
        l: Number(row[3]),
        c: Number(row[4]),
        v: Number(row[5]),
      });
    }
    process.stdout.write(
      `\r  ${bar}: ${out.size}봉 (← ${new Date(oldest).toISOString().slice(0, 10)})`,
    );
    if (stopAtTs !== null && oldest <= stopAtTs) break;
    cursor = oldest;
    await new Promise((r) => setTimeout(r, 130));
  }
  process.stdout.write("\n");
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/**
 * 펀딩비 실측 — OKX 공개 API 보존창이 약 95일뿐이라 "누적"이 곧 아카이브다.
 * 주기적으로 돌리면 보존창 밖으로 밀려난 구간도 로컬에 남는다.
 */
export async function fetchFundingBack(instId) {
  const out = new Map();
  let cursor = Date.now();
  for (let page = 0; page < 40; page += 1) {
    const rows = await getJson(
      `${BASE}/public/funding-rate-history?instId=${instId}&after=${cursor}&limit=100`,
    );
    if (!rows.length) break;
    let oldest = cursor;
    for (const r of rows) {
      const t = Number(r.fundingTime);
      oldest = Math.min(oldest, t);
      out.set(t, { t, rate: Number(r.realizedRate ?? r.fundingRate) });
    }
    cursor = oldest;
    await new Promise((r) => setTimeout(r, 220));
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/** 기존 저장분과 병합 — 같은 t 는 새 값이 이긴다(확정봉이므로 실제로는 동일해야 한다). */
export function mergeCandles(existing, fetched) {
  const map = new Map(existing.map((c) => [c.t, c]));
  for (const c of fetched) map.set(c.t, c);
  return [...map.values()].sort((a, b) => a.t - b.t);
}

/** 검증 — 시각 단조 증가·결측률. 나쁜 데이터로 복기하면 나쁜 복기다. */
export function validateCandles(candles, ms) {
  let nonMono = 0;
  for (let i = 1; i < candles.length; i += 1) if (candles[i].t <= candles[i - 1].t) nonMono += 1;
  const spanMs = candles.length ? candles[candles.length - 1].t - candles[0].t : 0;
  const expected = candles.length ? Math.floor(spanMs / ms) + 1 : 0;
  const missPct = expected ? ((expected - candles.length) / expected) * 100 : 0;
  return { bars: candles.length, nonMono, missPct, spanDays: spanMs / 86_400_000 };
}

/* ---------- 저장소 ---------- */

export function dataPath(name) {
  return join(DATA_DIR, name);
}

export function saveData(name, obj) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(dataPath(name), JSON.stringify(obj));
}

/** CSV 등 텍스트 로우데이터 저장. */
export function saveDataText(name, text) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(dataPath(name), text);
}

export function loadData(name) {
  const p = dataPath(name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function saveOut(name, text) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, name), text);
}

/** 로우데이터 CSV — 외부 도구(엑셀·파이썬) 분석용. */
export function candlesCsv(candles) {
  const head = "t,iso,open,high,low,close,volume";
  const rows = candles.map(
    (c) => `${c.t},${new Date(c.t).toISOString()},${c.o},${c.h},${c.l},${c.c},${c.v}`,
  );
  return [head, ...rows].join("\n") + "\n";
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.join(",");
  const body = rows.map((r) => columns.map((k) => esc(r[k])).join(","));
  return [head, ...body].join("\n") + "\n";
}
