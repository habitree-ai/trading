/**
 * 업비트 캔들 수집 — 유니버스의 KRW 마켓 + KRW-USDT + USDT 마켓 3종.
 *
 * 업비트 `to` 커서는 역방향(그 시각 이전 count 개)이지만, 시간 격자가 고정이므로
 * OKX 와 같이 커서를 미리 계산해 병렬로 받는다. 체결 없는 분은 봉이 없어서 한 페이지가
 * 200분보다 더 과거까지 닿을 뿐 구멍은 생기지 않는다(겹침은 Map 으로 지운다).
 *
 * 한도: 시세 그룹별 IP 당 10req/s → 동시 4 × 500ms = 8req/s.
 * 검증 허용치는 시리즈마다 다르다 — 알트 1m 결측은 체결이 없던 분이라 정상이다.
 *
 * 사용: node arbitrage/fetch-upbit.mjs [--days 90] [--force] [--only KRW-BTC,KRW-USDT]
 */
import { fetchJson, pacedPool, progress } from "./lib/http.mjs";
import { hasCache, loadCache, mergeReport, saveCache } from "./lib/cache.mjs";
import { verifySeries } from "./lib/verify.mjs";

const BASE = "https://api.upbit.com/v1";
const PAGE = 200;
const CONCURRENCY = 4;
const PAUSE_MS = 500;
const DAY = 86_400_000;

const args = process.argv.slice(2);
const di = args.indexOf("--days");
const MIN_DAYS = di >= 0 ? Number(args[di + 1]) : 90;
const DAILY_DAYS = 3 * 365 + 30;
const force = args.includes("--force");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;

const uni = loadCache("universe.json");
if (!uni) {
  console.error("✗ .cache/universe.json 이 없다 — 먼저 node arbitrage/universe.mjs");
  process.exit(1);
}
const core = new Set(uni.core);

/** 수집 대상. tf 는 캐시 파일명, unit 은 업비트 파라미터(1·5 = 분, "D" = 일). */
const targets = [];
for (const c of uni.list) {
  const isCore = core.has(c.symbol);
  // 비핵심 알트는 KST 새벽 무체결 구간이 많다(실측: STX 5m 결측 16%, 대부분 UTC 16~21시). 조인은 inner 라 통계에 영향 없다.
  targets.push({ market: c.upbit, tf: c.tier, unit: c.tier === "1m" ? 1 : 5, days: MIN_DAYS, maxMiss: ["BTC", "ETH", "XRP"].includes(c.symbol) ? 1 : isCore ? 30 : 35 });
  targets.push({ market: c.upbit, tf: "1D", unit: "D", days: DAILY_DAYS, maxMiss: 1 });
}
targets.push({ market: "KRW-USDT", tf: "1m", unit: 1, days: MIN_DAYS, maxMiss: 1 });
targets.push({ market: "KRW-USDT", tf: "1D", unit: "D", days: DAILY_DAYS, maxMiss: 1 });
for (const m of ["USDT-BTC", "USDT-ETH", "USDT-XRP"]) targets.push({ market: m, tf: "1m", unit: 1, days: MIN_DAYS, maxMiss: 60, thin: true });

function parseRows(data, from, to) {
  const out = [];
  for (const r of data) {
    const t = Date.parse(`${r.candle_date_time_utc}Z`);
    if (t >= from && t < to) out.push([t, r.opening_price, r.high_price, r.low_price, r.trade_price, r.candle_acc_trade_volume]);
  }
  return out;
}

async function fetchSeries(tg) {
  const ms = tg.unit === "D" ? DAY : tg.unit * 60_000;
  const to = Math.floor(Date.now() / ms) * ms;
  const from = to - tg.days * DAY;
  const span = ms * PAGE;
  const pages = Math.ceil((to - from) / span);
  const cursors = Array.from({ length: pages }, (_, i) => to - i * span);
  const path = tg.unit === "D" ? `${BASE}/candles/days` : `${BASE}/candles/minutes/${tg.unit}`;
  const out = new Map();
  const label = `${tg.market} ${tg.tf}`;
  await pacedPool(
    cursors,
    async (c) => {
      const isoTo = new Date(c).toISOString().slice(0, 19) + "Z";
      const data = await fetchJson(`${path}?market=${tg.market}&to=${isoTo}&count=${PAGE}`);
      for (const row of parseRows(data, from, to)) out.set(row[0], row);
    },
    { concurrency: CONCURRENCY, pauseMs: PAUSE_MS, onProgress: (d, n, s) => progress(label, d, n, s, `· ${out.size}봉`) },
  );
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}

async function main() {
  const list = only ? targets.filter((t) => only.includes(t.market)) : targets;
  console.log(`업비트 수집 대상 ${list.length} 시리즈 (분봉 ${MIN_DAYS}일 · 일봉 ${DAILY_DAYS}일)`);
  const report = [];
  const failed = [];
  for (const tg of list) {
    const name = `upbit-${tg.market}-${tg.tf}`;
    const cached = !force && hasCache(`${name}.json`);
    // 캐시가 있으면 재수집 없이 재검증만 한다 — 허용치를 바꿔도 fetch-report 가 따라오게.
    const rows = cached ? loadCache(`${name}.json`) : await fetchSeries(tg);
    if (cached) process.stdout.write(`  = ${name} 캐시 재검증
`);
    const ms = tg.unit === "D" ? DAY : tg.unit * 60_000;
    const v = verifySeries(name, rows, { tfMs: ms, maxMissPct: tg.maxMiss });
    console.log(`  ${v.line}`);
    if (rows.length) saveCache(`${name}.json`, rows);
    report.push({ ...v, source: "api.upbit.com", thin: Boolean(tg.thin) });
    if (!v.ok && !tg.thin) failed.push(name);
  }
  if (report.length) mergeReport(report);
  if (failed.length) {
    console.error(`\n✗ 검증 실패 ${failed.length}건: ${failed.join(", ")} (파일은 저장됨 — 결측을 보고 판단)`);
    process.exit(1);
  }
  console.log(`\n✓ 업비트 수집 완료 — ${report.length} 시리즈`);
}

main().catch((e) => {
  console.error("\n✗", e.message);
  process.exit(1);
});
