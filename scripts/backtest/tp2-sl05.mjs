/**
 * BTC 목표 +2% / 손절 -0.5% (손익비 1:4) 가능영역 검토 — 1H·4H, 최근 180일.
 *
 * 원장(run.mjs)과 같은 데이터·지표·신호 5기준을 쓰되 청산만 고정 % 구조로 바꾼다.
 * 추가로 "무조건 진입" 기준선을 같이 계산한다 — 신호가 기준선보다 나은지가 판정의 핵심.
 *
 * 사용: node scripts/backtest/tp2-sl05.mjs [출력.json]
 *   → 기본 출력: docs/backtest/<KST 오늘>-tp2-sl05.json
 *   → 리포트: tp2-sl05-template.html 의 __DATA_JSON__/__DATA_PATH__ 에 JSON을 심어
 *     docs/backtest/tp2-sl05-report.html 로 만든다.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://www.okx.com/api/v5";
const INST = "BTC-USDT-SWAP";
const DAYS = 180;
const BAR_MS = { "1H": 3600_000, "4H": 4 * 3600_000 };
const PAGE = 100;

const TP_PCT = 2.0;
const SL_PCT = 0.5;
const MAX_HOLD = 48; // 봉 수 — 1H는 2일, 4H는 8일
const FEE_PCT = 0.1;

/* ---------- 데이터 수집 ---------- */

async function fetchPage(bar, after) {
  const url = `${BASE}/market/history-candles?instId=${INST}&bar=${bar}&after=${after}&limit=${PAGE}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`OKX ${res.status}`);
  const json = await res.json();
  if (json.code !== "0") throw new Error(`OKX: ${json.msg || json.code}`);
  return json.data;
}

async function fetchCandles(bar) {
  const ms = BAR_MS[bar];
  const to = Math.floor(Date.now() / ms) * ms; // 진행 중인 봉 제외
  const from = to - DAYS * 24 * 3600_000;
  const span = ms * PAGE;
  const pages = Math.ceil((to - from) / span);
  const cursors = Array.from({ length: pages }, (_, i) => to - i * span);

  const out = new Map();
  for (let i = 0; i < cursors.length; i += 8) {
    const batch = await Promise.all(cursors.slice(i, i + 8).map((c) => fetchPage(bar, c)));
    for (const rows of batch) {
      for (const row of rows) {
        const t = Number(row[0]);
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
    if (i + 8 < cursors.length) await new Promise((r) => setTimeout(r, 1100));
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/* ---------- 지표 — 원장과 동일 (Wilder) ---------- */

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) gain += ch;
    else loss -= ch;
  }
  gain /= period;
  loss /= period;
  const toRsi = (g, l) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[period] = toRsi(gain, loss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const ch = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(ch, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = toRsi(gain, loss);
  }
  return out;
}

function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = (i) =>
    Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c),
    );
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr(i);
  let value = sum / period;
  out[period] = value;
  for (let i = period + 1; i < candles.length; i += 1) {
    value = (value * (period - 1) + tr(i)) / period;
    out[i] = value;
  }
  return out;
}

function volMA(candles, n = 20) {
  const out = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    if (i >= n) out[i] = sum / n;
    sum += candles[i].v;
    if (i >= n) sum -= candles[i - n].v;
  }
  return out;
}

/* ---------- 신호 5기준 — 원장과 동일 ---------- */

const STRATEGIES = [
  {
    key: "rsi-oversold-bounce",
    name: "① RSI 과매도 반등",
    side: "long",
    rule: "RSI(14)가 30 아래로 갔다가 30 위로 복귀 마감",
    signal: (i, ctx) =>
      ctx.rsi[i - 1] !== null && ctx.rsi[i - 1] < 30 && ctx.rsi[i] !== null && ctx.rsi[i] >= 30,
  },
  {
    key: "rsi-overbought-fade",
    name: "② RSI 과매수 반락",
    side: "short",
    rule: "RSI(14)가 70 위로 갔다가 70 아래로 복귀 마감",
    signal: (i, ctx) =>
      ctx.rsi[i - 1] !== null && ctx.rsi[i - 1] > 70 && ctx.rsi[i] !== null && ctx.rsi[i] <= 70,
  },
  {
    key: "rsi-50-volume",
    name: "③ RSI 50 돌파 + 거래량 확장",
    side: "long",
    rule: "RSI(14)가 50 상향 돌파 마감, 거래량 ≥ 직전 20봉 평균의 1.5배",
    signal: (i, ctx) =>
      ctx.rsi[i - 1] !== null &&
      ctx.rsi[i - 1] < 50 &&
      ctx.rsi[i] !== null &&
      ctx.rsi[i] >= 50 &&
      ctx.volMA[i] !== null &&
      ctx.candles[i].v >= 1.5 * ctx.volMA[i],
  },
  {
    key: "volume-spike-breakout",
    name: "④ 거래량 스파이크 장대양봉",
    side: "long",
    rule: "거래량 ≥ 직전 20봉 평균의 2배, 몸통 ≥ 봉 범위의 60%인 양봉, 종가가 직전 봉 고가 위",
    signal: (i, ctx) => {
      const c = ctx.candles[i];
      const range = c.h - c.l;
      return (
        ctx.volMA[i] !== null &&
        c.v >= 2 * ctx.volMA[i] &&
        c.c > c.o &&
        range > 0 &&
        (c.c - c.o) / range >= 0.6 &&
        c.c > ctx.candles[i - 1].h
      );
    },
  },
  {
    key: "rsi-bull-divergence",
    name: "⑤ RSI 상승 다이버전스",
    side: "long",
    rule: "가격은 신저점인데 RSI 저점은 높아짐(피벗 좌우 3봉, 간격 5~40봉, 이전 피벗 RSI < 40)",
    signal: (i, ctx) => ctx.divergenceAt.has(i),
  },
];

function findDivergences(candles, rsiArr) {
  const W = 3;
  const at = new Map();
  const pivots = [];
  for (let p = W; p < candles.length - W; p += 1) {
    let ok = true;
    for (let k = 1; k <= W; k += 1) {
      if (candles[p].l >= candles[p - k].l || candles[p].l >= candles[p + k].l) ok = false;
    }
    if (!ok || rsiArr[p] === null) continue;
    const prev = pivots.findLast(
      (q) => p - q.p >= 5 && p - q.p <= 40 && candles[p].l < candles[q.p].l && rsiArr[p] > rsiArr[q.p] && rsiArr[q.p] < 40,
    );
    pivots.push({ p });
    if (prev) at.set(p + W, { from: prev.p, to: p });
  }
  return at;
}

/* ---------- 체결 — 진입 i+1 시가, 목표 +2% / 손절 -0.5% 고정 ---------- */

function walkExit(candles, entryIdx, entry, side) {
  const dir = side === "long" ? 1 : -1;
  const stop = entry * (1 - dir * SL_PCT / 100);
  const target = entry * (1 + dir * TP_PCT / 100);

  let exitIdx = Math.min(entryIdx + MAX_HOLD - 1, candles.length - 1);
  let exitPrice = candles[exitIdx].c;
  let exitType = "time";
  for (let j = entryIdx; j <= exitIdx; j += 1) {
    const bar = candles[j];
    const hitSl = dir === 1 ? bar.l <= stop : bar.h >= stop;
    const hitTp = dir === 1 ? bar.h >= target : bar.l <= target;
    // 같은 봉에서 둘 다 걸리면 손절로 본다 — 봉 내부 경로를 모르니 보수적으로.
    if (hitSl) {
      exitIdx = j;
      exitPrice = stop;
      exitType = "sl";
      break;
    }
    if (hitTp) {
      exitIdx = j;
      exitPrice = target;
      exitType = "tp";
      break;
    }
  }
  // 데이터 끝에 걸려 보유 시한을 못 채운 거래는 아직 열려 있는 것이다.
  if (exitType === "time" && exitIdx === candles.length - 1 && exitIdx - entryIdx + 1 < MAX_HOLD) {
    exitType = "open";
  }
  const pnl = ((exitPrice - entry) / entry) * dir * 100 - FEE_PCT;
  return { exitIdx, exitPrice, exitType, stop, target, pnl: Math.round(pnl * 1000) / 1000 };
}

function simulate(bar, candles, ctx) {
  const trades = [];
  const openUntil = {};
  for (let i = 21; i < candles.length - 1; i += 1) {
    for (const s of STRATEGIES) {
      if (openUntil[s.key] !== undefined && i < openUntil[s.key]) continue;
      if (!s.signal(i, ctx)) continue;
      const entryIdx = i + 1;
      const entry = candles[entryIdx].o;
      const x = walkExit(candles, entryIdx, entry, s.side);
      trades.push({
        bar,
        strategy: s.key,
        side: s.side,
        signalIdx: i,
        entryIdx,
        exitIdx: x.exitIdx,
        entryAt: candles[entryIdx].t,
        exitAt: candles[x.exitIdx].t,
        entry,
        exit: x.exitPrice,
        stop: x.stop,
        target: x.target,
        exitType: x.exitType,
        holdBars: x.exitIdx - entryIdx + 1,
        pnl: x.pnl,
        rsiAtSignal: Math.round(ctx.rsi[i] * 10) / 10,
        volRatio: ctx.volMA[i] ? Math.round((candles[i].v / ctx.volMA[i]) * 100) / 100 : null,
      });
      // 청산 봉의 마감에는 이미 포지션이 없다 — 그 봉의 신호는 다음 봉 진입으로 유효하다.
      openUntil[s.key] = x.exitIdx;
    }
  }
  return trades.sort((a, b) => a.entryAt - b.entryAt);
}

/**
 * 기준선 — 매 봉 무조건 진입하면 +2%가 -0.5%보다 먼저 올 확률.
 *
 * 신호의 값어치는 이 기준선을 얼마나 웃도느냐다. 겹침 무시(매 봉 독립 시행)라
 * 거래 시뮬레이션이 아니라 도달 확률의 추정치다.
 */
function baseline(candles, side) {
  let tp = 0, sl = 0, time = 0, timePnl = 0, n = 0;
  for (let i = 21; i < candles.length - 1; i += 1) {
    const entryIdx = i + 1;
    const x = walkExit(candles, entryIdx, candles[entryIdx].o, side);
    if (x.exitType === "open") continue;
    n += 1;
    if (x.exitType === "tp") tp += 1;
    else if (x.exitType === "sl") sl += 1;
    else { time += 1; timePnl += x.pnl; }
  }
  const r = (x) => Math.round(x * 1000) / 1000;
  const winPnl = TP_PCT - FEE_PCT;
  const losePnl = -SL_PCT - FEE_PCT;
  const avgTimePnl = time ? timePnl / time : 0;
  return {
    n,
    tpRate: r((tp / n) * 100),
    slRate: r((sl / n) * 100),
    timeRate: r((time / n) * 100),
    avgTimePnl: r(avgTimePnl),
    expectancy: r((tp * winPnl + sl * losePnl + timePnl) / n),
  };
}

/* ---------- 통계 — 청산 시각순 ---------- */

function stats(allTrades) {
  const trades = allTrades
    .filter((t) => t.exitType !== "open")
    .slice()
    .sort((a, b) => a.exitAt - b.exitAt || a.entryAt - b.entryAt);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.pnl, 0);
  const timeTrades = trades.filter((t) => t.exitType === "time");

  let peak = 0, equity = 0, mdd = 0, streak = 0, maxWinStreak = 0, maxLossStreak = 0;
  const curve = [];
  for (const t of trades) {
    equity += t.pnl;
    curve.push({ at: t.exitAt, equity: Math.round(equity * 1000) / 1000 });
    peak = Math.max(peak, equity);
    mdd = Math.min(mdd, equity - peak);
    streak = t.pnl > 0 ? Math.max(streak, 0) + 1 : Math.min(streak, 0) - 1;
    maxWinStreak = Math.max(maxWinStreak, streak);
    maxLossStreak = Math.max(maxLossStreak, -streak);
  }

  const r = (x) => Math.round(x * 1000) / 1000;
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? r((wins.length / trades.length) * 100) : null,
    totalPnl: r(equity),
    grossProfit: r(grossProfit),
    grossLoss: r(grossLoss),
    profitFactor: grossLoss !== 0 ? r(grossProfit / -grossLoss) : null,
    avgPnl: trades.length ? r(equity / trades.length) : null,
    avgHoldBars: trades.length ? r(trades.reduce((s, t) => s + t.holdBars, 0) / trades.length) : null,
    maxWinStreak,
    maxLossStreak,
    mdd: r(mdd),
    exits: {
      tp: trades.filter((t) => t.exitType === "tp").length,
      sl: trades.filter((t) => t.exitType === "sl").length,
      time: timeTrades.length,
    },
    avgTimePnl: timeTrades.length ? r(timeTrades.reduce((s, t) => s + t.pnl, 0) / timeTrades.length) : null,
    curve,
  };
}

/* ---------- 실행 ---------- */

const result = {
  meta: {
    generatedAt: Date.now(),
    symbol: INST,
    days: DAYS,
    tp: TP_PCT,
    sl: SL_PCT,
    maxHold: MAX_HOLD,
    fee: FEE_PCT,
    breakEvenWinRate: Math.round(((SL_PCT + FEE_PCT) / (TP_PCT + SL_PCT)) * 1000) / 10,
    rules: {
      entry: "신호 봉 마감 → 다음 봉 시가 진입",
      stop: `진입가 ∓ ${SL_PCT}% 고정`,
      target: `진입가 ± ${TP_PCT}% 고정 (손익비 1:${TP_PCT / SL_PCT})`,
      maxHold: `${MAX_HOLD}봉째 마감에 청산 (1H=2일, 4H=8일)`,
      fee: `왕복 ${FEE_PCT}% (수수료+슬리피지)`,
      conflict: "같은 봉에서 목표·손절 동시 도달 시 손절로 집계(보수적)",
    },
  },
  strategies: STRATEGIES.map(({ key, name, side, rule }) => ({ key, name, side, rule })),
  frames: {},
  trades: [],
};

for (const bar of ["1H", "4H"]) {
  const candles = await fetchCandles(bar);
  console.log(`${bar}: 캔들 ${candles.length}개 (${new Date(candles[0].t).toISOString().slice(0, 10)} ~)`);
  const ctx = {
    candles,
    rsi: rsi(candles.map((c) => c.c)),
    atr: atr(candles),
    volMA: volMA(candles),
  };
  ctx.divergenceAt = findDivergences(candles, ctx.rsi);

  const trades = simulate(bar, candles, ctx);
  result.trades.push(...trades);

  const last = candles.length - 1;
  result.frames[bar] = {
    candles: candles.length,
    from: candles[0].t,
    to: candles[last].t,
    atrPct: Math.round((ctx.atr[last] / candles[last].c) * 100 * 1000) / 1000,
    baseline: { long: baseline(candles, "long"), short: baseline(candles, "short") },
    perStrategy: Object.fromEntries(
      STRATEGIES.map((s) => [s.key, stats(trades.filter((t) => t.strategy === s.key))]),
    ),
    overall: stats(trades),
    snapshot: {
      at: candles[last].t,
      close: candles[last].c,
      rsi: Math.round(ctx.rsi[last] * 10) / 10,
      volRatio: ctx.volMA[last] ? Math.round((candles[last].v / ctx.volMA[last]) * 100) / 100 : null,
      signals: Object.fromEntries(STRATEGIES.map((s) => [s.key, !!s.signal(last, ctx)])),
    },
  };
}

result.combined = stats(result.trades);

const kstDay = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = process.argv[2] ?? join(repoRoot, "docs", "backtest", `${kstDay}-tp2-sl05.json`);
writeFileSync(out, JSON.stringify(result));

for (const bar of ["1H", "4H"]) {
  const f = result.frames[bar];
  console.log(`\n[${bar}] ATR ${f.atrPct}% · 기준선(롱) TP ${f.baseline.long.tpRate}% / SL ${f.baseline.long.slRate}% / 기대값 ${f.baseline.long.expectancy}%`);
  for (const s of STRATEGIES) {
    const p = f.perStrategy[s.key];
    console.log(`  ${s.name}: ${p.trades}건 승률 ${p.winRate}% 기대값 ${p.avgPnl}% (tp ${p.exits.tp}/sl ${p.exits.sl}/time ${p.exits.time})`);
  }
  console.log(`  종합: ${f.overall.trades}건 승률 ${f.overall.winRate}% 총손익 ${f.overall.totalPnl}%p`);
}
console.log(`\n표본 합계(완결): ${result.combined.trades}건 · 손익분기 승률 ${result.meta.breakEvenWinRate}%`);
console.log(`저장: ${out}`);
