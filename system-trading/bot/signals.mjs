/**
 * 신호 판정 — 백테스트와 같은 부등식, 같은 시점(마감 봉) 기준.
 *
 * ctx 는 마감 봉만으로 만든다(미확정 봉이 섞이면 백테스트와 다른 것을 거래하게 된다).
 * 판정은 배열의 마지막 인덱스(가장 최근 마감 봉)에서 한다.
 */
import { atr, rollingLow, rsi, sma } from "./indicators.mjs";

/** 마감 캔들 배열로 판정 컨텍스트를 만든다. */
export function buildCtx(candles) {
  const closes = candles.map((c) => c.c);
  return {
    candles,
    rsi: rsi(closes),
    atr: atr(candles),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    ll20: rollingLow(candles, 20),
  };
}

/** 각 기준의 판정 함수 — i는 마감 봉 인덱스. 값이 없으면(false) 신호도 없다. */
export const SIGNALS = {
  gc: {
    rule: "SMA20이 SMA50을 상향 돌파 마감",
    fire: (i, c) =>
      c.sma20[i - 1] !== null &&
      c.sma50[i - 1] !== null &&
      c.sma20[i - 1] <= c.sma50[i - 1] &&
      c.sma20[i] > c.sma50[i],
  },
  ob: {
    rule: "RSI(14)가 30 아래로 갔다가 30 위로 복귀 마감",
    fire: (i, c) => c.rsi[i - 1] !== null && c.rsi[i - 1] < 30 && c.rsi[i] >= 30,
  },
  fade: {
    rule: "RSI(14)가 70 위로 갔다가 70 아래로 복귀 마감",
    fire: (i, c) => c.rsi[i - 1] !== null && c.rsi[i - 1] > 70 && c.rsi[i] <= 70,
  },
  dc: {
    rule: "종가가 직전 20봉 최저가 아래로 마감",
    fire: (i, c) => c.ll20[i] !== null && c.candles[i].c < c.ll20[i],
  },
};

/** 판정 시점의 지표 스냅샷 — decisions.jsonl 에 남겨 고도화 재료로 쓴다. */
export function snapshot(i, c) {
  const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
  return {
    close: c.candles[i].c,
    rsi: r1(c.rsi[i]),
    atr: r1(c.atr[i]),
    sma20: r1(c.sma20[i]),
    sma50: r1(c.sma50[i]),
    ll20: r1(c.ll20[i]),
  };
}

/** 손절·목표 가격 — 백테스트와 같은 산식. entry 기준. */
export function exitLevels(entry, side, exit, atrAtSignal) {
  const dir = side === "long" ? 1 : -1;
  const slDist = exit.type === "atr" ? exit.sl * atrAtSignal : (entry * exit.sl) / 100;
  const tpDist = exit.type === "atr" ? exit.tp * atrAtSignal : (entry * exit.tp) / 100;
  return {
    stop: entry - dir * slDist,
    target: entry + dir * tpDist,
    stopDistPct: (slDist / entry) * 100,
  };
}
