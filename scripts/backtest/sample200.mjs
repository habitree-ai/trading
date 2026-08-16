/**
 * BTC 표본 200 검증 — 15m·1H·4H, 최근 데이터, 신호 5 × 청산 4 = 60조합.
 *
 * 목적: 거래수를 늘려(조건당 200건 목표) 통계가 서는 기준을 찾는다.
 * 짧은 봉은 손익 폭이 작아 왕복 0.1% 비용의 비중이 커진다 — 수수료 잠식률을 함께 계산한다.
 *
 * 사용: node scripts/backtest/sample200.mjs [출력.json]
 *   → 기본 출력: docs/backtest/<KST 오늘>-sample200.json
 *   → 리포트: sample200-template.html 의 __DATA_JSON__/__DATA_PATH__ 에 JSON을 심어
 *     docs/backtest/sample200-report.html 로 만든다.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://www.okx.com/api/v5";
const INST = "BTC-USDT-SWAP";
const PAGE = 100;
const FEE_PCT = 0.1;
const WARMUP = 60; // 가장 깊은 지표가 SMA50 — 60봉이면 전부 선다.

/** 봉별 최근 구간·보유 시한 — 짧은 봉일수록 최신 데이터, 짧은 보유. */
const TFS = {
  "15m": { ms: 15 * 60_000, days: 180, maxHold: 96 }, // 1일
  "1H": { ms: 3600_000, days: 540, maxHold: 72 }, // 3일
  "4H": { ms: 4 * 3600_000, days: 720, maxHold: 60 }, // 10일
};

const EXITS = [
  { key: "atr-1-3", name: "ATR 손절1×·목표3×", rr: 3, type: "atr", sl: 1, tp: 3 },
  { key: "atr-1.5-2.25", name: "ATR 손절1.5×·목표2.25×", rr: 1.5, type: "atr", sl: 1.5, tp: 2.25 },
  { key: "atr-2-4", name: "ATR 손절2×·목표4×", rr: 2, type: "atr", sl: 2, tp: 4 },
  { key: "pct-1-2", name: "고정 손절1%·목표2%", rr: 2, type: "pct", sl: 1, tp: 2 },
];

/* ---------- 데이터 수집 ---------- */

async function fetchPage(bar, after, attempt = 0) {
  const url = `${BASE}/market/history-candles?instId=${INST}&bar=${bar}&after=${after}&limit=${PAGE}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  // 한도(429)는 실패가 아니라 속도 신호다 — 물러났다가 다시 간다.
  if (res.status === 429 && attempt < 5) {
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    return fetchPage(bar, after, attempt + 1);
  }
  if (!res.ok) throw new Error(`OKX ${res.status}`);
  const json = await res.json();
  if (json.code !== "0") throw new Error(`OKX: ${json.msg || json.code}`);
  return json.data;
}

async function fetchCandles(bar) {
  const { ms, days } = TFS[bar];
  const to = Math.floor(Date.now() / ms) * ms;
  const from = to - days * 24 * 3600_000;
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
    if (i + 8 < cursors.length) await new Promise((r) => setTimeout(r, 1600));
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/* ---------- 지표 — 시리즈 공통 (Wilder) ---------- */

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

/* ---------- 신호 5종 — 플레이북과 동일 정의 ---------- */

const SIGNALS = {
  "golden-cross": {
    name: "골든크로스",
    side: "long",
    rule: "SMA20이 SMA50을 상향 돌파 마감",
    signal: (i, c) => c.sma20[i - 1] <= c.sma50[i - 1] && c.sma20[i] > c.sma50[i],
  },
  "rsi-oversold-bounce": {
    name: "RSI 과매도 반등",
    side: "long",
    rule: "RSI(14)가 30 아래로 갔다가 30 위로 복귀 마감",
    signal: (i, c) => c.rsi[i - 1] < 30 && c.rsi[i] >= 30,
  },
  "rsi-50-volume": {
    name: "RSI 50 돌파 + 거래량 확장",
    side: "long",
    rule: "RSI(14)가 50 상향 돌파 마감, 거래량 ≥ 직전 20봉 평균의 1.5배",
    signal: (i, c) => c.rsi[i - 1] < 50 && c.rsi[i] >= 50 && c.candles[i].v >= 1.5 * c.volMA[i],
  },
  "rsi-overbought-fade": {
    name: "RSI 과매수 반락 (숏)",
    side: "short",
    rule: "RSI(14)가 70 위로 갔다가 70 아래로 복귀 마감",
    signal: (i, c) => c.rsi[i - 1] > 70 && c.rsi[i] <= 70,
  },
  "donchian-breakdown": {
    name: "20봉 신저가 이탈 (숏)",
    side: "short",
    rule: "종가가 직전 20봉 최저가 아래로 마감",
    signal: (i, c) => c.candles[i].c < c.ll20[i],
  },
};

/* ---------- 체결·통계 — 검증된 스윙 그리드와 동일 ---------- */

function walkExit(candles, entryIdx, entry, side, exit, atrSig, maxHold) {
  const dir = side === "long" ? 1 : -1;
  const slDist = exit.type === "atr" ? exit.sl * atrSig : entry * exit.sl / 100;
  const tpDist = exit.type === "atr" ? exit.tp * atrSig : entry * exit.tp / 100;
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
  const gross = ((exitPrice - entry) / entry) * dir * 100;
  return {
    exitIdx,
    exitPrice,
    exitType,
    grossPct: gross,
    pnl: Math.round((gross - FEE_PCT) * 1000) / 1000,
  };
}

function simulate(candles, ctx, signalKey, exit, maxHold) {
  const s = SIGNALS[signalKey];
  const trades = [];
  let openUntil = -1;
  for (let i = WARMUP; i < candles.length - 1; i += 1) {
    if (i < openUntil) continue;
    if (!s.signal(i, ctx)) continue;
    const entryIdx = i + 1;
    const entry = candles[entryIdx].o;
    const x = walkExit(candles, entryIdx, entry, s.side, exit, ctx.atr[i], maxHold);
    trades.push({
      signalIdx: i,
      entryIdx,
      exitIdx: x.exitIdx,
      entryAt: candles[entryIdx].t,
      exitAt: candles[x.exitIdx].t,
      entry,
      exit: x.exitPrice,
      exitType: x.exitType,
      holdBars: x.exitIdx - entryIdx + 1,
      grossPct: Math.round(x.grossPct * 1000) / 1000,
      pnl: x.pnl,
    });
    openUntil = x.exitIdx;
  }
  return trades;
}

function stats(allTrades, periodEdges) {
  const trades = allTrades
    .filter((t) => t.exitType !== "open")
    .slice()
    .sort((a, b) => a.exitAt - b.exitAt || a.entryAt - b.entryAt);
  const wins = trades.filter((t) => t.pnl > 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);

  let peak = 0, equity = 0, mdd = 0, streak = 0, maxWinStreak = 0, maxLossStreak = 0;
  for (const t of trades) {
    equity += t.pnl;
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

  // 수수료 잠식 — 비용을 내기 전 총이익 대비 총비용의 비율. 짧은 봉의 진실이 여기 있다.
  const grossBeforeFee = trades.reduce((s, t) => s + Math.max(t.grossPct, 0), 0);
  const totalFees = n * FEE_PCT;
  const feeShare = grossBeforeFee > 0 ? (totalFees / grossBeforeFee) * 100 : null;

  const periods = periodEdges.slice(0, -1).map((from, k) => {
    const to = periodEdges[k + 1];
    const ts = trades.filter((t) => t.entryAt >= from && t.entryAt < to);
    const sum = ts.reduce((s, t) => s + t.pnl, 0);
    return { n: ts.length, pnl: Math.round(sum * 1000) / 1000 };
  });

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
    feeShare: feeShare === null ? null : r(feeShare),
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
    positivePeriods: periods.filter((p) => p.n > 0 && p.pnl > 0).length,
  };
}

/* ---------- 실행 ---------- */

const result = {
  meta: {
    generatedAt: Date.now(),
    symbol: INST,
    fee: FEE_PCT,
    warmup: WARMUP,
    sampleTarget: 200,
    gates: "표본 ≥ 200 · 기대값 > 0 · P/F ≥ 1.1 · 3구간 중 2구간 이상 플러스",
    combosTested: Object.keys(SIGNALS).length * EXITS.length * Object.keys(TFS).length,
    rules: {
      entry: "신호 봉 마감 → 다음 봉 시가 진입",
      maxHold: "15m 96봉(1일) · 1H 72봉(3일) · 4H 60봉(10일)째 마감에 청산",
      fee: `왕복 ${FEE_PCT}% (수수료+슬리피지)`,
      conflict: "같은 봉에서 목표·손절 동시 도달 시 손절로 집계(보수적)",
      lock: "보유 중 새 신호 무시 — 한 조합 한 포지션",
    },
  },
  signals: Object.entries(SIGNALS).map(([key, s]) => ({ key, name: s.name, side: s.side, rule: s.rule })),
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
    ll20: rolling(candles, 20, (c) => c.l, (a, b) => a < b),
  };
  const t0 = candles[WARMUP].t;
  const t1 = candles[candles.length - 1].t;
  const periodEdges = [t0, t0 + (t1 - t0) / 3, t0 + (2 * (t1 - t0)) / 3, t1 + 1];

  const last = candles.length - 1;
  result.frames[tf] = {
    candles: candles.length,
    days: TFS[tf].days,
    from: candles[0].t,
    warmupFrom: t0,
    to: t1,
    atrPct: Math.round((ctx.atr[last] / candles[last].c) * 100 * 1000) / 1000,
    periodReturns: periodEdges.slice(0, -1).map((from, k) => {
      const to = periodEdges[k + 1];
      const inRange = candles.filter((c) => c.t >= from && c.t < to);
      const a = inRange[0]?.c, b = inRange[inRange.length - 1]?.c;
      return a && b ? Math.round(((b - a) / a) * 100 * 10) / 10 : null;
    }),
  };
  console.log(`${tf}: 캔들 ${candles.length}개 (${TFS[tf].days}일) ATR ${result.frames[tf].atrPct}%`);

  for (const [signalKey] of Object.entries(SIGNALS)) {
    for (const exit of EXITS) {
      const trades = simulate(candles, ctx, signalKey, exit, TFS[tf].maxHold);
      const st = stats(trades, periodEdges);
      result.combos.push({ tf, signal: signalKey, exit: exit.key, stats: st, trades });
    }
  }
}

/* ---------- 순위 — 표본 200 티어 우선, t-stat 순 ---------- */

const gate = (st) =>
  st.trades >= 200 && st.avgPnl > 0 && (st.profitFactor ?? Infinity) >= 1.1 && st.positivePeriods >= 2;
// 200 미만이어도 게이트의 나머지를 넘으면 보조 티어로 남긴다.
const gateSmall = (st) =>
  st.trades >= 50 && st.avgPnl > 0 && (st.profitFactor ?? Infinity) >= 1.1 && st.positivePeriods >= 2;

const ranked = result.combos
  .map((c) => ({ ...c, tier: gate(c.stats) ? 2 : gateSmall(c.stats) ? 1 : 0 }))
  .sort((a, b) => b.tier - a.tier || b.stats.tstat - a.stats.tstat);
result.topList = ranked.slice(0, 12).map((c) => ({ tf: c.tf, signal: c.signal, exit: c.exit, tier: c.tier }));

// 상위 12개만 거래 내역을 남긴다.
const keep = new Set(result.topList.map((t) => `${t.tf}|${t.signal}|${t.exit}`));
for (const c of result.combos) {
  if (!keep.has(`${c.tf}|${c.signal}|${c.exit}`)) delete c.trades;
}

const kstDay = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = process.argv[2] ?? join(repoRoot, "docs", "backtest", `${kstDay}-sample200.json`);
writeFileSync(out, JSON.stringify(result));

console.log(`\n조합 ${result.combos.length}개 · 표본200 게이트 ${ranked.filter((c) => c.tier === 2).length}개 · 소표본 게이트 ${ranked.filter((c) => c.tier === 1).length}개`);
for (const [i, t] of result.topList.entries()) {
  const c = result.combos.find((c) => c.tf === t.tf && c.signal === t.signal && c.exit === t.exit);
  const st = c.stats;
  console.log(
    `${String(i + 1).padStart(2)}. [${t.tf}] ${SIGNALS[t.signal].name} × ${EXITS.find((e) => e.key === t.exit).name}` +
    ` — ${st.trades}건 승률 ${st.winRate}% 기대값 ${st.avgPnl}% t=${st.tstat} PF ${st.profitFactor}` +
    ` 수수료잠식 ${st.feeShare}% 구간 ${st.positivePeriods}/3 ${t.tier === 2 ? "[표본200]" : t.tier === 1 ? "[소표본]" : "[미달]"}`,
  );
}
console.log(`저장: ${out}`);
