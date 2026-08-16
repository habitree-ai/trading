/**
 * BTC-USDT-SWAP 1H 백테스트 — RSI/거래량/캔들 5가지 기준.
 *
 * 앱과 같은 데이터 소스(OKX 공개 API), 같은 RSI 계산식(Wilder)을 쓴다.
 * 결과는 JSON으로 남겨 리포트(HTML)가 그대로 읽는다.
 *
 * 사용: node scripts/backtest/run.mjs [출력.json]
 *   → 기본 출력: docs/backtest/<KST 오늘>-btc-1h.json (회차 누적)
 *   → 이어서 node scripts/backtest/build.mjs 로 리포트를 다시 만든다.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://www.okx.com/api/v5";
const INST = "BTC-USDT-SWAP";
const BAR = "1H";
const BAR_MS = 60 * 60 * 1000;
const PAGE = 100;
const DAYS = 180;

/* ---------- 데이터 수집 ---------- */

async function fetchPage(after) {
  const url = `${BASE}/market/history-candles?instId=${INST}&bar=${BAR}&after=${after}&limit=${PAGE}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`OKX ${res.status}`);
  const json = await res.json();
  if (json.code !== "0") throw new Error(`OKX: ${json.msg || json.code}`);
  return json.data;
}

async function fetchCandles() {
  const to = Math.floor(Date.now() / BAR_MS) * BAR_MS; // 진행 중인 봉 제외
  const from = to - DAYS * 24 * BAR_MS;
  const span = BAR_MS * PAGE;
  const pages = Math.ceil((to - from) / span);
  const cursors = Array.from({ length: pages }, (_, i) => to - i * span);

  const out = new Map();
  for (let i = 0; i < cursors.length; i += 8) {
    const batch = await Promise.all(cursors.slice(i, i + 8).map(fetchPage));
    for (const rows of batch) {
      for (const row of rows) {
        const t = Number(row[0]);
        if (t >= from && t < to && row[8] === "1") { // confirm=1: 마감된 봉만
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

/* ---------- 지표 — src/lib/indicators.ts 와 같은 식 ---------- */

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

/** ATR(14) — Wilder. 손절·목표 폭을 변동성에 맞춘다. */
function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = (i) =>
    i === 0
      ? candles[0].h - candles[0].l
      : Math.max(
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

/** 직전 n봉 거래량 평균 — 자기 봉은 빼야 스파이크가 자기 평균을 끌어올리지 않는다. */
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

/* ---------- 신호 — 판정은 봉 마감(i), 진입은 다음 봉(i+1) 시가 ---------- */

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

/** 피벗 저점: low[p]가 좌우 3봉보다 낮다. p+3 봉이 마감돼야 확정된다(선견 없음). */
function findDivergences(candles, rsiArr) {
  const W = 3;
  const at = new Map(); // 확정 시점 i → 피벗 정보
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

/* ---------- 체결 시뮬레이션 ---------- */

const SL_ATR = 1.5;
const TP_ATR = 2.25;
const MAX_HOLD = 48;
const FEE_PCT = 0.1; // 왕복 taker 0.05%×2 — 슬리피지 겸함

function simulate(candles, ctx) {
  const trades = [];
  const openUntil = {}; // 전략별 보유 중이면 청산 봉 index — 그 전 신호는 무시

  for (let i = 21; i < candles.length - 1; i += 1) {
    for (const s of STRATEGIES) {
      if (ctx.atr[i] === null) continue;
      if (openUntil[s.key] !== undefined && i < openUntil[s.key]) continue;
      if (!s.signal(i, ctx)) continue;

      const entryIdx = i + 1;
      const entry = candles[entryIdx].o;
      const dir = s.side === "long" ? 1 : -1;
      const stop = entry - dir * SL_ATR * ctx.atr[i];
      const target = entry + dir * TP_ATR * ctx.atr[i];

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

      // 데이터 끝에 걸려 보유 시한을 못 채운 거래는 아직 열려 있는 것이다 — 완결로 세지 않는다.
      if (exitType === "time" && exitIdx === candles.length - 1 && exitIdx - entryIdx + 1 < MAX_HOLD) {
        exitType = "open";
      }

      const gross = ((exitPrice - entry) / entry) * dir * 100;
      const pnl = gross - FEE_PCT;
      trades.push({
        strategy: s.key,
        side: s.side,
        signalIdx: i,
        entryIdx,
        exitIdx,
        entryAt: candles[entryIdx].t,
        exitAt: candles[exitIdx].t,
        entry,
        exit: exitPrice,
        stop,
        target,
        exitType,
        holdBars: exitIdx - entryIdx + 1,
        pnl: Math.round(pnl * 1000) / 1000,
        rsiAtSignal: Math.round(ctx.rsi[i] * 10) / 10,
        volRatio: ctx.volMA[i] ? Math.round((candles[i].v / ctx.volMA[i]) * 100) / 100 : null,
      });
      // 청산 봉의 마감에는 이미 포지션이 없다 — 그 봉의 신호는 다음 봉 진입으로 유효하다.
      openUntil[s.key] = exitIdx;
    }
  }
  return trades.sort((a, b) => a.entryAt - b.entryAt);
}

/* ---------- 통계 — 참고 이미지(총손익·승률·P/F·MDD·연속손익)와 같은 항목 ---------- */

function stats(allTrades) {
  // 손익은 청산 시점에 실현된다 — 진입순으로 쌓으면 곡선·MDD·연속손익이 시간을 거스른다.
  const trades = allTrades
    .filter((t) => t.exitType !== "open")
    .slice()
    .sort((a, b) => a.exitAt - b.exitAt || a.entryAt - b.entryAt);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.pnl, 0);

  let peak = 0;
  let equity = 0;
  let mdd = 0;
  let streak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
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
      time: trades.filter((t) => t.exitType === "time").length,
    },
    curve,
  };
}

/* ---------- 실행 ---------- */

const candles = await fetchCandles();
console.log(`캔들 ${candles.length}개: ${new Date(candles[0].t).toISOString()} ~ ${new Date(candles.at(-1).t).toISOString()}`);

const ctx = {
  candles,
  rsi: rsi(candles.map((c) => c.c)),
  atr: atr(candles),
  volMA: volMA(candles),
};
ctx.divergenceAt = findDivergences(candles, ctx.rsi);

const trades = simulate(candles, ctx);
const perStrategy = Object.fromEntries(
  STRATEGIES.map((s) => [s.key, stats(trades.filter((t) => t.strategy === s.key))]),
);
const overall = stats(trades);

// 최근 10건 — 사례 카드용. 앞뒤 맥락 봉과 RSI를 함께 담아 미니 차트를 그린다.
const recent = trades.slice(-10).map((t) => {
  const from = Math.max(0, t.signalIdx - 20);
  const to = Math.min(candles.length - 1, t.exitIdx + 8);
  return {
    ...t,
    window: candles.slice(from, to + 1).map((c, k) => ({
      ...c,
      rsi: ctx.rsi[from + k] === null ? null : Math.round(ctx.rsi[from + k] * 10) / 10,
    })),
  };
});

// 현재 상태 — "지금 들어가도 되나"를 보는 자리. 마지막 마감 봉 기준.
const last = candles.length - 1;
const snapshot = {
  at: candles[last].t,
  close: candles[last].c,
  rsi: Math.round(ctx.rsi[last] * 10) / 10,
  prevRsi: Math.round(ctx.rsi[last - 1] * 10) / 10,
  volRatio: ctx.volMA[last] ? Math.round((candles[last].v / ctx.volMA[last]) * 100) / 100 : null,
  atr: Math.round(ctx.atr[last] * 10) / 10,
  signals: Object.fromEntries(STRATEGIES.map((s) => [s.key, !!s.signal(last, ctx)])),
};

const result = {
  meta: {
    generatedAt: Date.now(),
    symbol: INST,
    bar: BAR,
    days: DAYS,
    candles: candles.length,
    from: candles[0].t,
    to: candles[last].t,
    rules: {
      entry: "신호 봉 마감 → 다음 봉 시가 진입",
      stop: `진입가 ∓ ${SL_ATR}×ATR(14)`,
      target: `진입가 ± ${TP_ATR}×ATR(14) (손익비 1:1.5)`,
      maxHold: `${MAX_HOLD}봉(48시간) 초과 시 종가 청산`,
      fee: `왕복 ${FEE_PCT}% (수수료+슬리피지)`,
      conflict: "같은 봉에서 목표·손절 동시 도달 시 손절로 집계(보수적)",
    },
  },
  strategies: STRATEGIES.map(({ key, name, side, rule }) => ({ key, name, side, rule })),
  perStrategy,
  overall,
  trades,
  recent,
  snapshot,
  // 벤치마크 — 같은 기간 그냥 들고 있었으면. 참고 이미지의 '선물지수' 자리.
  benchmark: candles.filter((_, i) => i % 6 === 0).map((c) => ({ at: c.t, close: c.c })),
};

// 회차 파일명은 KST 날짜다 — 같은 날 다시 돌리면 그날 회차를 덮어쓴다.
const kstDay = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = process.argv[2] ?? join(repoRoot, "docs", "backtest", `${kstDay}-btc-1h.json`);
writeFileSync(out, JSON.stringify(result));
console.log(`전략별 거래 수: ${STRATEGIES.map((s) => `${s.name} ${perStrategy[s.key].trades}`).join(" · ")}`);
console.log(`종합: ${overall.trades}건, 승률 ${overall.winRate}%, 총손익 ${overall.totalPnl}%p, P/F ${overall.profitFactor}, MDD ${overall.mdd}%p`);
console.log(`저장: ${out}`);
