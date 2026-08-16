/**
 * BTC 스윙 기준 전수 탐색 — 신호 11종 × 청산 6종 × 봉 2종(4H·1D), 720일.
 *
 * "안정적·장기적"을 게이트로 건다: 기간을 3등분해 2구간 이상 기대값 플러스,
 * 표본 20건 이상, P/F 1.1 이상을 통과한 조합만 후보. 신호·봉별 최적 청산
 * 하나씩만 남겨 다중검정으로 인한 뻥튀기를 줄인다.
 *
 * 사용: node scripts/backtest/swing-grid.mjs [출력.json]
 *   → 기본 출력: docs/backtest/<KST 오늘>-swing-grid.json
 *   → 리포트: swing-grid-template.html 의 __DATA_JSON__/__DATA_PATH__ 에 JSON을 심어
 *     docs/backtest/swing-top10-report.html 로 만든다.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://www.okx.com/api/v5";
const INST = "BTC-USDT-SWAP";
const DAYS = 720;
const PAGE = 100;
const FEE_PCT = 0.1;
const WARMUP = 200; // SMA200이 서는 자리부터 — 모든 신호가 같은 출발선을 쓴다.

/** 스윙 보유 시한 — 4H는 열흘, 1D는 스무 날. */
const TFS = {
  "4H": { ms: 4 * 3600_000, maxHold: 60 },
  "1D": { ms: 24 * 3600_000, maxHold: 20 },
};

const EXITS = [
  { key: "atr-2-2", name: "ATR 손절2×·목표2×", rr: 1, type: "atr", sl: 2, tp: 2 },
  { key: "atr-1.5-2.25", name: "ATR 손절1.5×·목표2.25×", rr: 1.5, type: "atr", sl: 1.5, tp: 2.25 },
  { key: "atr-2-4", name: "ATR 손절2×·목표4×", rr: 2, type: "atr", sl: 2, tp: 4 },
  { key: "atr-1-3", name: "ATR 손절1×·목표3×", rr: 3, type: "atr", sl: 1, tp: 3 },
  { key: "pct-1-2", name: "고정 손절1%·목표2%", rr: 2, type: "pct", sl: 1, tp: 2 },
  { key: "pct-2-4", name: "고정 손절2%·목표4%", rr: 2, type: "pct", sl: 2, tp: 4 },
];

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
  const ms = TFS[bar].ms;
  const to = Math.floor(Date.now() / ms) * ms;
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

/* ---------- 지표 — 원장과 같은 Wilder 계산 + 이동평균·돌파선 ---------- */

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

function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** 직전 n봉(현재 봉 제외)의 최고가·최저가 — 돌파 판정용. */
function rolling(candles, n, pick, cmp) {
  const out = new Array(candles.length).fill(null);
  for (let i = n; i < candles.length; i += 1) {
    let best = pick(candles[i - n]);
    for (let k = i - n + 1; k < i; k += 1) {
      const v = pick(candles[k]);
      if (cmp(v, best)) best = v;
    }
    out[i] = best;
  }
  return out;
}

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

/* ---------- 신호 11종 — 관점을 나눠 담는다 ---------- */

const SIGNALS = [
  {
    key: "rsi-oversold-bounce",
    name: "RSI 과매도 반등",
    side: "long",
    view: "평균회귀",
    rule: "RSI(14)가 30 아래로 갔다가 30 위로 복귀 마감",
    signal: (i, c) => c.rsi[i - 1] < 30 && c.rsi[i] >= 30,
  },
  {
    key: "rsi-oversold-uptrend",
    name: "RSI 과매도 반등 + 상승장 필터",
    side: "long",
    view: "평균회귀+추세필터",
    rule: "RSI 30 복귀 마감, 단 종가가 SMA200 위일 때만",
    signal: (i, c) => c.rsi[i - 1] < 30 && c.rsi[i] >= 30 && c.candles[i].c > c.sma200[i],
  },
  {
    key: "rsi-50-volume",
    name: "RSI 50 돌파 + 거래량 확장",
    side: "long",
    view: "모멘텀+거래량",
    rule: "RSI(14)가 50 상향 돌파 마감, 거래량 ≥ 직전 20봉 평균의 1.5배",
    signal: (i, c) => c.rsi[i - 1] < 50 && c.rsi[i] >= 50 && c.candles[i].v >= 1.5 * c.volMA[i],
  },
  {
    key: "volume-spike-breakout",
    name: "거래량 스파이크 장대양봉",
    side: "long",
    view: "모멘텀+캔들",
    rule: "거래량 ≥ 2배, 몸통 ≥ 봉 범위 60%인 양봉, 종가가 직전 봉 고가 위",
    signal: (i, c) => {
      const b = c.candles[i];
      const range = b.h - b.l;
      return c.candles[i].v >= 2 * c.volMA[i] && b.c > b.o && range > 0 &&
        (b.c - b.o) / range >= 0.6 && b.c > c.candles[i - 1].h;
    },
  },
  {
    key: "rsi-bull-divergence",
    name: "RSI 상승 다이버전스",
    side: "long",
    view: "패턴",
    rule: "가격 신저점·RSI 저점 상승(피벗 좌우 3봉, 간격 5~40봉, 이전 피벗 RSI < 40)",
    signal: (i, c) => c.divergenceAt.has(i),
  },
  {
    key: "donchian-breakout",
    name: "20봉 신고가 돌파",
    side: "long",
    view: "추세추종",
    rule: "종가가 직전 20봉 최고가 위로 마감",
    signal: (i, c) => c.candles[i].c > c.hh20[i],
  },
  {
    key: "ma-pullback",
    name: "상승 추세 눌림목",
    side: "long",
    view: "추세+눌림",
    rule: "SMA20>SMA50, 종가>SMA200인 추세에서 저가가 SMA20을 건드리고 종가는 위로 마감",
    signal: (i, c) =>
      c.sma20[i] > c.sma50[i] && c.candles[i].c > c.sma200[i] &&
      c.candles[i].l <= c.sma20[i] && c.candles[i].c > c.sma20[i],
  },
  {
    key: "golden-cross",
    name: "골든크로스 (SMA20↗SMA50)",
    side: "long",
    view: "추세추종",
    rule: "SMA20이 SMA50을 상향 돌파 마감",
    signal: (i, c) => c.sma20[i - 1] <= c.sma50[i - 1] && c.sma20[i] > c.sma50[i],
  },
  {
    key: "rsi-overbought-fade",
    name: "RSI 과매수 반락 (숏)",
    side: "short",
    view: "평균회귀",
    rule: "RSI(14)가 70 위로 갔다가 70 아래로 복귀 마감",
    signal: (i, c) => c.rsi[i - 1] > 70 && c.rsi[i] <= 70,
  },
  {
    key: "rsi-overbought-downtrend",
    name: "RSI 과매수 반락 + 하락장 필터 (숏)",
    side: "short",
    view: "평균회귀+추세필터",
    rule: "RSI 70 반락 마감, 단 종가가 SMA200 아래일 때만",
    signal: (i, c) => c.rsi[i - 1] > 70 && c.rsi[i] <= 70 && c.candles[i].c < c.sma200[i],
  },
  {
    key: "donchian-breakdown",
    name: "20봉 신저가 이탈 (숏)",
    side: "short",
    view: "추세추종",
    rule: "종가가 직전 20봉 최저가 아래로 마감",
    signal: (i, c) => c.candles[i].c < c.ll20[i],
  },
];

/* ---------- 체결 ---------- */

function walkExit(candles, entryIdx, entry, side, exit, atrAtSignal, maxHold) {
  const dir = side === "long" ? 1 : -1;
  const slDist = exit.type === "atr" ? exit.sl * atrAtSignal : entry * exit.sl / 100;
  const tpDist = exit.type === "atr" ? exit.tp * atrAtSignal : entry * exit.tp / 100;
  const stop = entry - dir * slDist;
  const target = entry + dir * tpDist;

  let exitIdx = Math.min(entryIdx + maxHold - 1, candles.length - 1);
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
  if (exitType === "time" && exitIdx === candles.length - 1 && exitIdx - entryIdx + 1 < maxHold) {
    exitType = "open";
  }
  const pnl = ((exitPrice - entry) / entry) * dir * 100 - FEE_PCT;
  return { exitIdx, exitPrice, exitType, stop, target, pnl: Math.round(pnl * 1000) / 1000 };
}

function simulate(candles, ctx, signal, exit, maxHold) {
  const trades = [];
  let openUntil = -1;
  for (const i of ctx.signalIdx[signal.key]) {
    if (i < openUntil || i >= candles.length - 1) continue;
    const entryIdx = i + 1;
    const entry = candles[entryIdx].o;
    const x = walkExit(candles, entryIdx, entry, signal.side, exit, ctx.atr[i], maxHold);
    trades.push({
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
    });
    openUntil = x.exitIdx;
  }
  return trades;
}

/* ---------- 통계 — 청산 시각순 + 3구간 강건성 ---------- */

function stats(allTrades, periodEdges) {
  const trades = allTrades
    .filter((t) => t.exitType !== "open")
    .slice()
    .sort((a, b) => a.exitAt - b.exitAt || a.entryAt - b.entryAt);
  const wins = trades.filter((t) => t.pnl > 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);

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

  const n = trades.length;
  const mean = n ? equity / n : 0;
  const sd = n > 1 ? Math.sqrt(trades.reduce((s, t) => s + (t.pnl - mean) ** 2, 0) / (n - 1)) : 0;
  const tstat = n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;

  // 진입 시각으로 3구간에 배정 — 구간마다 기대값이 플러스인지 본다.
  const periods = periodEdges.slice(0, -1).map((from, k) => {
    const to = periodEdges[k + 1];
    const ts = trades.filter((t) => t.entryAt >= from && t.entryAt < to);
    const sum = ts.reduce((s, t) => s + t.pnl, 0);
    return {
      n: ts.length,
      pnl: Math.round(sum * 1000) / 1000,
      avg: ts.length ? Math.round((sum / ts.length) * 1000) / 1000 : null,
    };
  });
  const positivePeriods = periods.filter((p) => p.n > 0 && p.pnl > 0).length;

  const r = (x) => Math.round(x * 1000) / 1000;
  return {
    trades: n,
    wins: wins.length,
    winRate: n ? r((wins.length / n) * 100) : null,
    totalPnl: r(equity),
    profitFactor: grossLoss !== 0 ? r(grossProfit / -grossLoss) : null,
    avgPnl: n ? r(mean) : null,
    sd: r(sd),
    tstat: r(tstat),
    avgHoldBars: n ? r(trades.reduce((s, t) => s + t.holdBars, 0) / n) : null,
    maxWinStreak,
    maxLossStreak,
    mdd: r(mdd),
    exits: {
      tp: trades.filter((t) => t.exitType === "tp").length,
      sl: trades.filter((t) => t.exitType === "sl").length,
      time: trades.filter((t) => t.exitType === "time").length,
    },
    periods,
    positivePeriods,
    curve,
  };
}

/** 후보 게이트 — 표본·손익비·구간 일관성. 셋 다 통과해야 추천 후보다. */
function eligible(st) {
  // profitFactor가 null이면 손실이 0이라는 뜻 — 무한대로 취급해 통과시킨다.
  return st.trades >= 20 && st.avgPnl > 0 && (st.profitFactor ?? Infinity) >= 1.1 && st.positivePeriods >= 2;
}

/* ---------- 실행 ---------- */

const result = {
  meta: {
    generatedAt: Date.now(),
    symbol: INST,
    days: DAYS,
    fee: FEE_PCT,
    warmup: WARMUP,
    gates: "표본 ≥ 20 · 기대값 > 0 · P/F ≥ 1.1 · 3구간 중 2구간 이상 플러스",
    combosTested: SIGNALS.length * EXITS.length * Object.keys(TFS).length,
    rules: {
      entry: "신호 봉 마감 → 다음 봉 시가 진입",
      maxHold: "4H는 60봉(10일), 1D는 20봉(20일)째 마감에 청산",
      fee: `왕복 ${FEE_PCT}% (수수료+슬리피지)`,
      conflict: "같은 봉에서 목표·손절 동시 도달 시 손절로 집계(보수적)",
      lock: "같은 조합이 보유 중이면 새 신호 무시",
    },
  },
  signals: SIGNALS.map(({ key, name, side, view, rule }) => ({ key, name, side, view, rule })),
  exits: EXITS,
  frames: {},
  combos: [],
};

for (const tf of Object.keys(TFS)) {
  const candles = await fetchCandles(tf);
  const closes = candles.map((c) => c.c);
  const ctx = {
    candles,
    rsi: rsi(closes),
    atr: atr(candles),
    volMA: volMA(candles),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    hh20: rolling(candles, 20, (c) => c.h, (a, b) => a > b),
    ll20: rolling(candles, 20, (c) => c.l, (a, b) => a < b),
  };
  ctx.divergenceAt = findDivergences(candles, ctx.rsi);

  // 신호 발생 봉을 먼저 모은다 — 청산 6종이 같은 신호 목록을 공유한다.
  ctx.signalIdx = {};
  for (const s of SIGNALS) {
    const idx = [];
    for (let i = WARMUP; i < candles.length - 1; i += 1) {
      if (s.signal(i, ctx)) idx.push(i);
    }
    ctx.signalIdx[s.key] = idx;
  }

  // 3구간 — 워밍업 이후 구간을 시간으로 3등분한다.
  const t0 = candles[WARMUP].t;
  const t1 = candles[candles.length - 1].t;
  const periodEdges = [t0, t0 + (t1 - t0) / 3, t0 + (2 * (t1 - t0)) / 3, t1 + 1];

  const last = candles.length - 1;
  result.frames[tf] = {
    candles: candles.length,
    from: candles[0].t,
    warmupFrom: t0,
    to: candles[last].t,
    atrPct: Math.round((ctx.atr[last] / candles[last].c) * 100 * 1000) / 1000,
    periodEdges: periodEdges.slice(0, 3).concat(t1),
    // 같은 3구간의 BTC 등락 — 국면 맥락.
    periodReturns: periodEdges.slice(0, -1).map((from, k) => {
      const to = periodEdges[k + 1];
      const inRange = candles.filter((c) => c.t >= from && c.t < to);
      const a = inRange[0]?.c, b = inRange[inRange.length - 1]?.c;
      return a && b ? Math.round(((b - a) / a) * 100 * 10) / 10 : null;
    }),
    signalCounts: Object.fromEntries(SIGNALS.map((s) => [s.key, ctx.signalIdx[s.key].length])),
  };

  for (const s of SIGNALS) {
    for (const exit of EXITS) {
      const trades = simulate(candles, ctx, s, exit, TFS[tf].maxHold);
      const st = stats(trades, periodEdges);
      result.combos.push({
        tf,
        signal: s.key,
        exit: exit.key,
        eligible: eligible(st),
        stats: st,
        trades, // top10 이외에는 저장 직전에 지운다 — 파일 크기 때문.
      });
    }
  }
}

/* ---------- 추천 — 신호·봉별 최적 청산 하나씩, t-stat 순 ---------- */

const groups = new Map();
for (const c of result.combos) {
  const g = `${c.tf}|${c.signal}`;
  const cur = groups.get(g);
  // 게이트 통과가 우선, 그 안에서 t-stat이 높은 청산을 그 신호의 대표로 삼는다.
  const better =
    !cur ||
    (c.eligible && !cur.eligible) ||
    (c.eligible === cur.eligible && c.stats.tstat > cur.stats.tstat);
  if (better) groups.set(g, c);
}
const ranked = [...groups.values()].sort(
  (a, b) => (b.eligible ? 1 : 0) - (a.eligible ? 1 : 0) || b.stats.tstat - a.stats.tstat,
);
result.top10 = ranked.slice(0, 10).map((c) => ({ tf: c.tf, signal: c.signal, exit: c.exit }));
result.groupBest = ranked.map((c) => ({ tf: c.tf, signal: c.signal, exit: c.exit, eligible: c.eligible }));

// 파일 크기 관리 — 추천 10개만 거래 내역·곡선을 남긴다.
const keep = new Set(result.top10.map((t) => `${t.tf}|${t.signal}|${t.exit}`));
for (const c of result.combos) {
  if (!keep.has(`${c.tf}|${c.signal}|${c.exit}`)) {
    delete c.trades;
    delete c.stats.curve;
  }
}

const kstDay = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = process.argv[2] ?? join(repoRoot, "docs", "backtest", `${kstDay}-swing-grid.json`);
writeFileSync(out, JSON.stringify(result));

console.log(`조합 ${result.combos.length}개 · 게이트 통과 ${result.combos.filter((c) => c.eligible).length}개`);
for (const [i, t] of result.top10.entries()) {
  const c = result.combos.find((c) => c.tf === t.tf && c.signal === t.signal && c.exit === t.exit);
  const s = c.stats;
  console.log(
    `${String(i + 1).padStart(2)}. [${t.tf}] ${SIGNALS.find((x) => x.key === t.signal).name} × ${EXITS.find((x) => x.key === t.exit).name}` +
    ` — ${s.trades}건 승률 ${s.winRate}% 기대값 ${s.avgPnl}% t=${s.tstat} PF ${s.profitFactor} 구간 ${s.positivePeriods}/3 ${c.eligible ? "" : "(게이트 미달)"}`,
  );
}
console.log(`저장: ${out}`);
