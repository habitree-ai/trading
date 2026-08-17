/**
 * 복리 조합 탐색 — 검증 계보 7개 전략의 병행 포트폴리오로 "복리 장기우상향"을 찾는다.
 *
 * 전제(두 회차의 결론): 단일 전략 축에서는 t≥1.5 엣지가 없다. 남은 축은
 * ① 조합(방향·봉·계열 분산 → MDD 하락 → MAR 상승) ② 사이징 ③ 정직한 불확실성.
 *
 * 사전 등록 "찾았다" 기준 (리스크 5%, 전체 창, 테이커+펀딩 기준):
 *   MAR(연복리/|MDD|) ≥ 1.0 · MDD ≥ −40% · 3구간 전부 플러스 ·
 *   블록 부트스트랩 20퍼센타일에서 CAGR > 0 · BTC 보유 대비 MAR 우위.
 *
 * 회계: 포트폴리오 검토(감사 통과)와 동일 — 진입 시점 실현 잔고 사이징,
 * 같은 봉 청산 가드, 청산 시점 손익 반영. 이번 회차 추가: 동시 상한 "강제"
 * (본대 봇과 같은 스킵 규칙 — 이전 검토는 추적만 했다), 펀딩 시나리오, 부트스트랩.
 *
 * 사용:
 *   node scripts/backtest/ensemble.mjs run     → docs/backtest/<KST>-ensemble.json
 *   node scripts/backtest/ensemble.mjs report  → docs/backtest/ensemble-report.html
 * (데이터는 short-tf 캐시 재사용 — 1H 3.3년 · 4H 5년 · 1D 6.6년)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FEE_PCT = 0.1; // 왕복 테이커 — 시리즈 공통.
const FUND_LONG_PCT_PER_DAY = 0.03; // 펀딩 가정: 롱 지불 0.03%/일, 숏 수취는 0으로 절사(보수).
const START = 100;
const MAX_LEV = 10;
const WARMUP = { "1H": 260, "4H": 220, "1D": 220 }; // 각 봉의 시리즈 워밍업 관례.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = join(repoRoot, "scripts", "backtest", ".cache", "short-tf-candles.json");

const TFS = {
  "1H": { ms: 3600_000, maxHold: 120 },
  "4H": { ms: 4 * 3600_000, maxHold: 60 },
  "1D": { ms: 24 * 3600_000, maxHold: 20 },
};

/** 구성원 7 — criteria.md의 판정·청산 그대로 (스펙 동결일 각 회차). */
const MEMBERS = {
  gc: { tf: "4H", side: "long", exit: { type: "atr", sl: 1, tp: 3 }, label: "골든크로스 (4H·롱)", origin: "쿼드(라이브)" },
  ob: { tf: "4H", side: "long", exit: { type: "atr", sl: 1, tp: 3 }, label: "RSI 과매도 반등 (4H·롱)", origin: "쿼드(라이브)" },
  fade: { tf: "4H", side: "short", exit: { type: "atr", sl: 2, tp: 4 }, label: "RSI 과매수 반락 (4H·숏)", origin: "쿼드(라이브)" },
  dc: { tf: "1D", side: "short", exit: { type: "pct", sl: 2, tp: 4 }, label: "20봉 신저가 이탈 (1D·숏)", origin: "쿼드(라이브)" },
  dch: { tf: "4H", side: "short", exit: { type: "atr", sl: 1, tp: 3 }, label: "신저가 숏+일봉 하락 (4H·숏)", origin: "후보(페이퍼)" },
  mcv: { tf: "4H", side: "long", exit: { type: "atr", sl: 1, tp: 1 }, label: "MACD+거래량 (4H·롱)", origin: "후보(페이퍼)" },
  ibq: { tf: "1H", side: "long", exit: { type: "atr", sl: 2, tp: 6 }, label: "인사이드바+저변동 (1H·롱)", origin: "후보(페이퍼)" },
};

/**
 * 조합 사전 등록 — 결과를 보고 구성원을 고르면 과적합이다. 전부 근거 있는 정의만.
 * 주 가설(primary)은 all7 — "분산 최대가 복리 우상향을 만든다"가 이 회차의 가설이므로
 * 사전 등록 게이트는 all7에 적용하고, 나머지는 부 가설로 전 조합의 게이트 표를 보고한다
 * (승자 선택-부트스트랩의 winner's curse를 피한다 — 검증 에이전트 지적 반영).
 * 상한: 쿼드는 라이브 실제 상수(동시 2·절대 20%), 나머지는 후보 트랙 형태(멤버당 1슬롯·3×리스크).
 */
const SUBSETS = [
  { key: "quad", name: "쿼드 (현행 라이브)", members: ["gc", "ob", "fade", "dc"], why: "현행 라이브 구성 — 대조군", cap: { maxConcurrent: 2, absPct: 20 } },
  { key: "new3", name: "후보 3 (페이퍼 트랙)", members: ["dch", "mcv", "ibq"], why: "후보 트랙 구성 그대로", cap: { maxConcurrent: 3, xRisk: 3 } },
  { key: "all7", name: "전체 7 병행", members: ["gc", "ob", "fade", "dc", "dch", "mcv", "ibq"], why: "검증 계보 전부 — 분산 최대 (주 가설)", cap: { maxConcurrent: 3, xRisk: 3 } },
  { key: "all6", name: "전체 7 − fade", members: ["gc", "ob", "dc", "dch", "mcv", "ibq"], why: "criteria.md가 '여유 최얇·최우선 관찰'로 지목한 fade 제외", cap: { maxConcurrent: 3, xRisk: 3 } },
  { key: "long4", name: "롱 4 병행", members: ["gc", "ob", "mcv", "ibq"], why: "롱 전용 — 방향 분산의 가치를 역으로 측정", cap: { maxConcurrent: 3, xRisk: 3 } },
  { key: "short3", name: "숏 3 병행", members: ["fade", "dc", "dch"], why: "숏 전용 — 하락 국면 방어력 측정", cap: { maxConcurrent: 3, xRisk: 3 } },
];
const PRIMARY_SUBSET = "all7";
const RISKS = [2, 5, 10];

/**
 * 리스크 오버레이 사전 등록 — 파라미터 피팅 없음, 전부 기계적 규칙.
 *   base      고정 리스크 (원 가설)
 *   throttle  드로다운 스로틀 — 유효 리스크 = 기본 × clamp(실현잔고/실현피크, 0.25, 1)
 *   regime    일봉 레짐 게이트 — 롱은 일봉 종가>일봉 SMA200일 때만, 숏은 <일 때만
 *   both      throttle + regime
 * 4개 전부의 게이트 결과를 보고한다(오버레이 선택 편향 방지). 주 가설은 여전히 base.
 */
const OVERLAYS = ["base", "throttle", "regime", "both"];

/* ---------- 지표 — 시리즈 공통 ---------- */

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

function ema(values, n) {
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  let seed = 0;
  for (let i = 0; i < n; i += 1) seed += values[i];
  out[n - 1] = seed / n;
  const k = 2 / (n + 1);
  for (let i = n; i < values.length; i += 1) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

function macd(closes, fast = 12, slow = 26, sig = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const line = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null,
  );
  const start = line.findIndex((v) => v !== null);
  const signal = new Array(closes.length).fill(null);
  if (start >= 0) {
    const seg = ema(line.slice(start), sig);
    for (let i = 0; i < seg.length; i += 1) signal[start + i] = seg[i];
  }
  return { line, signal };
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

function rollingLow(candles, n) {
  const out = new Array(candles.length).fill(null);
  const deque = [];
  for (let i = 0; i < candles.length; i += 1) {
    if (i >= 1) {
      const v = candles[i - 1].l;
      while (deque.length && candles[deque[deque.length - 1]].l >= v) deque.pop();
      deque.push(i - 1);
    }
    while (deque.length && deque[0] < i - n) deque.shift();
    if (i >= n) out[i] = candles[deque[0]].l;
  }
  return out;
}

/** 하위봉 i → 마감 완료된 최신 상위봉 인덱스. */
function htfIndexMap(candles, htf, htfMs) {
  const out = new Array(candles.length).fill(-1);
  let d = -1;
  for (let i = 0; i < candles.length; i += 1) {
    while (d + 1 < htf.length && htf[d + 1].t + htfMs <= candles[i].t) d += 1;
    out[i] = d;
  }
  return out;
}

/* ---------- 신호 — criteria.md와 동일 부등식 ---------- */

const SIGNALS = {
  gc: (i, c) => c.sma20[i - 1] !== null && c.sma50[i - 1] !== null && c.sma20[i - 1] <= c.sma50[i - 1] && c.sma20[i] > c.sma50[i],
  ob: (i, c) => c.rsi[i - 1] !== null && c.rsi[i - 1] < 30 && c.rsi[i] >= 30,
  fade: (i, c) => c.rsi[i - 1] !== null && c.rsi[i - 1] > 70 && c.rsi[i] <= 70,
  dc: (i, c) => c.ll20[i] !== null && c.candles[i].c < c.ll20[i],
  dch: (i, c) => {
    if (c.ll20[i] === null || c.candles[i].c >= c.ll20[i]) return false;
    const d = c.htf1dIdx[i];
    return d >= 0 && c.dailySma50[d] !== null && c.daily[d].c < c.dailySma50[d];
  },
  mcv: (i, c) =>
    c.macdSig[i - 1] !== null && c.macdLine[i - 1] <= c.macdSig[i - 1] && c.macdLine[i] > c.macdSig[i] &&
    c.volMA[i] !== null && c.candles[i].v >= 1.5 * c.volMA[i],
  ibq: (i, c) =>
    i >= 2 &&
    c.candles[i - 1].h < c.candles[i - 2].h && c.candles[i - 1].l > c.candles[i - 2].l &&
    c.candles[i].c > c.candles[i - 2].h &&
    c.atr[i] !== null && c.atrMA100[i] !== null && c.atr[i] < c.atrMA100[i],
};

/* ---------- 체결 — 시리즈 공통 (신호 봉 마감 → 다음 봉 시가, 손절 우선·갭 시가) ---------- */

function walkExit(candles, entryIdx, entry, side, exit, atrSig, maxHold) {
  const dir = side === "long" ? 1 : -1;
  const slDist = exit.type === "atr" ? exit.sl * atrSig : (entry * exit.sl) / 100;
  const tpDist = exit.type === "atr" ? exit.tp * atrSig : (entry * exit.tp) / 100;
  const stop = entry - dir * slDist;
  const target = entry + dir * tpDist;

  let exitIdx = Math.min(entryIdx + maxHold - 1, candles.length - 1);
  let exitPrice = candles[exitIdx].c;
  let exitType = "time";
  for (let j = entryIdx; j <= exitIdx; j += 1) {
    const bar = candles[j];
    const hitSl = dir === 1 ? bar.l <= stop : bar.h >= stop;
    const hitTp = dir === 1 ? bar.h >= target : bar.l <= target;
    // 같은 봉에서 둘 다 걸리면 손절 — 봉 내부 경로를 모르니 보수적으로.
    if (hitSl) {
      exitIdx = j;
      exitPrice = dir === 1 ? Math.min(stop, bar.o) : Math.max(stop, bar.o);
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
  return { exitIdx, exitPrice, exitType, slDistPct: (slDist / entry) * 100, grossPct: gross };
}

function simulateMember(key, ctxByTf) {
  const m = MEMBERS[key];
  const ctx = ctxByTf[m.tf];
  const candles = ctx.candles;
  const maxHold = TFS[m.tf].maxHold;
  const warm = WARMUP[m.tf];
  const trades = [];
  let openUntil = -1;
  for (let i = warm; i < candles.length - 1; i += 1) {
    if (i < openUntil) continue;
    if (ctx.atr[i] === null) continue;
    if (!SIGNALS[key](i, ctx)) continue;
    const entryIdx = i + 1;
    const entry = candles[entryIdx].o;
    const x = walkExit(candles, entryIdx, entry, m.side, m.exit, ctx.atr[i], maxHold);
    if (x.exitType === "open") break; // 미결 거래는 복리 계산에서 제외.
    const holdDays = ((x.exitIdx - entryIdx + 1) * TFS[m.tf].ms) / 86400_000;
    trades.push({
      member: key,
      tf: m.tf,
      side: m.side,
      entry,
      entryAt: candles[entryIdx].t,
      exitAt: candles[x.exitIdx].t,
      // 슬롯·잔고 해제 기준 — 청산 "봉 마감" 시각. 봉 시가 기준이면 아직 안 난 청산이
      // 상한을 미리 풀어준다 (검증 에이전트 지적 반영).
      exitCloseAt: candles[x.exitIdx].t + TFS[m.tf].ms,
      exitType: x.exitType,
      holdDays: Math.round(holdDays * 100) / 100,
      grossPct: Math.round(x.grossPct * 1000) / 1000,
      stopDistPct: Math.round(x.slDistPct * 1000) / 1000,
      // 펀딩 가정: 롱 지불 0.03%/일 (명목 기준 — 레버에 비례 확대), 숏 수취 절사.
      fundPct: m.side === "long" ? Math.round(FUND_LONG_PCT_PER_DAY * holdDays * 1000) / 1000 : 0,
      // 레짐 오버레이용 — 신호 시점에 마감 완료된 일봉 종가 vs 일봉 SMA200.
      regimeUp: (() => {
        const d = ctx.htf1dIdx[i];
        return d >= 0 && ctx.dailySma200[d] !== null ? ctx.daily[d].c > ctx.dailySma200[d] : null;
      })(),
    });
    openUntil = x.exitIdx;
  }
  return trades;
}

/* ---------- 병행 복리 — 감사 통과 회계 + 동시 상한 강제 ---------- */

function runPortfolio(memberKeys, risk, tradesByMember, windowFrom, windowTo, withFunding, cap, c4ForMdd, overlay = "base") {
  const useThrottle = overlay === "throttle" || overlay === "both";
  const useRegime = overlay === "regime" || overlay === "both";
  const all = memberKeys
    .flatMap((mk) => tradesByMember[mk])
    .filter((t) => t.entryAt >= windowFrom && t.entryAt < windowTo)
    .sort((a, b) => a.entryAt - b.entryAt || a.exitCloseAt - b.exitCloseAt)
    .map((t) => ({ ...t })); // 러너 간 상태 오염 방지 — 사본으로 계산.

  const byExit = all.slice().sort((a, b) => a.exitCloseAt - b.exitCloseAt || a.entryAt - b.entryAt);
  let realized = START;
  let exitPtr = 0;
  const curve = [{ at: windowFrom, eq: START }];
  const open = []; // {exitCloseAt, riskPct}
  const log = [];
  let skipped = 0;
  let filteredRegime = 0;
  let peakRealized = START;
  let maxConcurrent = 0;

  for (const t of all) {
    // 이 진입보다 먼저(봉 마감 기준) 끝난 거래의 손익을 잔고에 반영 — 같은 봉 청산 가드 포함.
    while (exitPtr < byExit.length && byExit[exitPtr].exitCloseAt <= t.entryAt) {
      const e = byExit[exitPtr];
      if (!e._resolved && !e._skipped) break;
      if (e._resolved) {
        realized += e._pnlUsd;
        curve.push({ at: e.exitCloseAt, eq: Math.round(realized * 100) / 100 });
      }
      exitPtr += 1;
    }
    for (let k = open.length - 1; k >= 0; k -= 1) if (open[k].exitCloseAt <= t.entryAt) open.splice(k, 1);
    peakRealized = Math.max(peakRealized, realized);

    // 레짐 게이트 — 롱은 일봉>SMA200에서만, 숏은 <에서만. 판정 불가(null)는 보수적으로 제외.
    if (useRegime && ((t.side === "long" && t.regimeUp !== true) || (t.side === "short" && t.regimeUp !== false))) {
      t._skipped = true;
      filteredRegime += 1;
      continue;
    }

    // 드로다운 스로틀 — 실현 낙폭에 비례해 리스크 축소 (하한 25%).
    const riskEff = useThrottle
      ? risk * Math.max(0.25, Math.min(1, realized / peakRealized))
      : risk;

    // 동시 상한 강제 — 조합별 상한(쿼드=라이브 2개·절대 20%, 나머지=후보 트랙 3개·3×리스크).
    const openRisk = open.reduce((s, o) => s + o.riskPct, 0);
    const riskCapPct = cap.absPct ?? cap.xRisk * risk;
    if (open.length >= cap.maxConcurrent || openRisk + riskEff > riskCapPct) {
      t._skipped = true;
      skipped += 1;
      continue;
    }

    const lev = Math.min(MAX_LEV, riskEff / (t.stopDistPct + FEE_PCT));
    const cost = FEE_PCT + (withFunding ? t.fundPct : 0);
    const netPct = (t.grossPct - cost) * lev;
    t._pnlUsd = (realized * netPct) / 100;
    t._resolved = true;
    open.push({ exitCloseAt: t.exitCloseAt, riskPct: riskEff });
    maxConcurrent = Math.max(maxConcurrent, open.length);
    log.push({
      member: t.member, tf: t.tf, side: t.side, entry: t.entry,
      entryAt: t.entryAt, exitAt: t.exitAt, exitCloseAt: t.exitCloseAt,
      exitType: t.exitType, lev, netPct, eqAtEntry: realized,
    });
  }
  while (exitPtr < byExit.length) {
    const e = byExit[exitPtr];
    if (e._resolved) {
      realized += e._pnlUsd;
      curve.push({ at: e.exitCloseAt, eq: Math.round(realized * 100) / 100 });
    }
    exitPtr += 1;
  }

  // 청산(봉 마감) 시간순 실현 잔고로 통계.
  const logByExit = log.slice().sort((a, b) => a.exitCloseAt - b.exitCloseAt || a.entryAt - b.entryAt);
  let eq = START;
  let peak = START;
  let mdd = 0;
  let streak = 0;
  let maxLossStreak = 0;
  const byMemberPnl = Object.fromEntries(memberKeys.map((k) => [k, 0]));
  for (const l of logByExit) {
    const pnl = (l.eqAtEntry * l.netPct) / 100;
    eq += pnl;
    l.pnlUsd = pnl;
    l.equityAfter = eq;
    byMemberPnl[l.member] += pnl;
    peak = Math.max(peak, eq);
    mdd = Math.min(mdd, (eq / peak - 1) * 100);
    streak = l.netPct > 0 ? 0 : streak + 1;
    maxLossStreak = Math.max(maxLossStreak, streak);
  }
  const final = logByExit.length ? eq : START;
  const days = (windowTo - windowFrom) / 86400_000;
  const years = days / 365.25;
  const totalReturn = (final / START - 1) * 100;
  const cagr = final > 0 ? (Math.pow(final / START, 1 / years) - 1) * 100 : -100;

  const edges = [windowFrom, windowFrom + (windowTo - windowFrom) / 3, windowFrom + (2 * (windowTo - windowFrom)) / 3, windowTo];
  const periods = edges.slice(0, -1).map((from, k) => {
    const to = edges[k + 1];
    const ts = logByExit.filter((l) => l.entryAt >= from && l.entryAt < to);
    return { n: ts.length, usd: Math.round(ts.reduce((s, l) => s + l.pnlUsd, 0) * 100) / 100 };
  });

  // 봉 단위 MDD — 보유 중 미실현 낙폭 포함(4H 종가 마킹). 거래 스냅숏 MDD는 낙관이라
  // 사전 등록 게이트는 이 보수 측정을 쓴다 (검증 에이전트 지적 반영).
  const mddBar = c4ForMdd ? barLevelMdd(logByExit, c4ForMdd, windowFrom, windowTo) : null;

  const r = (x) => Math.round(x * 100) / 100;
  const n = logByExit.length;
  return {
    stats: {
      trades: n,
      skipped,
      filteredRegime,
      winRate: n ? r((logByExit.filter((l) => l.netPct > 0).length / n) * 100) : null,
      finalEquity: r(final),
      totalReturn: r(totalReturn),
      cagr: r(cagr),
      mdd: r(mdd),
      mddBar,
      marAnnual: mdd !== 0 ? r(cagr / -mdd) : null,
      marAnnualBar: mddBar !== null && mddBar !== 0 ? r(cagr / -mddBar) : null,
      perMonth: r(n / (days / 30)),
      avgLev: n ? r(logByExit.reduce((s, l) => s + l.lev, 0) / n) : null,
      maxConcurrent,
      maxLossStreak,
      periods,
      positivePeriods: periods.filter((p) => p.n > 0 && p.usd > 0).length,
      byMemberPnl: Object.fromEntries(Object.entries(byMemberPnl).map(([k, v]) => [k, r(v)])),
    },
    curve,
    netPcts: logByExit.map((l) => l.netPct), // 부트스트랩용 — 청산 시간순 등가 % 수익열.
  };
}

/**
 * 봉 단위 MDD — 4H 종가 그리드에 실현 잔고 + 열린 포지션 미실현(수수료 제외)을 마킹.
 * 1H·1D 포지션도 4H 종가로 근사(봉 내 극값 미반영 — 여전히 실제보다는 완만할 수 있음).
 */
function barLevelMdd(trades, c4, from, to) {
  const byEntry = trades.slice().sort((a, b) => a.entryAt - b.entryAt);
  const byExit = trades.slice().sort((a, b) => a.exitCloseAt - b.exitCloseAt);
  const ms4 = TFS["4H"].ms;
  let pe = 0;
  let px = 0;
  let realized = START;
  let peak = START;
  let mdd = 0;
  const open = new Set();
  for (const b of c4) {
    const tc = b.t + ms4;
    if (tc <= from) continue;
    if (b.t >= to) break;
    while (px < byExit.length && byExit[px].exitCloseAt <= tc) {
      realized += (byExit[px].eqAtEntry * byExit[px].netPct) / 100;
      open.delete(byExit[px]);
      px += 1;
    }
    while (pe < byEntry.length && byEntry[pe].entryAt <= b.t) {
      if (byEntry[pe].exitCloseAt > tc) open.add(byEntry[pe]);
      pe += 1;
    }
    let unreal = 0;
    for (const t of open) {
      const dir = t.side === "long" ? 1 : -1;
      unreal += (t.eqAtEntry * (((b.c - t.entry) / t.entry) * dir * 100 * t.lev)) / 100;
    }
    const eq = realized + unreal;
    peak = Math.max(peak, eq);
    if (peak > 0) mdd = Math.min(mdd, (eq / peak - 1) * 100);
  }
  return Math.round(mdd * 100) / 100;
}

/* ---------- 블록 부트스트랩 — 거래열의 시계열 의존을 보존한 불확실성 ---------- */

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
}

function blockBootstrap(netPcts, iters = 1000, block = 20, seed = 20260817) {
  if (netPcts.length < block * 2) return null;
  const rnd = lcg(seed);
  const n = netPcts.length;
  const finals = [];
  const mdds = [];
  for (let it = 0; it < iters; it += 1) {
    let eq = START;
    let peak = START;
    let mdd = 0;
    let taken = 0;
    while (taken < n) {
      const start = Math.floor(rnd() * (n - block + 1));
      for (let k = 0; k < block && taken < n; k += 1, taken += 1) {
        eq *= 1 + netPcts[start + k] / 100;
        if (eq <= 0) { eq = 0; mdd = -100; break; }
        peak = Math.max(peak, eq);
        mdd = Math.min(mdd, (eq / peak - 1) * 100);
      }
      if (eq <= 0) break;
    }
    finals.push(eq);
    mdds.push(mdd);
  }
  finals.sort((a, b) => a - b);
  mdds.sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
  const r = (x) => Math.round(x * 100) / 100;
  return {
    iters,
    block,
    finalEq: { p5: r(pct(finals, 5)), p20: r(pct(finals, 20)), p50: r(pct(finals, 50)), p80: r(pct(finals, 80)), p95: r(pct(finals, 95)) },
    mdd: { p5: r(pct(mdds, 5)), p50: r(pct(mdds, 50)), p95: r(pct(mdds, 95)) },
    probLoss: r((finals.filter((f) => f < START).length / iters) * 100),
    probRuinHalf: r((finals.filter((f) => f < START / 2).length / iters) * 100),
  };
}

/* ---------- 벤치마크 · 상관 ---------- */

function buyHold(candles, from, to) {
  const inR = candles.filter((c) => c.t >= from && c.t < to);
  if (inR.length < 2) return null;
  const a = inR[0].c;
  let peak = -Infinity;
  let mdd = 0;
  for (const c of inR) {
    peak = Math.max(peak, c.h);
    mdd = Math.min(mdd, (c.l / peak - 1) * 100);
  }
  const years = (to - from) / 86400_000 / 365.25;
  const totalReturn = (inR[inR.length - 1].c / a - 1) * 100;
  const cagr = (Math.pow(inR[inR.length - 1].c / a, 1 / years) - 1) * 100;
  const r = (x) => Math.round(x * 100) / 100;
  return { totalReturn: r(totalReturn), cagr: r(cagr), mdd: r(mdd), marAnnual: r(cagr / -mdd) };
}

/** 멤버 월별 수익률(리스크 5%·솔로) 상관 — 분산이 실제로 있는지. */
function monthlyReturns(trades, risk, from, to) {
  const map = new Map();
  for (const t of trades) {
    if (t.entryAt < from || t.entryAt >= to) continue;
    const lev = Math.min(MAX_LEV, risk / (t.stopDistPct + FEE_PCT));
    const netPct = (t.grossPct - FEE_PCT) * lev;
    const key = new Date(t.exitAt + 9 * 3600_000).toISOString().slice(0, 7);
    map.set(key, (map.get(key) ?? 0) + netPct);
  }
  return map;
}

function correlation(mapA, mapB, from, to) {
  // 창 내 전체 달력 월 — 상호 무거래 달(0·0)도 관측에 포함한다 (비대칭 제외 방지).
  const keys = [];
  const d0 = new Date(from + 9 * 3600_000);
  let y = d0.getUTCFullYear();
  let m = d0.getUTCMonth();
  const end = new Date(to + 9 * 3600_000);
  while (y < end.getUTCFullYear() || (y === end.getUTCFullYear() && m <= end.getUTCMonth())) {
    keys.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    m += 1;
    if (m === 12) { m = 0; y += 1; }
  }
  if (keys.length < 6) return null;
  const a = keys.map((k) => mapA.get(k) ?? 0);
  const b = keys.map((k) => mapB.get(k) ?? 0);
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < keys.length; i += 1) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? Math.round((num / Math.sqrt(da * db)) * 100) / 100 : null;
}

/* ---------- 실행 ---------- */

function cmdRun() {
  if (!existsSync(CACHE)) {
    console.error(`캔들 캐시가 없다: ${CACHE} — 먼저 short-tf.mjs fetch 를 실행하라.`);
    process.exit(1);
  }
  const cache = JSON.parse(readFileSync(CACHE, "utf8"));
  const daily = cache.data["1D"];
  const ctxByTf = {};
  for (const tf of ["1H", "4H", "1D"]) {
    const candles = cache.data[tf];
    const closes = candles.map((c) => c.c);
    const atrArr = atr(candles);
    const atrMA100 = sma(atrArr.map((v) => v ?? 0), 100);
    for (let i = 0; i < Math.min(114, atrMA100.length); i += 1) atrMA100[i] = null;
    const { line, signal } = macd(closes);
    ctxByTf[tf] = {
      candles,
      rsi: rsi(closes),
      atr: atrArr,
      atrMA100,
      sma20: sma(closes, 20),
      sma50: sma(closes, 50),
      macdLine: line,
      macdSig: signal,
      volMA: volMA(candles),
      ll20: rollingLow(candles, 20),
      daily,
      dailySma50: sma(daily.map((c) => c.c), 50),
      dailySma200: sma(daily.map((c) => c.c), 200),
      htf1dIdx: htfIndexMap(candles, daily, 86400_000),
    };
  }

  const tradesByMember = {};
  for (const key of Object.keys(MEMBERS)) {
    tradesByMember[key] = simulateMember(key, ctxByTf);
    console.log(`${key}: ${tradesByMember[key].length}건 (${MEMBERS[key].label})`);
  }

  // 창 2개 — 전체(4H 워밍업부터)와 공통(ibq 첫 거래부터, 조합 간 공정 비교).
  const c4 = ctxByTf["4H"].candles;
  const fullFrom = c4[WARMUP["4H"]].t;
  const fullTo = c4[c4.length - 1].t + TFS["4H"].ms;
  const ibqFirst = tradesByMember.ibq[0]?.entryAt ?? fullFrom;
  const WINDOWS = [
    { key: "full", name: `전체 창 (${((fullTo - fullFrom) / 86400_000 / 365.25).toFixed(1)}년)`, from: fullFrom, to: fullTo, note: "ibq는 1H 데이터 시작(2023-08) 이후에만 참여" },
    { key: "common", name: "공통 창 (ibq 참여 이후)", from: ibqFirst, to: fullTo, note: "7개 전원이 뛸 수 있는 구간 — 조합 간 공정 비교" },
  ];

  const runs = [];
  for (const w of WINDOWS) {
    for (const subset of SUBSETS) {
      for (const overlay of OVERLAYS) {
        const riskList = overlay === "base" ? RISKS : [2, 5];
        const fundList = overlay === "base" ? [false, true] : [true];
        for (const risk of riskList) {
          for (const withFunding of fundList) {
            const res = runPortfolio(subset.members, risk, tradesByMember, w.from, w.to, withFunding, subset.cap, c4, overlay);
            runs.push({
              window: w.key,
              subset: subset.key,
              subsetName: subset.name,
              members: subset.members,
              risk,
              funding: withFunding,
              overlay,
              cap: subset.cap,
              stats: res.stats,
              curve: null, // 크기 관리 — 주 가설·대조군만 나중에 채운다.
              _curve: res.curve,
              _netPcts: res.netPcts,
            });
          }
        }
      }
    }
  }

  // 솔로 (리스크 5%·펀딩 포함·전체 창) — 기여·상관의 기준선.
  const soloCap = { maxConcurrent: 3, xRisk: 3 }; // 솔로는 상한이 사실상 무의미.
  const solos = {};
  const monthly = {};
  for (const key of Object.keys(MEMBERS)) {
    const res = runPortfolio([key], 5, tradesByMember, fullFrom, fullTo, true, soloCap, c4);
    solos[key] = res.stats;
    monthly[key] = monthlyReturns(tradesByMember[key], 5, fullFrom, fullTo);
  }
  const memberKeys = Object.keys(MEMBERS);
  const corr = memberKeys.map((a) => memberKeys.map((b) => (a === b ? 1 : correlation(monthly[a], monthly[b], fullFrom, fullTo))));

  // 주 가설 = all7·base (사전 지정 — 승자 선택의 winner's curse 회피). 게이트 표는 조합 6개 + 오버레이 4개 전부 보고.
  const eligible = runs.filter((r) => r.window === "full" && r.funding && r.risk === 5 && r.overlay === "base");
  for (const r0 of eligible) r0.bootstrap = blockBootstrap(r0._netPcts);
  // 주 가설 조합의 오버레이×리스크 격자 전체에 부트스트랩·게이트 — 셀 전부 공개(선택 편향 방지).
  const overlayRuns = runs.filter((r) => r.window === "full" && r.funding && r.subset === PRIMARY_SUBSET && [2, 5].includes(r.risk));
  for (const r0 of overlayRuns) if (!r0.bootstrap) r0.bootstrap = blockBootstrap(r0._netPcts);
  const headline = eligible.find((r) => r.subset === PRIMARY_SUBSET);
  headline.curve = headline._curve.filter((_, i, arr) => i % Math.ceil(arr.length / 240) === 0 || i === arr.length - 1);
  const quadRun = eligible.find((r) => r.subset === "quad");
  quadRun.curve = quadRun._curve.filter((_, i, arr) => i % Math.ceil(arr.length / 240) === 0 || i === arr.length - 1);

  const bench = {};
  for (const w of WINDOWS) bench[w.key] = buyHold(c4, w.from, w.to);

  // 사전 등록 판정 — MDD·MAR은 봉 단위(보수) 측정 기준.
  const gateOf = (run) => {
    const s = run.stats;
    const g = {
      marAnnualBar: { target: ">=1.0", value: s.marAnnualBar, pass: (s.marAnnualBar ?? -9) >= 1.0 },
      mddBar: { target: ">=-40%", value: s.mddBar, pass: (s.mddBar ?? -100) >= -40 },
      positivePeriods: { target: "3/3", value: s.positivePeriods, pass: s.positivePeriods === 3 },
      bootstrapP20: { target: "finalEq p20 > $100 (순차 복리 근사)", value: run.bootstrap?.finalEq.p20 ?? null, pass: (run.bootstrap?.finalEq.p20 ?? 0) > START },
      vsBench: { target: "MAR(봉) > BTC 보유", value: `${s.marAnnualBar} vs ${bench.full?.marAnnual}`, pass: (s.marAnnualBar ?? -9) > (bench.full?.marAnnual ?? 9e9) },
    };
    g.all = ["marAnnualBar", "mddBar", "positivePeriods", "bootstrapP20", "vsBench"].every((k) => g[k].pass);
    return g;
  };
  const gates = gateOf(headline);
  const gatesBySubset = Object.fromEntries(eligible.map((r0) => [r0.subset, gateOf(r0)]));
  const gatesByOverlay = Object.fromEntries(overlayRuns.map((r0) => [`${r0.overlay}-r${r0.risk}`, gateOf(r0)]));
  // 오버레이 중 게이트 전부 통과가 있으면 곡선을 남긴다 — 채택 후보 서술용.
  // 최다 게이트 통과 셀의 곡선을 남긴다 — "현재까지 최선 구성" 서술용.
  const gateCount = (g) => ["marAnnualBar", "mddBar", "positivePeriods", "bootstrapP20", "vsBench"].filter((k) => g[k].pass).length;
  const bestCell = overlayRuns.slice().sort((a, b) =>
    gateCount(gatesByOverlay[`${b.overlay}-r${b.risk}`]) - gateCount(gatesByOverlay[`${a.overlay}-r${a.risk}`]) ||
    (b.stats.marAnnualBar ?? -9) - (a.stats.marAnnualBar ?? -9))[0];
  if (bestCell && !bestCell.curve) {
    bestCell.curve = bestCell._curve.filter((_, i, arr) => i % Math.ceil(arr.length / 240) === 0 || i === arr.length - 1);
  }

  for (const r of runs) {
    delete r._curve;
    delete r._netPcts;
  }

  const result = {
    meta: {
      generatedAt: Date.now(),
      symbol: cache.symbol,
      fee: FEE_PCT,
      fundingAssumption: `롱 지불 ${FUND_LONG_PCT_PER_DAY}%/일 × 보유일 × 레버 (숏 수취 절사 — 보수)`,
      caps: Object.fromEntries(SUBSETS.map((s) => [s.key, s.cap])),
      overlays: OVERLAYS,
      maxLev: MAX_LEV,
      start: START,
      windows: WINDOWS.map(({ key, name, from, to, note }) => ({ key, name, from, to, note })),
      preRegisteredGates: "주 가설 all7 · 리스크 5% · 전체 창 · 펀딩 포함: MAR연(봉 MDD 기준) ≥1.0 · 봉 MDD ≥−40% · 3/3구간 · 부트스트랩 p20 > $100 · BTC 보유 MAR 우위. 게이트 표는 6개 조합 전부 보고(다중선택 편향 방지).",
      accounting: "진입 시점 실현 잔고 사이징 · 청산은 봉 마감 시각 기준 해제 · 같은 봉 청산 가드 · 동시 상한 강제(쿼드=라이브 2개·절대 20%, 나머지=후보 트랙 3개·3×리스크, 초과 스킵) · 미결 거래 제외. 한계: 스킵된 거래의 보유 예정 구간 내 동일 멤버 재신호는 미반영(선생성 거래열) · 거래 MDD는 청산 스냅숏(낙관)이라 게이트는 봉 단위 MDD(4H 종가 마킹, 미실현 포함) 사용 · 부트스트랩은 순차 복리 근사(동시 보유 구간에서 원 회계와 차이, 동시 손실 완화 방향) · 벤치 MDD는 고가 피크/저가 트로프 기준.",
      dataFetchedAt: cache.tfFetchedAt ?? cache.fetchedAt,
    },
    members: Object.fromEntries(Object.entries(MEMBERS).map(([k, m]) => [k, { tf: m.tf, side: m.side, exit: m.exit, label: m.label, origin: m.origin, trades: tradesByMember[k].length }])),
    subsets: SUBSETS,
    runs,
    solos,
    corr: { keys: memberKeys, matrix: corr },
    bench,
    headline: { window: headline.window, subset: headline.subset, risk: headline.risk, funding: headline.funding, primary: PRIMARY_SUBSET },
    gates,
    gatesBySubset,
    gatesByOverlay,
    bestCell: bestCell ? { subset: bestCell.subset, overlay: bestCell.overlay, risk: bestCell.risk, gatesPassed: gateCount(gatesByOverlay[`${bestCell.overlay}-r${bestCell.risk}`]) } : null,
  };

  const kstDay = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const out = join(repoRoot, "docs", "backtest", `${kstDay}-ensemble.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result));

  console.log(`\n=== 사전 등록 판정 (주 가설: ${headline.subsetName} · 리스크 ${headline.risk}% · 펀딩 포함 · 봉 MDD 기준) ===`);
  for (const [k, g] of Object.entries(gates)) {
    if (k === "all") continue;
    console.log(`  ${g.pass ? "통과" : "미달"} ${k}: ${JSON.stringify(g.value)} (기준 ${g.target})`);
  }
  console.log(`  → 종합: ${gates.all ? "전부 통과" : "미달 있음"}`);
  console.log(`\n=== 전체 창 · 펀딩 포함 · 리스크 5% ===`);
  for (const r0 of eligible) {
    const s = r0.stats;
    console.log(
      `${r0.subsetName.padEnd(14)} $${s.finalEquity} (CAGR ${s.cagr}%) MDD거래 ${s.mdd}% / 봉 ${s.mddBar}% MAR(봉) ${s.marAnnualBar} ` +
      `거래 ${s.trades}(스킵 ${s.skipped}) 구간 ${s.positivePeriods}/3 p20 $${r0.bootstrap?.finalEq.p20}`,
    );
  }
  console.log(`BTC 보유: CAGR ${bench.full?.cagr}% MDD ${bench.full?.mdd}% MAR ${bench.full?.marAnnual}`);
  console.log(`\n=== 오버레이 격자 (all7 · 전체 창 · 펀딩 포함) ===`);
  for (const r0 of overlayRuns) {
    const s = r0.stats;
    const g = gatesByOverlay[`${r0.overlay}-r${r0.risk}`];
    const passed = ["marAnnualBar", "mddBar", "positivePeriods", "bootstrapP20", "vsBench"].filter((k) => g[k].pass).length;
    console.log(
      `${r0.overlay.padEnd(9)} r${r0.risk} $${String(s.finalEquity).padEnd(7)} CAGR ${String(s.cagr).padStart(6)}% MDD봉 ${String(s.mddBar).padStart(7)}% MAR(봉) ${String(s.marAnnualBar).padStart(5)} ` +
      `구간 ${s.positivePeriods}/3 p20 $${String(r0.bootstrap?.finalEq.p20).padEnd(7)} 게이트 ${passed}/5${g.all ? " ★전부 통과" : ""}`,
    );
  }
  console.log(`저장: ${out}`);
}

function cmdReport() {
  const dir = join(repoRoot, "docs", "backtest");
  const rounds = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-ensemble\.json$/.test(f)).sort();
  if (!rounds.length) {
    console.error("종합 JSON이 없다 — 먼저 run을 실행하라.");
    process.exit(1);
  }
  const jsonName = rounds[rounds.length - 1];
  const html = readFileSync(join(repoRoot, "scripts", "backtest", "ensemble-template.html"), "utf8")
    .replace("__DATA_JSON__", readFileSync(join(dir, jsonName), "utf8"))
    .replace("__DATA_PATH__", `docs/backtest/${jsonName}`);
  const out = join(dir, "ensemble-report.html");
  writeFileSync(out, html);
  console.log(`${jsonName} → ${out}`);
}

const cmd = process.argv[2];
if (cmd === "run") cmdRun();
else if (cmd === "report") cmdReport();
else {
  console.log("사용: node scripts/backtest/ensemble.mjs <run|report>");
  process.exit(1);
}
