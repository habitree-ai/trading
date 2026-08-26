/**
 * ONEWAY 회차 P1 — 데이터 수집.
 *
 * 이 회차는 "전략이 버는가"가 아니라 "시장이 어떻게 한 방향으로 가는가"를 묻는다.
 * 되돌림 판정이 결론을 좌우하므로 해상도가 곧 정확도다 — 그래서 1m을 주력으로 쓰고,
 * 5m·15m은 같은 질문을 더 긴 구간에서 되묻는 대조군이다.
 *
 * 검증 기준(사전 등록): 봉별 개수·실제 일수 출력 · 결측률 <1% · 시각 단조 증가.
 * 하나라도 어긋나면 여기서 멈춘다.
 *
 * 사용: node --max-old-space-size=8192 scripts/backtest/oneway-fetch.mjs [tf...]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://www.okx.com/api/v5";
const INST = "BTC-USDT-SWAP";
const PAGE = 100;
// OKX 공개 엔드포인트는 IP당 20req/2s. 15병렬 + 1.6초 대기 = 18.75req/2s 로 아래에 둔다.
const CONCURRENCY = 15;
const PAUSE_MS = 1600;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE_DIR = join(repoRoot, "scripts", "backtest", ".cache");

/**
 * 대상 봉.
 *
 * 1m 을 전 구간(2400일) 받으면 페이지가 34,000장이라 두 시간이 넘는다. 1m 의 역할은
 * "5m 해상도가 되돌림을 놓치는가"를 확인하는 정밀 대조이므로 540일이면 답이 나온다.
 */
const TFS = {
  "1m": { bar: "1m", ms: 60_000, days: 540 },
  "5m": { bar: "5m", ms: 5 * 60_000, days: 2400 },
  "15m": { bar: "15m", ms: 15 * 60_000, days: 2400 },
  "1H": { bar: "1H", ms: 3600_000, days: 2400 },
  "4H": { bar: "4H", ms: 4 * 3600_000, days: 2400 },
  "1D": { bar: "1D", ms: 86_400_000, days: 2400 },
  "1W": { bar: "1W", ms: 7 * 86_400_000, days: 2400 },
};

async function fetchPage(bar, after, attempt = 0) {
  const url = `${BASE}/market/history-candles?instId=${INST}&bar=${bar}&after=${after}&limit=${PAGE}`;
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (e) {
    if (attempt < 6) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return fetchPage(bar, after, attempt + 1);
    }
    throw e;
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 6) {
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    return fetchPage(bar, after, attempt + 1);
  }
  if (!res.ok) throw new Error(`OKX ${res.status}`);
  const json = await res.json();
  if (json.code !== "0") throw new Error(`OKX: ${json.msg || json.code}`);
  return json.data;
}

/** 봉은 [t,o,h,l,c,v] 배열로 담는다 — 1m 77만 봉을 객체로 들면 캐시가 세 배가 된다. */
async function fetchCandles(bar, ms, days) {
  const to = Math.floor(Date.now() / ms) * ms;
  const from = to - days * 86_400_000;
  const span = ms * PAGE;
  const pages = Math.ceil((to - from) / span);
  const cursors = Array.from({ length: pages }, (_, i) => to - i * span);
  const out = new Map();
  const started = Date.now();

  for (let i = 0; i < cursors.length; i += CONCURRENCY) {
    const batch = await Promise.all(cursors.slice(i, i + CONCURRENCY).map((c) => fetchPage(bar, c)));
    for (const rows of batch) {
      for (const row of rows) {
        const t = Number(row[0]);
        // row[8]==="1" 은 확정된 봉. 진행 중인 봉이 섞이면 고·저가가 나중에 바뀐다.
        if (t >= from && t < to && row[8] === "1") {
          out.set(t, [t, +row[1], +row[2], +row[3], +row[4], +row[5]]);
        }
      }
    }
    const done = Math.min(i + CONCURRENCY, cursors.length);
    const elapsed = (Date.now() - started) / 1000;
    const eta = elapsed * (cursors.length / done - 1);
    process.stdout.write(
      `\r  ${bar}: ${done}/${cursors.length}p · ${out.size}봉 · 경과 ${(elapsed / 60).toFixed(1)}분 · 남은 ${(eta / 60).toFixed(1)}분   `,
    );
    if (done < cursors.length) await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  process.stdout.write("\n");
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}

function verify(tf, cfg, rows) {
  if (!rows.length) return { ok: false, msg: "0봉" };
  let nonMono = 0;
  for (let i = 1; i < rows.length; i += 1) if (rows[i][0] <= rows[i - 1][0]) nonMono += 1;
  const spanMs = rows[rows.length - 1][0] - rows[0][0];
  const spanDays = spanMs / 86_400_000;
  const expected = Math.floor(spanMs / cfg.ms) + 1;
  const missPct = ((expected - rows.length) / expected) * 100;
  const line =
    `  ${rows.length.toLocaleString()}봉 · 실제 ${spanDays.toFixed(0)}일 · 결측 ${missPct.toFixed(3)}% · ` +
    `단조위반 ${nonMono} · ${new Date(rows[0][0]).toISOString().slice(0, 10)} → ${new Date(rows[rows.length - 1][0]).toISOString().slice(0, 10)}`;
  const ok = nonMono === 0 && missPct < 1;
  return { ok, line, stat: { tf, bars: rows.length, spanDays: Math.round(spanDays), missPct: +missPct.toFixed(4), nonMono } };
}

async function main() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const want = process.argv.slice(2).filter((a) => TFS[a]);
  const targets = want.length ? want : Object.keys(TFS);
  const report = [];

  for (const tf of targets) {
    const cfg = TFS[tf];
    const path = join(CACHE_DIR, `oneway-${tf}.json`);
    console.log(`\n[${tf}] ${cfg.days}일 수집`);
    const rows = await fetchCandles(cfg.bar, cfg.ms, cfg.days);
    const v = verify(tf, cfg, rows);
    console.log(v.line ?? `  ✗ ${v.msg}`);
    if (!v.ok) {
      console.error(`  ✗ ${tf}: 검증 실패 — 중단`);
      process.exit(1);
    }
    writeFileSync(path, JSON.stringify(rows));
    console.log(`  ✓ 저장 ${path}`);
    report.push(v.stat);
  }

  const rp = join(CACHE_DIR, "oneway-fetch-report.json");
  const prev = existsSync(rp) ? JSON.parse(readFileSync(rp, "utf8")) : [];
  const merged = [...prev.filter((p) => !report.some((r) => r.tf === p.tf)), ...report];
  writeFileSync(rp, JSON.stringify(merged, null, 2));
  console.log(`\n수집 완료 — ${report.map((r) => r.tf).join(", ")}`);
}

main().catch((e) => {
  console.error("\n✗", e.message);
  process.exit(1);
});
