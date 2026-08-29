/**
 * 호가 로거 — 업비트·OKX 상위 호가를 5초 간격으로 기록한다.
 *
 * 캔들은 "그 분의 종가"일 뿐이라 실제로 얼마에 얼마나 체결할 수 있었는지는 말해 주지 않는다.
 * 그래서 24~48시간 동안 양쪽 호가를 같은 시각에 찍어 (1) 규모별 실행 가능 스프레드,
 * (2) 두 거래소의 선후행(초 단위), (3) 시간대별 유동성을 잰다. book-summarize.mjs 가 읽는다.
 *
 * 대상: 핵심 6종 업비트 KRW 마켓 + KRW-USDT + USDT-BTC (업비트는 호출 1번),
 *       OKX 현물 6 + 스왑 6 (각 1번, sz=8). 한 틱에 업비트 1 + OKX 12 요청.
 * 파일: .cache/books/YYYY-MM-DD.ndjson (UTC 날짜별 회전) · status.json (하트비트) · logger.log
 *
 * 사용: node arbitrage/book-logger.mjs [--hours 48] [--once]
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchJson, sleep } from "./lib/http.mjs";
import { CACHE_DIR } from "./lib/cache.mjs";

const CORE = ["BTC", "ETH", "XRP", "SOL", "DOGE", "TRX"];
const UPBIT_MARKETS = [...CORE.map((s) => `KRW-${s}`), "KRW-USDT", "USDT-BTC"];
const OKX_INSTS = CORE.flatMap((s) => [`${s}-USDT`, `${s}-USDT-SWAP`]);
const INTERVAL_MS = 5000;
const LEVELS = 8;
const DIR = join(CACHE_DIR, "books");

const args = process.argv.slice(2);
const hi = args.indexOf("--hours");
const hours = hi >= 0 ? Number(args[hi + 1]) : 48;
const once = args.includes("--once");

mkdirSync(DIR, { recursive: true });
const status = {
  startedAt: new Date().toISOString(),
  hours,
  lastTick: null,
  ticks: 0,
  rows: 0,
  errors: 0,
  byEx: { upbit: { ok: 0, err: 0 }, okx: { ok: 0, err: 0 } },
};

function log(msg) {
  appendFileSync(join(DIR, "logger.log"), `${new Date().toISOString()} ${msg}\n`);
}

function writeStatus(extra = {}) {
  writeFileSync(join(DIR, "status.json"), JSON.stringify({ ...status, ...extra }, null, 2));
}

async function upbitBooks(t) {
  const rows = await fetchJson(`https://api.upbit.com/v1/orderbook?markets=${UPBIT_MARKETS.join(",")}`, { retries: 1, baseDelayMs: 500 });
  return rows.map((r) => ({
    t,
    ex: "upbit",
    m: r.market,
    ts: r.timestamp,
    a: r.orderbook_units.slice(0, LEVELS).map((u) => [u.ask_price, u.ask_size]),
    b: r.orderbook_units.slice(0, LEVELS).map((u) => [u.bid_price, u.bid_size]),
  }));
}

async function okxBook(t, instId) {
  const json = await fetchJson(`https://www.okx.com/api/v5/market/books?instId=${instId}&sz=${LEVELS}`, { retries: 1, baseDelayMs: 500 });
  const d = json.data && json.data[0];
  if (!d) throw new Error(`${instId}: empty`);
  return {
    t,
    ex: "okx",
    m: instId,
    ts: Number(d.ts),
    a: d.asks.map((x) => [Number(x[0]), Number(x[1])]),
    b: d.bids.map((x) => [Number(x[0]), Number(x[1])]),
  };
}

async function tick() {
  const t = Date.now();
  const jobs = [upbitBooks(t), ...OKX_INSTS.map((i) => okxBook(t, i).then((r) => [r]))];
  const settled = await Promise.allSettled(jobs);
  const lines = [];
  settled.forEach((s, idx) => {
    const ex = idx === 0 ? "upbit" : "okx";
    if (s.status === "fulfilled") {
      status.byEx[ex].ok += 1;
      for (const r of s.value) lines.push(JSON.stringify(r));
    } else {
      status.byEx[ex].err += 1;
      status.errors += 1;
      log(`${ex} ${idx === 0 ? "" : OKX_INSTS[idx - 1]} ${String(s.reason && s.reason.message).slice(0, 160)}`);
    }
  });
  if (lines.length) {
    appendFileSync(join(DIR, `${new Date(t).toISOString().slice(0, 10)}.ndjson`), `${lines.join("\n")}\n`);
  }
  status.ticks += 1;
  status.rows += lines.length;
  status.lastTick = new Date(t).toISOString();
  if (status.ticks % 12 === 0 || once) writeStatus();
  return lines.length;
}

async function main() {
  const until = Date.now() + hours * 3600_000;
  log(`start hours=${hours} once=${once}`);
  const stop = () => {
    writeStatus({ stoppedAt: new Date().toISOString() });
    log("stop");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  for (;;) {
    const started = Date.now();
    try {
      const n = await tick();
      if (once) {
        console.log(`1틱 ${n}행`, JSON.stringify(status.byEx));
        stop();
      }
    } catch (e) {
      status.errors += 1;
      log(`tick ${String(e.message).slice(0, 160)}`);
    }
    if (Date.now() >= until) stop();
    const wait = INTERVAL_MS - (Date.now() - started);
    if (wait > 0) await sleep(wait);
  }
}

main();
