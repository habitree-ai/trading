/**
 * BTC 스윙 플레이북 Top 5 — 샘플 위치·진입·청산 시점까지 담는 실행 자료.
 *
 * 스윙 그리드 탐색(swing-grid.mjs)의 게이트 통과 기준 중 판정이 단순한(조건 1~2개)
 * 5개를 같은 코드로 재시뮬레이션하고, 리포트가 차트를 그릴 수 있게
 * 개요 가격선·사례 캔들 창·전체 거래 내역을 함께 저장한다.
 *
 * 사용: node scripts/backtest/top5-samples.mjs [출력.json]
 *   → 기본 출력: docs/backtest/<KST 오늘>-top5-samples.json
 *   → 리포트: top5-template.html 의 __DATA_JSON__/__DATA_PATH__ 에 JSON을 심어
 *     docs/backtest/top5-playbook.html 로 만든다.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://www.okx.com/api/v5";
const INST = "BTC-USDT-SWAP";
const DAYS = 720;
const PAGE = 100;
const FEE_PCT = 0.1;
const WARMUP = 200; // 그리드 탐색과 같은 출발선 — 수치가 이어져야 한다.

const TFS = {
  "4H": { ms: 4 * 3600_000, maxHold: 60 },
  "1D": { ms: 24 * 3600_000, maxHold: 20 },
};

/** 선정 5개 — 그리드 게이트 통과 6개에서 다이버전스(피벗 확정 지연·판정 복잡)만 뺐다. */
const TOP5 = [
  { tf: "4H", signal: "golden-cross", exit: { key: "atr-1-3", type: "atr", sl: 1, tp: 3, rr: 3 } },
  { tf: "4H", signal: "rsi-oversold-bounce", exit: { key: "atr-1-3", type: "atr", sl: 1, tp: 3, rr: 3 } },
  { tf: "4H", signal: "rsi-50-volume", exit: { key: "pct-1-2", type: "pct", sl: 1, tp: 2, rr: 2 } },
  { tf: "4H", signal: "rsi-overbought-fade", exit: { key: "atr-2-4", type: "atr", sl: 2, tp: 4, rr: 2 } },
  { tf: "1D", signal: "donchian-breakdown", exit: { key: "pct-2-4", type: "pct", sl: 2, tp: 4, rr: 2 } },
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

/* ---------- 지표 — 그리드 탐색과 동일 ---------- */

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

/* ---------- 신호 — 그리드 탐색과 동일 정의 (5개만) ---------- */

const SIGNALS = {
  "golden-cross": {
    name: "골든크로스",
    side: "long",
    view: "추세추종",
    rule: "SMA20이 SMA50을 상향 돌파 마감",
    simple: "이동평균 두 줄이 교차하는 순간만 보면 된다 — 판정 조건 1개",
    signal: (i, c) => c.sma20[i - 1] <= c.sma50[i - 1] && c.sma20[i] > c.sma50[i],
  },
  "rsi-oversold-bounce": {
    name: "RSI 과매도 반등",
    side: "long",
    view: "평균회귀",
    rule: "RSI(14)가 30 아래로 갔다가 30 위로 복귀 마감",
    simple: "RSI 선이 30선을 아래에서 위로 다시 넘는 순간 — 판정 조건 1개",
    signal: (i, c) => c.rsi[i - 1] < 30 && c.rsi[i] >= 30,
  },
  "rsi-50-volume": {
    name: "RSI 50 돌파 + 거래량 확장",
    side: "long",
    view: "모멘텀+거래량",
    rule: "RSI(14)가 50 상향 돌파 마감, 거래량 ≥ 직전 20봉 평균의 1.5배",
    simple: "RSI 50선 돌파 + 거래량 막대가 평소의 1.5배 — 판정 조건 2개",
    signal: (i, c) => c.rsi[i - 1] < 50 && c.rsi[i] >= 50 && c.candles[i].v >= 1.5 * c.volMA[i],
  },
  "rsi-overbought-fade": {
    name: "RSI 과매수 반락 (숏)",
    side: "short",
    view: "평균회귀",
    rule: "RSI(14)가 70 위로 갔다가 70 아래로 복귀 마감",
    simple: "RSI 선이 70선을 위에서 아래로 다시 넘는 순간 — 판정 조건 1개",
    signal: (i, c) => c.rsi[i - 1] > 70 && c.rsi[i] <= 70,
  },
  "donchian-breakdown": {
    name: "20봉 신저가 이탈 (숏)",
    side: "short",
    view: "추세추종",
    rule: "종가가 직전 20봉 최저가 아래로 마감",
    simple: "최근 20봉 바닥을 종가로 깨는 순간 — 판정 조건 1개",
    signal: (i, c) => c.candles[i].c < c.ll20[i],
  },
};

/* ---------- 체결·통계 — 그리드 탐색과 동일 ---------- */

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
      signalAt: candles[i].t,
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
      atrAtSignal: Math.round(ctx.atr[i] * 10) / 10,
    });
    // 청산 봉의 마감에는 이미 포지션이 없다 — 그 봉의 신호는 다음 봉 진입으로 유효하다.
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
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.pnl, 0);

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
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

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
    avgWin: r(avgWin),
    avgLoss: r(avgLoss),
    // 손익분기 승률 — 실측 평균 이익·손실 기준. 실측 승률과의 간격이 지속 가능성의 여유분이다.
    breakEvenWinRate: avgWin - avgLoss > 0 ? r((-avgLoss / (avgWin - avgLoss)) * 100) : null,
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
    curve,
  };
}

/* ---------- 실행 ---------- */

const CASES_PER = 6; // 기준당 확대 사례 수 — 최근 것부터.

const result = {
  meta: {
    generatedAt: Date.now(),
    symbol: INST,
    days: DAYS,
    fee: FEE_PCT,
    source: "swing-grid 132조합 탐색의 게이트 통과 기준에서 선별",
    pick: "게이트 통과 6개 중 판정 조건 1~2개인 5개 — 다이버전스는 피벗 확정 지연·판정 복잡으로 제외",
    rules: {
      entry: "신호 봉 마감 → 다음 봉 시가 진입",
      maxHold: "4H는 60봉(10일), 1D는 20봉(20일)째 마감에 청산",
      fee: `왕복 ${FEE_PCT}% (수수료+슬리피지)`,
      conflict: "같은 봉에서 목표·손절 동시 도달 시 손절로 집계(보수적)",
      lock: "보유 중 새 신호 무시 — 한 기준 한 포지션",
    },
  },
  frames: {},
  criteria: [],
};

const dataByTf = {};
for (const tf of ["4H", "1D"]) {
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
  dataByTf[tf] = { candles, ctx, periodEdges: [t0, t0 + (t1 - t0) / 3, t0 + (2 * (t1 - t0)) / 3, t1 + 1] };

  // 개요 차트용 가격선 — 4H는 2봉에 1점이면 충분히 읽힌다.
  const step = tf === "4H" ? 2 : 1;
  result.frames[tf] = {
    candles: candles.length,
    from: candles[0].t,
    warmupFrom: t0,
    to: t1,
    atrPct: Math.round((ctx.atr[candles.length - 1] / candles[candles.length - 1].c) * 100 * 1000) / 1000,
    overview: candles.filter((_, i) => i % step === 0 || i === candles.length - 1).map((c) => ({ t: c.t, c: c.c })),
  };
  console.log(`${tf}: 캔들 ${candles.length}개`);
}

for (const pick of TOP5) {
  const { candles, ctx, periodEdges } = dataByTf[pick.tf];
  const trades = simulate(candles, ctx, pick.signal, pick.exit, TFS[pick.tf].maxHold);
  const st = stats(trades, periodEdges);
  const s = SIGNALS[pick.signal];

  // 확대 사례 — 최근 완결 거래부터. 신호 앞 30봉 ~ 청산 뒤 10봉.
  // 판정에 쓰인 지표(이동평균·최저선·거래량 평균)를 함께 담아 "왜 신호였는지"가 차트에서 보이게 한다.
  const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
  const closed = trades.filter((t) => t.exitType !== "open");
  const cases = closed.slice(-CASES_PER).map((t) => {
    const from = Math.max(0, t.signalIdx - 30);
    const to = Math.min(candles.length - 1, t.exitIdx + 10);
    return {
      ...t,
      window: candles.slice(from, to + 1).map((c, k) => {
        const i = from + k;
        return {
          t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v,
          rsi: r1(ctx.rsi[i]),
          sma20: r1(ctx.sma20[i]),
          sma50: r1(ctx.sma50[i]),
          ll20: r1(ctx.ll20[i]),
          volMA: r1(ctx.volMA[i]),
        };
      }),
    };
  });

  // 개요 차트에 얹을 판정 지표 선 — 골든크로스는 SMA 두 줄, 신저가 이탈은 20봉 최저선.
  const step = pick.tf === "4H" ? 2 : 1;
  let overlay = null;
  if (pick.signal === "golden-cross") {
    overlay = {
      type: "sma",
      points: candles
        .map((c, i) => ({ t: c.t, a: r1(ctx.sma20[i]), b: r1(ctx.sma50[i]) }))
        .filter((p, i) => i % step === 0 && p.a !== null && p.b !== null),
    };
  } else if (pick.signal === "donchian-breakdown") {
    overlay = {
      type: "ll20",
      points: candles
        .map((c, i) => ({ t: c.t, v: r1(ctx.ll20[i]) }))
        .filter((p, i) => i % step === 0 && p.v !== null),
    };
  }

  result.criteria.push({
    overlay,
    tf: pick.tf,
    signal: pick.signal,
    name: s.name,
    side: s.side,
    view: s.view,
    rule: s.rule,
    simple: s.simple,
    exit: pick.exit,
    stats: st,
    trades,
    cases,
  });

  console.log(
    `[${pick.tf}] ${s.name} × ${pick.exit.key}: ${st.trades}건 승률 ${st.winRate}% (손익분기 ${st.breakEvenWinRate}%) ` +
    `기대값 ${st.avgPnl}% 총손익 ${st.totalPnl}%p PF ${st.profitFactor} 구간 ${st.positivePeriods}/3`,
  );
}

const kstDay = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = process.argv[2] ?? join(repoRoot, "docs", "backtest", `${kstDay}-top5-samples.json`);
writeFileSync(out, JSON.stringify(result));
console.log(`저장: ${out}`);
