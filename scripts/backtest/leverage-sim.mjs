/**
 * BTC 10배 레버리지 운용 시뮬레이션 — Top 5 기준 × 청산 관리 5방식, $100 복리.
 *
 * 리스크 규칙: 거래당 손실 상한 10% (수수료 포함). 손절 폭이 넓으면 레버리지를
 * 자동으로 낮춘다 — L = min(10, 10 / (손절폭% + 수수료%)). 손절 폭이 1% 안쪽이라
 * 청산가(10배 기준 약 -9.5%)에는 닿지 않는다.
 *
 * 청산 관리 5방식:
 *   fixed      기존 — 고정 목표·손절
 *   be         본절 — 목표의 50% 도달 후 되밀리면 본전 청산
 *   be-runner  본절 + 러너 — 목표 도달 시 청산하지 않고 1.5×ATR 트레일로 연장
 *   trail      샹들리에 — 목표 없이 최고가 - 2×ATR 트레일
 *   half-run   절반 익절 — 목표에서 절반 실현, 나머지는 본절 바닥 + 1.5×ATR 트레일
 *
 * 사용: node scripts/backtest/leverage-sim.mjs [출력.json]
 *   → 기본 출력: docs/backtest/<KST 오늘>-leverage-sim.json
 *   → 리포트: leverage-sim-template.html 의 __DATA_JSON__/__DATA_PATH__ 에 JSON을 심어
 *     docs/backtest/leverage-swing-report.html 로 만든다.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://www.okx.com/api/v5";
const INST = "BTC-USDT-SWAP";
const DAYS = 720;
const PAGE = 100;
const FEE_PCT = 0.1;
const WARMUP = 200;
const START_EQUITY = 100;
const MAX_LEV = 10;
const MAX_RISK_PCT = 10;

const TFS = {
  "4H": { ms: 4 * 3600_000, maxHold: 60 },
  "1D": { ms: 24 * 3600_000, maxHold: 20 },
};

/** 플레이북 Top 5 — 신호·기본 손절/목표 폭은 그대로 쓴다. */
const TOP5 = [
  { tf: "4H", signal: "golden-cross", exit: { key: "atr-1-3", type: "atr", sl: 1, tp: 3, rr: 3 } },
  { tf: "4H", signal: "rsi-oversold-bounce", exit: { key: "atr-1-3", type: "atr", sl: 1, tp: 3, rr: 3 } },
  { tf: "4H", signal: "rsi-50-volume", exit: { key: "pct-1-2", type: "pct", sl: 1, tp: 2, rr: 2 } },
  { tf: "4H", signal: "rsi-overbought-fade", exit: { key: "atr-2-4", type: "atr", sl: 2, tp: 4, rr: 2 } },
  { tf: "1D", signal: "donchian-breakdown", exit: { key: "pct-2-4", type: "pct", sl: 2, tp: 4, rr: 2 } },
];

const MGMTS = [
  { key: "fixed", name: "기존 (고정 목표·손절)", desc: "목표·손절 그대로 — 플레이북 기본형" },
  { key: "be", name: "본절", desc: "목표의 50% 도달 후 되밀리면 본전 청산 (수수료만 부담)" },
  { key: "be-runner", name: "본절 + 러너", desc: "50%에서 본절 확보, 목표 도달 시 청산하지 않고 1.5×ATR 트레일로 연장" },
  { key: "trail", name: "샹들리에 트레일", desc: "목표 없음 — 최고가에서 2×ATR 되밀리면 청산" },
  { key: "half-run", name: "절반 익절 + 러너", desc: "목표에서 절반 실현, 나머지는 본절 바닥 + 1.5×ATR 트레일" },
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

/* ---------- 지표 — 기존 검토와 동일 ---------- */

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

/* ---------- 관리형 체결 시뮬레이션 ----------
 *
 * 봉 안의 경로를 모르므로 항상 보수적으로 푼다:
 *   1) 그 봉 시작 시점의 손절선(원래/본절/트레일)이 먼저 닿았다고 본다.
 *   2) 목표·본절 무장(arming)이 같은 봉에서 함께 가능하면, 무장 뒤 같은 봉에서
 *      본전까지 되밀린 것으로 본다(이익을 들고 가는 쪽이 아니라 놓치는 쪽).
 *   3) 트레일 손절선은 봉이 끝난 뒤에만 올린다 — 그 봉의 고점으로 그 봉을 자르지 않는다.
 */
function walkManaged(candles, entryIdx, entry, side, exit, mgmt, atrSig, maxHold) {
  const dir = side === "long" ? 1 : -1;
  const slDist = exit.type === "atr" ? exit.sl * atrSig : entry * exit.sl / 100;
  const tpDist = exit.type === "atr" ? exit.tp * atrSig : entry * exit.tp / 100;
  const target = entry + dir * tpDist;
  const half = entry + dir * 0.5 * tpDist;
  const trailK = mgmt === "trail" ? 2 : 1.5;

  let stop = entry - dir * slDist;
  let armed = false; // 본절 무장 여부
  let runner = false; // 목표를 지나 연장 중인가
  let extreme = entry; // 진입 후 최고(롱)/최저(숏)
  const legs = []; // {weight, price, type}
  let remain = 1;

  const lastIdx = Math.min(entryIdx + maxHold - 1, candles.length - 1);
  let exitIdx = lastIdx;

  const hitStop = (bar) => (dir === 1 ? bar.l <= stop : bar.h >= stop);
  const hitLevel = (bar, level) => (dir === 1 ? bar.h >= level : bar.l <= level);
  const beTouched = (bar) => (dir === 1 ? bar.l <= entry : bar.h >= entry);

  for (let j = entryIdx; j <= lastIdx; j += 1) {
    const bar = candles[j];

    // 1) 봉 시작 시점의 손절선이 우선. 손절선이 봉 범위 밖(갭·트레일 랫칭)이면
    //    그 봉이 거래하지 않은 가격에 체결될 수 없다 — 시가로 체결한다(더 불리한 쪽으로만).
    if (hitStop(bar)) {
      const fill = dir === 1 ? Math.min(stop, bar.o) : Math.max(stop, bar.o);
      const type = Math.abs(fill - entry) < 1e-9
        ? "be"
        : (dir === 1 ? fill > entry : fill < entry) ? "trail" : "sl";
      legs.push({ weight: remain, price: fill, type });
      remain = 0;
      exitIdx = j;
      break;
    }

    // 2) 목표 도달.
    if (!runner && hitLevel(bar, target)) {
      // 무장 전에 본전까지 되밀릴 수 있는 봉이면 최악 순서로 푼다 —
      // 50% 도달 → 무장 → 본전 회귀 → (그 뒤에야) 목표. 전량 본절이다.
      // 이미 무장된 상태였다면 1)에서 본절로 걸러졌으므로 여기 오지 않는다.
      if (mgmt !== "fixed" && mgmt !== "trail" && !armed && beTouched(bar)) {
        legs.push({ weight: remain, price: entry, type: "be" });
        remain = 0;
        exitIdx = j;
        break;
      }
      if (mgmt === "fixed" || mgmt === "be") {
        legs.push({ weight: remain, price: target, type: "tp" });
        remain = 0;
        exitIdx = j;
        break;
      }
      if (mgmt === "half-run") {
        legs.push({ weight: remain / 2, price: target, type: "tp" });
        remain /= 2;
      }
      if (mgmt === "be-runner" || mgmt === "half-run") {
        runner = true;
        armed = true;
        stop = dir === 1 ? Math.max(stop, entry) : Math.min(stop, entry);
      }
      // mgmt === "trail"은 목표 개념이 없다 — 도달해도 계속 간다.
    }

    // 3) 본절 무장 — 목표의 50% 도달. 같은 봉에서 본전까지 되밀리면 본절 청산(보수적).
    if (!armed && mgmt !== "fixed" && mgmt !== "trail" && hitLevel(bar, half)) {
      armed = true;
      stop = dir === 1 ? Math.max(stop, entry) : Math.min(stop, entry);
      if (beTouched(bar)) {
        legs.push({ weight: remain, price: entry, type: "be" });
        remain = 0;
        exitIdx = j;
        break;
      }
    }

    // 4) 봉 마감 뒤 트레일 갱신 — 다음 봉부터 적용된다.
    extreme = dir === 1 ? Math.max(extreme, bar.h) : Math.min(extreme, bar.l);
    if (runner || mgmt === "trail") {
      const trail = extreme - dir * trailK * atrSig;
      stop = dir === 1 ? Math.max(stop, trail) : Math.min(stop, trail);
    }
  }

  if (remain > 0) {
    const isEnd = lastIdx === candles.length - 1 && lastIdx - entryIdx + 1 < maxHold;
    legs.push({ weight: remain, price: candles[exitIdx].c, type: isEnd ? "open" : "time" });
  }

  const gross = legs.reduce((s, l) => s + l.weight * ((l.price - entry) / entry) * dir * 100, 0);
  const hasOpen = legs.some((l) => l.type === "open");
  return {
    exitIdx,
    legs,
    // 두 다리(절반 익절)면 "익절 + 러너의 결말"로 적는다 — 러너가 어떻게 끝났는지가 정보다.
    exitType: hasOpen ? "open" : legs.length > 1 ? "tp+" + legs[legs.length - 1].type : legs[0].type,
    grossPct: gross,
    stopDistPct: (slDist / entry) * 100,
    exitPrice: legs.reduce((s, l) => s + l.weight * l.price, 0),
  };
}

/* ---------- 조합 시뮬레이션 — $100 복리 ---------- */

function simulateCombo(candles, ctx, pick, mgmt, maxHold, periodEdges, riskPct = MAX_RISK_PCT) {
  const s = SIGNALS[pick.signal];
  const trades = [];
  let openUntil = -1;
  let equity = START_EQUITY;
  const curve = [{ at: candles[WARMUP].t, eq: START_EQUITY }];

  for (let i = WARMUP; i < candles.length - 1; i += 1) {
    if (i < openUntil) continue;
    if (!s.signal(i, ctx)) continue;
    const entryIdx = i + 1;
    const entry = candles[entryIdx].o;
    const x = walkManaged(candles, entryIdx, entry, s.side, pick.exit, mgmt, ctx.atr[i], maxHold);
    openUntil = x.exitIdx;
    if (x.exitType === "open") continue; // 미완결은 복리 계산에서 뺀다.

    // 레버리지 — 손절에 걸려도 (수수료 포함) 계좌의 리스크 상한을 넘지 않게.
    const lev = Math.min(MAX_LEV, riskPct / (x.stopDistPct + FEE_PCT));
    const netPct = (x.grossPct - FEE_PCT) * lev; // 계좌 기준 %
    const eqBefore = equity;
    equity *= 1 + netPct / 100;
    trades.push({
      signalIdx: i,
      entryIdx,
      exitIdx: x.exitIdx,
      entryAt: candles[entryIdx].t,
      exitAt: candles[x.exitIdx].t,
      entry,
      exitPrice: Math.round(x.exitPrice * 10) / 10,
      exitType: x.exitType,
      legs: x.legs.map((l) => ({ w: l.weight, p: Math.round(l.price * 10) / 10, type: l.type })),
      holdBars: x.exitIdx - entryIdx + 1,
      grossPct: Math.round(x.grossPct * 1000) / 1000,
      lev: Math.round(lev * 100) / 100,
      netPct: Math.round(netPct * 1000) / 1000,
      equity: Math.round(equity * 100) / 100,
    });
    curve.push({ at: candles[x.exitIdx].t, eq: Math.round(equity * 100) / 100 });
  }

  // 통계 — 계좌 기준.
  const n = trades.length;
  const wins = trades.filter((t) => t.netPct > 0);
  let peak = START_EQUITY;
  let mdd = 0;
  let streak = 0, maxLossStreak = 0;
  for (const t of trades) {
    peak = Math.max(peak, t.equity);
    mdd = Math.min(mdd, (t.equity / peak - 1) * 100);
    streak = t.netPct > 0 ? 0 : streak + 1;
    maxLossStreak = Math.max(maxLossStreak, streak);
  }
  const totalReturn = (equity / START_EQUITY - 1) * 100;

  const periods = periodEdges.slice(0, -1).map((from, k) => {
    const to = periodEdges[k + 1];
    const ts = trades.filter((t) => t.entryAt >= from && t.entryAt < to);
    const growth = ts.reduce((g, t) => g * (1 + t.netPct / 100), 1);
    return { n: ts.length, ret: Math.round((growth - 1) * 100 * 10) / 10 };
  });

  const r = (x) => Math.round(x * 100) / 100;
  const exitCounts = {};
  for (const t of trades) exitCounts[t.exitType] = (exitCounts[t.exitType] ?? 0) + 1;

  return {
    trades,
    curve,
    stats: {
      trades: n,
      wins: wins.length,
      winRate: n ? r((wins.length / n) * 100) : null,
      finalEquity: r(equity),
      totalReturn: r(totalReturn),
      mdd: r(mdd),
      mar: mdd !== 0 ? r(totalReturn / -mdd) : null,
      avgLev: n ? r(trades.reduce((s, t) => s + t.lev, 0) / n) : null,
      avgNet: n ? r(trades.reduce((s, t) => s + t.netPct, 0) / n) : null,
      avgWinNet: wins.length ? r(wins.reduce((s, t) => s + t.netPct, 0) / wins.length) : null,
      avgLossNet: n - wins.length ? r(trades.filter((t) => t.netPct <= 0).reduce((s, t) => s + t.netPct, 0) / (n - wins.length)) : null,
      bestNet: n ? r(Math.max(...trades.map((t) => t.netPct))) : null,
      worstNet: n ? r(Math.min(...trades.map((t) => t.netPct))) : null,
      avgHoldBars: n ? r(trades.reduce((s, t) => s + t.holdBars, 0) / n) : null,
      maxLossStreak,
      exitCounts,
      periods,
      positivePeriods: periods.filter((p) => p.n > 0 && p.ret > 0).length,
    },
  };
}

/* ---------- 실행 ---------- */

const result = {
  meta: {
    generatedAt: Date.now(),
    symbol: INST,
    days: DAYS,
    fee: FEE_PCT,
    startEquity: START_EQUITY,
    maxLev: MAX_LEV,
    maxRiskPct: MAX_RISK_PCT,
    sizing: "L = min(10, 10 / (손절폭% + 0.1%)) — 손절에 걸려도 수수료 포함 -10%를 넘지 않는다",
    rules: {
      entry: "신호 봉 마감 → 다음 봉 시가 진입",
      maxHold: "4H는 60봉(10일), 1D는 20봉(20일)째 마감에 청산",
      fee: `왕복 ${FEE_PCT}% × 레버리지 (펀딩비 제외)`,
      conflict: "봉 내부 경로는 항상 불리하게 — 손절 우선, 무장·목표와 본전 회귀가 겹치면 본절, 트레일은 봉 마감 뒤 갱신, 손절선이 봉 밖이면 시가 체결(갭)",
      lock: "보유 중 새 신호 무시 — 한 조합 한 포지션",
    },
  },
  criteria: TOP5.map((p) => ({ ...p, name: SIGNALS[p.signal].name, side: SIGNALS[p.signal].side, rule: SIGNALS[p.signal].rule })),
  mgmts: MGMTS,
  frames: {},
  combos: [],
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
  result.frames[tf] = { candles: candles.length, from: candles[0].t, warmupFrom: t0, to: t1 };
  console.log(`${tf}: 캔들 ${candles.length}개`);
}

for (const pick of TOP5) {
  const { candles, ctx, periodEdges } = dataByTf[pick.tf];
  for (const mgmt of MGMTS) {
    const sim = simulateCombo(candles, ctx, pick, mgmt.key, TFS[pick.tf].maxHold, periodEdges);
    // 리스크 민감도 — 같은 거래를 거래당 2%·5% 리스크로도 복리 계산한다.
    // "가장 안정적"의 답은 조합만이 아니라 리스크 수준에도 달려 있다.
    const riskSensitivity = Object.fromEntries(
      [2, 5].map((r) => {
        const s = simulateCombo(candles, ctx, pick, mgmt.key, TFS[pick.tf].maxHold, periodEdges, r).stats;
        return [`r${r}`, { finalEquity: s.finalEquity, mdd: s.mdd, mar: s.mar, avgLev: s.avgLev }];
      }),
    );
    result.combos.push({
      tf: pick.tf,
      signal: pick.signal,
      exit: pick.exit,
      mgmt: mgmt.key,
      stats: sim.stats,
      riskSensitivity,
      curve: sim.curve,
      trades: sim.trades,
    });
  }
}

/* ---------- 안정 순위 — MAR(총수익 ÷ 최대낙폭) 기준, 게이트 통과 우선 ---------- */

const gate = (st) => st.trades >= 20 && st.totalReturn > 0 && st.positivePeriods >= 2;
const ranked = result.combos
  .map((c) => ({ ...c, gated: gate(c.stats) }))
  // mar가 null이면 낙폭 0이라는 뜻 — 무한대로 취급해 맨 위로 보낸다.
  .sort((a, b) => (b.gated ? 1 : 0) - (a.gated ? 1 : 0) || (b.stats.mar ?? Infinity) - (a.stats.mar ?? Infinity));
result.top10 = ranked.slice(0, 10).map((c) => ({ tf: c.tf, signal: c.signal, mgmt: c.mgmt, gated: c.gated }));

// 파일 크기 — 상위 10개만 거래 내역을 남기고, 나머지는 곡선·통계만.
const keep = new Set(result.top10.map((t) => `${t.tf}|${t.signal}|${t.mgmt}`));
for (const c of result.combos) {
  if (!keep.has(`${c.tf}|${c.signal}|${c.mgmt}`)) delete c.trades;
}

const kstDay = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = process.argv[2] ?? join(repoRoot, "docs", "backtest", `${kstDay}-leverage-sim.json`);
writeFileSync(out, JSON.stringify(result));

console.log(`\n조합 ${result.combos.length}개 · 게이트 통과 ${ranked.filter((c) => c.gated).length}개`);
for (const [i, t] of result.top10.entries()) {
  const c = result.combos.find((c) => c.tf === t.tf && c.signal === t.signal && c.mgmt === t.mgmt);
  const st = c.stats;
  console.log(
    `${String(i + 1).padStart(2)}. [${t.tf}] ${SIGNALS[t.signal].name} × ${MGMTS.find((m) => m.key === t.mgmt).name}` +
    ` — $100→$${st.finalEquity} (${st.totalReturn > 0 ? "+" : ""}${st.totalReturn}%) MDD ${st.mdd}% MAR ${st.mar}` +
    ` ${st.trades}건 승률 ${st.winRate}% 평균레버 ${st.avgLev}배${t.gated ? "" : " (게이트 미달)"}`,
  );
}
console.log(`저장: ${out}`);
