/**
 * 부품 13종 — 복리 층이 위에 얹힐 거래 스트림.
 *
 * 두 갈래에서 가져온다.
 *  ① 검증 계보 11종 — 8~12회차에서 이미 게이트를 통과했거나 후보로 남은 것.
 *    신호 부등식은 criteria.md · ensemble.mjs 와 **글자 그대로** 같다. 여기서 손대면
 *    이번 회차가 "부품을 다시 고른 회차"가 되어 버린다. 부품은 고정, 변수는 자금 층뿐이다.
 *  ② 13회차 러너 2종 — 목표가 없는 비대칭 설계. 손익비 축을 넓히려고 넣는다.
 *    진입은 인샘플 최고 조합이 아니라 **사전에 지목된 것**을 쓴다(인사이드바 = 3회차 생존,
 *    돈치안 = 터틀 정통). 최고 조합을 쓰면 그것이 곧 선별 편향이다.
 *
 * 청산은 walkAsym 하나로 통일한다. ATR 배수든 고정 %든 N만 바꾸면 같은 함수다:
 *   ATR 청산 {sl:1, tp:3} → N = atr[i],            plan {initSl:1, tp:3}
 *   % 청산   {sl:2, tp:4} → N = entry × 0.02,      plan {initSl:1, tp:2}
 * 덕분에 13부품이 전부 같은 회계로 slPct · maePct · mfePct 를 남긴다 — 복리 층이
 * 부품마다 다른 규약을 상대하지 않아도 된다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ta from "../../lib/indicators.mjs";
import { LAB, TFS } from "../../lib/data.mjs";
import { walkAsym } from "../../asym/lib/asym-engine.mjs";

const SPOT_PATH = join(LAB, "..", "scripts", "backtest", ".cache", "spot-candles.json");
/** 봉별 워밍업 — 앙상블 회차(ensemble.mjs)와 같은 값. 다르게 두면 거래 수가 어긋난다. */
export const WARMUP = { "15m": 300, "1H": 260, "4H": 220, "1D": 220 };
export const COST = { fee: 0.1, slip: 0.02 };

/** 베이시스 z — ensemble.mjs 와 동일 수식. 창 안 유효값 90% 미만이면 null. */
function rollingZSkip(vals, win) {
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  let sq = 0;
  let valid = 0;
  for (let i = 0; i < vals.length; i += 1) {
    const v = vals[i];
    if (v !== null) { sum += v; sq += v * v; valid += 1; }
    const j = i - win;
    if (j >= 0 && vals[j] !== null) { sum -= vals[j]; sq -= vals[j] * vals[j]; valid -= 1; }
    if (i >= win - 1 && valid >= win * 0.9 && vals[i] !== null) {
      const mean = sum / valid;
      const sd = Math.sqrt(Math.max(0, sq / valid - mean * mean));
      out[i] = sd > 0 ? (vals[i] - mean) / sd : null;
    }
  }
  return out;
}

/** 부품이 필요로 하는 것만 계산한다 — 31계열 전부 굽던 buildContext 와 별개다. */
export function buildPartContext(data) {
  const spot = JSON.parse(readFileSync(SPOT_PATH, "utf8"));
  const ctx = {};
  for (const tf of ["15m", "1H", "4H", "1D"]) {
    const candles = data[tf];
    if (!candles?.length) continue;
    const closes = candles.map((b) => b.c);
    const md = ta.macd(closes);
    const atr14 = ta.atr(candles, 14);
    const c = {
      candles,
      n: candles.length,
      atr: atr14,
      atrMA100: ta.sma(atr14.map((v) => v ?? 0), 100),
      sma20: ta.sma(closes, 20),
      sma50: ta.sma(closes, 50),
      sma200: ta.sma(closes, 200),
      rsi: ta.rsi(closes, 14),
      macdLine: md.line,
      macdSig: md.signal,
      volMA: ta.sma(candles.map((b) => b.v), 20),
      ll20: ta.rollingExtreme(candles.map((b) => b.l), 20, false),
      hh10: ta.rollingExtreme(candles.map((b) => b.h), 10, true),
      dcHigh20: ta.rollingExtreme(candles.map((b) => b.h), 20, true),
      // 러너 추적손절이 참조하는 배열 — 전부 현재 봉 제외 극값.
      atrN: ta.atr(candles, 22),
      chHigh: ta.rollingExtreme(candles.map((b) => b.h), 22, true),
      chLow: ta.rollingExtreme(candles.map((b) => b.l), 22, false),
      dcLow10: ta.rollingExtreme(candles.map((b) => b.l), 10, false),
    };
    ctx[tf] = c;
  }
  // 일봉 정합 필터 — 하위봉 i 에서 마감 완료된 최신 일봉만 본다.
  const daily = data["1D"];
  const dClose = daily.map((b) => b.c);
  const dSma50 = ta.sma(dClose, 50);
  for (const tf of ["1H", "4H", "1D"]) {
    if (!ctx[tf]) continue;
    const map = ta.htfIndexMap(ctx[tf].candles, daily, 86_400_000);
    ctx[tf].daily = daily;
    ctx[tf].dailySma50 = dSma50;
    ctx[tf].htf1dIdx = map;
  }
  // 베이시스(4H) — 같은 봉 시각의 현물 종가 대비 괴리 %, z 창 30일 = 180봉.
  const spot4 = spot.data?.["4H"];
  if (!spot4?.length) throw new Error("현물 캔들 없음 — 베이시스 부품을 만들 수 없다: " + SPOT_PATH);
  const spotByT = new Map(spot4.map((b) => [b.t, b.c]));
  const basis = ctx["4H"].candles.map((b) => {
    const s = spotByT.get(b.t);
    return s ? Math.round((b.c / s - 1) * 1e6) / 1e4 : null;
  });
  ctx["4H"].basis = basis;
  ctx["4H"].basisZ = rollingZSkip(basis, 180);
  ctx.basisCoverage = basis.filter((v) => v !== null).length / basis.length;
  return ctx;
}

/* ---------- 신호 — ensemble.mjs / criteria.md 와 같은 부등식 ---------- */
const SIG = {
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
    i >= 2 && c.candles[i - 1].h < c.candles[i - 2].h && c.candles[i - 1].l > c.candles[i - 2].l &&
    c.candles[i].c > c.candles[i - 2].h && c.atr[i] !== null && c.atrMA100[i] !== null && c.atr[i] < c.atrMA100[i],
  ib4: (i, c) =>
    i >= 2 && c.candles[i - 1].h < c.candles[i - 2].h && c.candles[i - 1].l > c.candles[i - 2].l &&
    c.candles[i].c > c.candles[i - 2].h,
  mp1: (i, c) => {
    if (c.sma200[i] === null || !(c.sma20[i] > c.sma50[i]) || !(c.candles[i].c > c.sma200[i])) return false;
    if (!(c.candles[i].l <= c.sma20[i] && c.candles[i].c > c.sma20[i])) return false;
    const d = c.htf1dIdx[i];
    return d >= 0 && c.dailySma50[d] !== null && c.daily[d].c > c.dailySma50[d];
  },
  rf1: (i, c) => {
    if (c.rsi[i - 1] === null || !(c.rsi[i - 1] > 70 && c.rsi[i] <= 70)) return false;
    const d = c.htf1dIdx[i];
    return d >= 0 && c.dailySma50[d] !== null && c.daily[d].c < c.dailySma50[d];
  },
  bzc: (i, c) => c.basisZ?.[i - 1] !== null && c.basisZ?.[i] !== null && c.basisZ[i - 1] <= -2 && c.basisZ[i] > -2,
  bzf: (i, c) => c.basisZ?.[i - 1] !== null && c.basisZ?.[i] !== null && c.basisZ[i - 1] >= 2 && c.basisZ[i] < 2,
  // 러너용 진입 — 사전 지목분. 인사이드바는 3회차 생존, 돈치안 돌파는 터틀 정통.
  ibRunner: (i, c) =>
    i >= 2 && c.candles[i - 1].h < c.candles[i - 2].h && c.candles[i - 1].l > c.candles[i - 2].l &&
    c.candles[i].c > c.candles[i - 2].h,
  dcRunner: (i, c) => c.dcHigh20[i] !== null && c.candles[i].c > c.dcHigh20[i],
};

/** 고정 기하 청산 — walkAsym 의 plan 으로 번역. */
const geo = (sl, tp) => ({ initSl: 1, tp: tp / sl, trail: null, trailArmR: 0, beArmR: null, partial: null, timeCut: null, pyramid: null });
/** 13회차 러너 — 목표가 없음. */
const PLAN_R5 = { initSl: 1.5, tp: null, trail: { type: "chandelier", mult: 3 }, trailArmR: 2, beArmR: 1, partial: null, timeCut: null, pyramid: null };
const PLAN_R1 = { initSl: 1.5, tp: null, trail: { type: "chandelier", mult: 3 }, trailArmR: 0, beArmR: null, partial: null, timeCut: null, pyramid: null };

export const PARTS = [
  { key: "gc", label: "골든크로스", tf: "4H", side: "long", sig: "gc", exit: { type: "atr", sl: 1, tp: 3 }, origin: "쿼드(라이브)", lens: "추세" },
  { key: "ob", label: "RSI 과매도 반등", tf: "4H", side: "long", sig: "ob", exit: { type: "atr", sl: 1, tp: 3 }, origin: "쿼드(라이브)", lens: "평균회귀" },
  { key: "fade", label: "RSI 과매수 반락", tf: "4H", side: "short", sig: "fade", exit: { type: "atr", sl: 2, tp: 4 }, origin: "쿼드(라이브)", lens: "평균회귀" },
  { key: "dc", label: "20봉 신저가 이탈", tf: "1D", side: "short", sig: "dc", exit: { type: "pct", sl: 2, tp: 4 }, origin: "쿼드(라이브)", lens: "추세" },
  { key: "dch", label: "신저가 숏+일봉 하락", tf: "4H", side: "short", sig: "dch", exit: { type: "atr", sl: 1, tp: 3 }, origin: "후보(페이퍼)", lens: "추세+정합" },
  { key: "mcv", label: "MACD+거래량", tf: "4H", side: "long", sig: "mcv", exit: { type: "atr", sl: 1, tp: 1 }, origin: "후보(페이퍼)", lens: "추세+참여" },
  { key: "ibq", label: "인사이드바+저변동", tf: "1H", side: "long", sig: "ibq", exit: { type: "atr", sl: 2, tp: 6 }, origin: "후보(페이퍼)", lens: "수축→확장" },
  { key: "ib4", label: "인사이드바 무필터", tf: "1H", side: "long", sig: "ib4", exit: { type: "atr", sl: 3, tp: 9 }, origin: "주5회 회차", lens: "수축→확장" },
  { key: "mp1", label: "MA눌림+일봉상승", tf: "1H", side: "long", sig: "mp1", exit: { type: "atr", sl: 2, tp: 6 }, origin: "주5회 회차", lens: "추세 되돌림" },
  { key: "rf1", label: "RSI반락 숏+일봉하락", tf: "1H", side: "short", sig: "rf1", exit: { type: "atr", sl: 3, tp: 9 }, origin: "주5회 회차", lens: "평균회귀+정합" },
  { key: "bzc", label: "베이시스 공포 복귀", tf: "4H", side: "long", sig: "bzc", exit: { type: "atr", sl: 2, tp: 6 }, origin: "베이시스 회차 ★", lens: "포지셔닝" },
  { key: "bzf", label: "베이시스 과열 복귀", tf: "4H", side: "short", sig: "bzf", exit: { type: "atr", sl: 2, tp: 6 }, origin: "베이시스 회차", lens: "포지셔닝" },
  { key: "r5", label: "인사이드바 2단 래칫 러너", tf: "4H", side: "long", sig: "ibRunner", plan: PLAN_R5, origin: "13회차 1순위", lens: "비대칭 러너", maxHold: 540 },
  { key: "r1", label: "돈치안 샹들리에 러너", tf: "4H", side: "long", sig: "dcRunner", plan: PLAN_R1, origin: "13회차 2순위", lens: "비대칭 러너", maxHold: 540 },
];

/** 부품 하나 → 거래 배열. 신호 봉 i 마감 → 진입 i+1 시가(기존 규약). */
/**
 * @param cost 비용 오버라이드. 기본값은 이 랩의 표준(테이커 0.10 + 슬리피지 0.02).
 *             체결 스트레스 회차가 슬리피지를 올려 부르는 자리다 — 기본값은 그대로라
 *             14회차 산출물은 바뀌지 않는다.
 */
export function runPart(part, ctx, fundingCum, cost = COST) {
  const c = ctx[part.tf];
  const candles = c.candles;
  const dir = part.side === "long" ? 1 : -1;
  const fn = SIG[part.sig];
  const maxHold = part.maxHold ?? TFS[part.tf].maxHold;
  const plan = part.plan ?? geo(part.exit.sl, part.exit.tp);
  const ext = { atrN: c.atrN, chHigh: c.chHigh, chLow: c.chLow, dcHigh: c.dcHigh20, dcLow: c.dcLow10 };

  const trades = [];
  let openUntil = -1;
  const warm = WARMUP[part.tf] ?? 260;
  for (let i = warm; i < candles.length - 1; i += 1) {
    // i < openUntil 이다(<= 가 아니라). 청산 봉에 뜬 신호는 진입이 그 다음 봉 시가이므로
    // 겹치지 않는다 — ensemble.mjs 와 같은 규약. lib/engine.mjs 는 <= 라 한 봉 더 보수적인데,
    // 그 차이가 dch 에서 거래 24건을 갈랐다. 여기서는 재현 대상 쪽에 맞춘다.
    if (i < openUntil) continue;
    if (c.atr[i] === null) continue;
    if (!fn(i, c)) continue;
    const entryIdx = i + 1;
    const entry = candles[entryIdx].o;
    if (!(entry > 0)) continue;
    // N = 1R 의 가격 폭. 여기서 ATR 청산과 % 청산이 하나로 합쳐진다.
    const N = part.plan ? c.atr[i] : (part.exit.type === "pct" ? (entry * part.exit.sl) / 100 : c.atr[i] * part.exit.sl);
    if (!(N > 0)) continue;
    const r = walkAsym(candles, ext, entryIdx, entry, part.side, plan, N, maxHold);
    if (!r || r.exitType === "open") continue;
    const fund = fundingCum ? fundingCum(candles[entryIdx].t, candles[r.exitIdx].t) : 0;
    const fundCost = part.side === "long" ? fund : -fund;
    const net = r.grossPct - cost.fee - cost.slip - fundCost;
    trades.push({
      part: part.key,
      side: part.side,
      entryAt: candles[entryIdx].t,
      exitAt: candles[r.exitIdx].t,
      entry: Math.round(entry * 100) / 100,
      exit: Math.round(r.exitPrice * 100) / 100,
      exitType: r.exitType,
      holdBars: r.exitIdx - entryIdx + 1,
      slPct: Math.round(r.slDistPct * 1e4) / 1e4,
      maePct: Math.round(r.maePct * 1e4) / 1e4,
      mfePct: Math.round(r.mfePct * 1e4) / 1e4,
      grossPct: Math.round(r.grossPct * 1e4) / 1e4,
      net: Math.round(net * 1e4) / 1e4,
      dir,
    });
    openUntil = r.exitIdx;
  }
  return trades;
}

/** 부품 묶음 — 리포트에서 "다양한 시스템"의 축이 된다. */
export const SETS = [
  { key: "quad", name: "쿼드 (현행 라이브)", parts: ["gc", "ob", "fade", "dc"], why: "지금 돌고 있는 구성 — 대조군" },
  { key: "lineage7", name: "검증 계보 7", parts: ["gc", "ob", "fade", "dc", "dch", "mcv", "ibq"], why: "11회차 앙상블의 주 가설 구성" },
  { key: "basis3", name: "베이시스 3", parts: ["bzc", "bzf", "ib4"], why: "가격 밖 신호 + 가격 신호 — 상관이 가장 낮은 조합" },
  { key: "runner2", name: "러너 2", parts: ["r5", "r1"], why: "13회차 비대칭 설계만 — 손익비 축의 반대편" },
  { key: "mix9", name: "혼합 9", parts: ["gc", "ob", "fade", "dch", "ibq", "ib4", "bzc", "bzf", "r5"], why: "승률·손익비·렌즈를 고루 섞은 최대 분산" },
  { key: "all14", name: "전체 14", parts: PARTS.map((p) => p.key), why: "선별 없음 — 상한 아닌 기준선" },
];
