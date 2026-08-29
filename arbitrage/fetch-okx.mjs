/**
 * OKX 수집 — 유니버스의 현물·스왑 캔들, BTC-USD 지수·코인마진 만기선물 일봉, 펀딩비.
 *
 * - 분봉: 핵심 6종 1m, 나머지 5m, 90일. 현물(X-USDT)과 스왑(X-USDT-SWAP) 둘 다.
 * - 일봉: 반드시 `1Dutc` — OKX `1D` 는 UTC+8 경계라 업비트(UTC 00:00) 와 어긋난다.
 * - 만기선물: USDT 마진 만기선물은 2026-06 에 사라졌다. 남은 코인마진 `BTC-USD-YYMMDD` 를
 *   BTC-USD 지수 일봉과 함께 받아 베이시스를 잰다.
 * - 펀딩: OKX 실측(약 95일 보존) + Binance 3년 대리 — backtest-lab/lib/data.mjs 를 그대로 import.
 *
 * 한도: 공개 시세 IP 당 20req/2s → 15 병렬 + 1.6초 (oneway-fetch 와 동일).
 * 사용: node arbitrage/fetch-okx.mjs [--days 90] [--force] [--only BTC-USDT,BTC-USDT-SWAP] [--skip-minute]
 */
import { fetchJson, pacedPool, progress } from "./lib/http.mjs";
import { hasCache, loadCache, mergeReport, saveCache } from "./lib/cache.mjs";
import { verifySeries } from "./lib/verify.mjs";
import { fetchFundingBinance, fetchFundingOkx } from "../backtest-lab/lib/data.mjs";

const BASE = "https://www.okx.com/api/v5";
const PAGE = 100;
const CONCURRENCY = 15;
const PAUSE_MS = 1600;
const DAY = 86_400_000;

const args = process.argv.slice(2);
const di = args.indexOf("--days");
const MIN_DAYS = di >= 0 ? Number(args[di + 1]) : 90;
const DAILY_DAYS = 3 * 365 + 30;
const force = args.includes("--force");
const skipMinute = args.includes("--skip-minute");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;

const uni = loadCache("universe.json");
if (!uni) {
  console.error("✗ .cache/universe.json 이 없다 — 먼저 node arbitrage/universe.mjs");
  process.exit(1);
}
const BARS = { "1m": 60_000, "5m": 300_000, "1Dutc": DAY };

async function okxData(url) {
  const json = await fetchJson(url);
  if (json.code !== "0") throw new Error(`OKX ${json.code}: ${json.msg}`);
  return json.data;
}

/** history-candles(현물·스왑·선물) 또는 history-index-candles(지수). 확정봉만 담는다. */
async function fetchCandles(instId, bar, days, { index = false, since = null } = {}) {
  const ms = BARS[bar];
  const to = Math.floor(Date.now() / ms) * ms;
  const from = Math.max(to - days * DAY, since ?? 0);
  const span = ms * PAGE;
  const pages = Math.ceil((to - from) / span);
  const cursors = Array.from({ length: pages }, (_, i) => to - i * span);
  const ep = index ? "history-index-candles" : "history-candles";
  const out = new Map();
  await pacedPool(
    cursors,
    async (c) => {
      const rows = await okxData(`${BASE}/market/${ep}?instId=${instId}&bar=${bar}&after=${c}&limit=${PAGE}`);
      for (const r of rows) {
        const t = Number(r[0]);
        const confirm = index ? r[5] : r[8];
        if (t >= from && t < to && confirm === "1") out.set(t, [t, +r[1], +r[2], +r[3], +r[4], index ? 0 : +r[5]]);
      }
    },
    { concurrency: CONCURRENCY, pauseMs: PAUSE_MS, onProgress: (d, n, s) => progress(`${instId} ${bar}`, d, n, s, `· ${out.size}봉`) },
  );
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}

async function main() {
  const targets = [];
  for (const c of uni.list) {
    const isCore = uni.core.includes(c.symbol);
    for (const inst of [c.okxSpot, c.okxSwap]) {
      if (!skipMinute) targets.push({ instId: inst, bar: c.tier, days: MIN_DAYS, maxMiss: isCore ? 1 : 5 });
      targets.push({ instId: inst, bar: "1Dutc", days: DAILY_DAYS, maxMiss: 1 });
    }
  }
  targets.push({ instId: "BTC-USD", bar: "1Dutc", days: DAILY_DAYS, maxMiss: 1, index: true });

  // 코인마진 만기선물 — 상장 이후 구간만
  const futs = (await okxData(`${BASE}/public/instruments?instType=FUTURES&instFamily=BTC-USD`)).filter((f) => f.state === "live");
  for (const f of futs) {
    targets.push({ instId: f.instId, bar: "1Dutc", days: DAILY_DAYS, maxMiss: 5, since: Number(f.listTime), meta: { expTime: Number(f.expTime), settleCcy: f.settleCcy, alias: f.alias } });
  }
  saveCache("okx-futures-instruments.json", futs.map((f) => ({ instId: f.instId, alias: f.alias, listTime: Number(f.listTime), expTime: Number(f.expTime), settleCcy: f.settleCcy, ctVal: f.ctVal })));
  console.log(`OKX 수집 대상 ${targets.length} 시리즈 (만기선물 ${futs.length}종 포함)`);

  const list = only ? targets.filter((t) => only.includes(t.instId)) : targets;
  const report = [];
  const failed = [];
  for (const tg of list) {
    const name = `okx-${tg.instId}-${tg.bar}`;
    if (!force && hasCache(`${name}.json`)) {
      console.log(`  = ${name} 있음(건너뜀)`);
      continue;
    }
    const rows = await fetchCandles(tg.instId, tg.bar, tg.days, { index: tg.index, since: tg.since });
    const v = verifySeries(name, rows, { tfMs: BARS[tg.bar], maxMissPct: tg.maxMiss });
    console.log(`  ${v.line}`);
    if (rows.length) saveCache(`${name}.json`, rows);
    report.push({ ...v, source: "okx.com", ...(tg.meta || {}) });
    if (!v.ok) failed.push(name);
  }

  // 펀딩비 — 핵심 6종
  if (!only) {
    for (const s of uni.core) {
      const okxName = `okx-funding-${s}.json`;
      const bnName = `binance-funding-${s}.json`;
      if (force || !hasCache(okxName)) {
        const rows = await fetchFundingOkx(120, `${s}-USDT-SWAP`);
        saveCache(okxName, rows);
        report.push({ name: okxName.replace(".json", ""), ok: rows.length > 0, bars: rows.length, from: rows[0] && new Date(rows[0].t).toISOString().slice(0, 10), to: rows.at(-1) && new Date(rows.at(-1).t).toISOString().slice(0, 10), source: "okx funding-rate-history" });
      }
      if (force || !hasCache(bnName)) {
        const rows = await fetchFundingBinance(DAILY_DAYS, `${s}USDT`);
        saveCache(bnName, rows);
        report.push({ name: bnName.replace(".json", ""), ok: rows.length > 0, bars: rows.length, from: rows[0] && new Date(rows[0].t).toISOString().slice(0, 10), to: rows.at(-1) && new Date(rows.at(-1).t).toISOString().slice(0, 10), source: "binance fapi fundingRate" });
      }
    }
  }

  if (report.length) mergeReport(report);
  if (failed.length) {
    console.error(`\n✗ 검증 실패 ${failed.length}건: ${failed.join(", ")} (파일은 저장됨)`);
    process.exit(1);
  }
  console.log(`\n✓ OKX 수집 완료 — ${report.length} 시리즈`);
}

main().catch((e) => {
  console.error("\n✗", e.message);
  process.exit(1);
});
