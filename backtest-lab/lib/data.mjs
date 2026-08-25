/**
 * OKX 데이터 수집 — 캔들(확정봉만) + 펀딩비 실측 이력.
 *
 * 펀딩을 가정값이 아니라 실측으로 쓰는 것이 이 회차의 전제다.
 * 레버리지 10×에서 펀딩 0.01%/8h는 자기자본 기준 0.3%/일 — 월 9%다.
 * 월 10%를 논하면서 이걸 가정으로 두면 답이 통째로 바뀐다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://www.okx.com/api/v5";
export const INST = "BTC-USDT-SWAP";
const PAGE = 100;

export const LAB = dirname(dirname(fileURLToPath(import.meta.url)));
export const CACHE_DIR = join(LAB, ".cache");
export const OUT_DIR = join(LAB, "out");

export const TFS = {
  "15m": { bar: "15m", ms: 15 * 60_000, days: 730, maxHold: 288, dayBars: 96 },
  "1H": { bar: "1H", ms: 3_600_000, days: 1200, maxHold: 120, dayBars: 24 },
  "4H": { bar: "4H", ms: 4 * 3_600_000, days: 1800, maxHold: 60, dayBars: 6 },
  "1D": { bar: "1D", ms: 24 * 3_600_000, days: 1800, maxHold: 20, dayBars: 1 },
};

/** 상위봉 정렬 필터가 참조할 봉 — 4H는 1D를, 15m·1H는 4H를 본다. */
export const HTF_OF = { "15m": "4H", "1H": "4H", "4H": "1D" };

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

export async function fetchCandles(bar, ms, days, inst = INST) {
  const to = Math.floor(Date.now() / ms) * ms;
  const from = to - days * 86_400_000;
  const span = ms * PAGE;
  const pages = Math.ceil((to - from) / span);
  const cursors = Array.from({ length: pages }, (_, i) => to - i * span);
  const out = new Map();
  for (let i = 0; i < cursors.length; i += 8) {
    const batch = await Promise.all(
      cursors.slice(i, i + 8).map((c) =>
        getJson(`${BASE}/market/history-candles?instId=${inst}&bar=${bar}&after=${c}&limit=${PAGE}`),
      ),
    );
    for (const rows of batch) {
      for (const row of rows) {
        const t = Number(row[0]);
        // row[8]==="1" 만 — 미확정봉은 다음 수집 때 값이 바뀐다.
        if (t >= from && t < to && row[8] === "1") {
          out.set(t, {
            t,
            o: Number(row[1]),
            h: Number(row[2]),
            l: Number(row[3]),
            c: Number(row[4]),
            v: Number(row[5]),
          });
        }
      }
    }
    if (i + 8 < cursors.length) await new Promise((r) => setTimeout(r, 1400));
    process.stdout.write(`\r  ${bar}: ${Math.min(i + 8, cursors.length)}/${cursors.length} 페이지`);
  }
  process.stdout.write("\n");
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/**
 * OKX 펀딩비 실측 — 8시간 주기. 공개 API가 약 95일치만 보존한다(2026-08 확인).
 * 그래서 이것만으로는 730~1800일 창을 못 덮는다. 대리변수 검증용으로 쓴다.
 */
export async function fetchFundingOkx(days, inst = INST) {
  const from = Date.now() - days * 86_400_000;
  const out = new Map();
  let cursor = Date.now();
  for (let page = 0; page < 400; page += 1) {
    const rows = await getJson(`${BASE}/public/funding-rate-history?instId=${inst}&after=${cursor}&limit=100`);
    if (!rows.length) break;
    let oldest = cursor;
    for (const r of rows) {
      const t = Number(r.fundingTime);
      out.set(t, { t, rate: Number(r.realizedRate ?? r.fundingRate) });
      oldest = Math.min(oldest, t);
    }
    process.stdout.write(`\r  OKX 펀딩: ${out.size}건 (${new Date(oldest).toISOString().slice(0, 10)})`);
    if (oldest <= from) break;
    cursor = oldest;
    await new Promise((r) => setTimeout(r, 220));
  }
  process.stdout.write("\n");
  return [...out.values()].filter((x) => x.t >= from).sort((a, b) => a.t - b.t);
}

/**
 * Binance BTCUSDT 펀딩 이력 — 2019년부터 전부 보존된다. 전 구간 대리변수.
 * 다른 거래소 값을 쓰는 것은 타협이다. 그래서 OKX 실측과 겹치는 95일에서
 * 상관·평균 차이를 계산해 리포트에 싣는다(fetch.mjs). 검증 없이 쓰지 않는다.
 */
export async function fetchFundingBinance(days, symbol = "BTCUSDT") {
  const from = Date.now() - days * 86_400_000;
  const out = new Map();
  let cursor = from;
  for (let page = 0; page < 3000; page += 1) {
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&limit=1000`,
    );
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw new Error(`Binance HTTP ${res.status}`);
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) break;
    let newest = cursor;
    for (const r of rows) {
      const t = Number(r.fundingTime);
      out.set(t, { t, rate: Number(r.fundingRate) });
      newest = Math.max(newest, t);
    }
    process.stdout.write(`\r  Binance 펀딩: ${out.size}건 (→ ${new Date(newest).toISOString().slice(0, 10)})`);
    if (newest <= cursor) break;
    cursor = newest + 1;
    await new Promise((r) => setTimeout(r, 160));
  }
  process.stdout.write("\n");
  return [...out.values()].sort((a, b) => a.t - b.t);
}

export function cachePath(name) {
  return join(CACHE_DIR, name);
}

export function saveCache(name, obj) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(name), JSON.stringify(obj));
}

export function loadCache(name) {
  const p = cachePath(name);
  if (!existsSync(p)) throw new Error(`캐시 없음: ${p} — node backtest-lab/fetch.mjs 를 먼저 실행하라.`);
  return JSON.parse(readFileSync(p, "utf8"));
}

export function saveOut(name, obj) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, name), JSON.stringify(obj, null, 1));
}

export function loadOut(name) {
  const p = join(OUT_DIR, name);
  if (!existsSync(p)) throw new Error(`산출물 없음: ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

/**
 * 펀딩 누적 — 구간 [t0, t1) 에 정산된 펀딩률의 합(%).
 * 롱은 rate>0 이면 지불, 숏은 수취. 반환은 "롱 기준 비용 %".
 */
export function buildFundingIndex(funding) {
  const times = funding.map((f) => f.t);
  const cum = new Array(funding.length + 1).fill(0);
  for (let i = 0; i < funding.length; i += 1) cum[i + 1] = cum[i] + funding[i].rate * 100;
  const lowerBound = (t) => {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (t0, t1) => {
    if (!times.length) return 0;
    const a = lowerBound(t0);
    const b = lowerBound(t1);
    return cum[b] - cum[a];
  };
}
