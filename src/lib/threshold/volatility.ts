/**
 * 임계점 ① 변동성 팽창 — 압축(스퀴즈) 뒤 밴드 이탈을 판정한다(REQ-0102).
 *
 * 순수 함수만 둔다. 봉은 "마감된 봉"만 받는다 — 진행 중인 봉을 넣으면
 * 종가가 밴드 밖이었다가 돌아오는 가짜 켜짐이 생긴다.
 */

import { atrWilder, sma } from "@/lib/indicators";
import type { Candle } from "@/lib/okx";

import { THRESHOLD_RULES, type SignalState, type SignalTf, type VolatilityTf } from "./types";

type Hlc = Pick<Candle, "h" | "l" | "c">;

/**
 * ATR — 차트의 ATR 밴드와 같은 값을 봐야 해서 계산은 `@/lib/indicators` 로 옮겼다.
 * 이 모듈에서 가져다 쓰던 자리가 그대로 동작하도록 다시 내보낸다.
 */
export { atrWilder };

export interface Band {
  mid: number;
  upper: number;
  lower: number;
  /** (upper − lower) ÷ mid — k=2 이면 4σ/SMA */
  width: number;
}

/** 볼린저 밴드 — 모표준편차(트레이딩뷰와 같음). 재료 부족·mid 0 이면 null. */
export function bollinger(closes: readonly number[], period: number, k: number): (Band | null)[] {
  const mids = sma(closes, period);
  return mids.map((mid, i) => {
    if (mid === null || mid === 0) return null;
    let ss = 0;
    for (let j = i - period + 1; j <= i; j += 1) ss += (closes[j] - mid) ** 2;
    const sd = Math.sqrt(ss / period);
    const upper = mid + k * sd;
    const lower = mid - k * sd;
    return { mid, upper, lower, width: (upper - lower) / mid };
  });
}

/** 켈트너 채널 — 중심은 종가 SMA(볼린저와 같은 중심), 폭은 mult × ATR(atrPeriod). */
export function keltner(
  candles: readonly Hlc[],
  period: number,
  atrPeriod: number,
  mult: number,
): (Band | null)[] {
  const mids = sma(
    candles.map((c) => c.c),
    period,
  );
  const atr = atrWilder(candles, atrPeriod);
  return mids.map((mid, i) => {
    const a = atr[i];
    if (mid === null || a === null || mid === 0) return null;
    const upper = mid + mult * a;
    const lower = mid - mult * a;
    return { mid, upper, lower, width: (upper - lower) / mid };
  });
}

/**
 * 백분위 — i 직전 lookback 개 값 중 series[i] 보다 작았던(좁았던) 비율(0~1).
 * 창 안에 null 이 하나라도 있으면 null(모자란 표본으로 0% 를 만들지 않는다).
 */
export function percentileRank(
  series: readonly (number | null)[],
  i: number,
  lookback: number,
): number | null {
  const cur = series[i];
  if (cur === null || cur === undefined || lookback < 1 || i - lookback < 0) return null;
  let below = 0;
  for (let j = i - lookback; j < i; j += 1) {
    const v = series[j];
    if (v === null || v === undefined) return null;
    if (v < cur) below += 1;
  }
  return below / lookback;
}

const R = THRESHOLD_RULES;

/** 판정에 필요한 최소 봉 수 — BB폭(20) + 백분위(120) + 직전 압축 확인(10) */
export const VOL_MIN_BARS = R.bbPeriod + R.bbwLookback + R.squeezeLookback;

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/**
 * 한 TF 의 변동성 상태.
 * 압축 = BB폭 백분위 ≤ 20% 또는 BB 가 켈트너 안.
 * 켜짐 = 직전 10봉 안 압축 + ATR(5)/ATR(50) ≥ 1.3 + BB폭 3봉 연속 확대 + 종가가 상단 밖(롱)/하단 밖(숏).
 * 롱·숏 동시 켜짐은 불가 — 종가가 상단 위이면서 하단 아래일 수 없다(upper ≥ lower).
 * 경고 = ATR비 ≥ 2.0 또는 BB폭 백분위 ≥ 95% (방향 무관).
 * roundTripCostPct 는 소수(0.001 = 0.1%).
 */
export function volatilityState(
  candles: readonly Candle[],
  tf: SignalTf,
  roundTripCostPct: number,
): VolatilityTf {
  const n = candles.length;
  const lastClosedMs = n > 0 ? candles[n - 1].t : 0;

  if (n < VOL_MIN_BARS) {
    const state: SignalState = {
      on: null,
      warn: false,
      measured: false,
      reasons: [`봉 부족(${n}/${VOL_MIN_BARS})`],
    };
    return {
      tf,
      lastClosedMs,
      bbwPct: null,
      atrRatio: null,
      squeezeWithin10: false,
      squeezeNow: false,
      bbwExpanding3: false,
      closeOutside: null,
      atrOverCost: null,
      label: "측정 불가",
      state,
    };
  }

  const closes = candles.map((c) => c.c);
  const bb = bollinger(closes, R.bbPeriod, R.bbStd);
  const kc = keltner(candles, R.bbPeriod, R.keltnerAtr, R.keltnerMult);
  const widths = bb.map((b) => (b ? b.width : null));
  const atrF = atrWilder(candles, R.atrFast);
  const atrS = atrWilder(candles, R.atrSlow);
  const atr14 = atrWilder(candles, 14);

  const inKeltner = (i: number) => {
    const b = bb[i];
    const k = kc[i];
    return b !== null && k !== null && b.upper <= k.upper && b.lower >= k.lower;
  };
  const compressed = (i: number) => {
    const p = percentileRank(widths, i, R.bbwLookback);
    return (p !== null && p <= R.bbwSqueezePct) || inKeltner(i);
  };

  const i = n - 1;
  const close = closes[i];
  const band = bb[i];
  const bbwPct = percentileRank(widths, i, R.bbwLookback);
  const fast = atrF[i];
  const slow = atrS[i];
  const atrRatio = fast !== null && slow !== null && slow > 0 ? fast / slow : null;
  const a14 = atr14[i];
  const atrOverCost =
    a14 !== null && roundTripCostPct > 0 && close > 0 ? a14 / (close * roundTripCostPct) : null;

  // "직전" 10봉 = 현재 봉 제외 i−10..i−1
  let squeezeWithin10 = false;
  for (let j = i - R.squeezeLookback; j < i; j += 1) {
    if (compressed(j)) {
      squeezeWithin10 = true;
      break;
    }
  }
  const squeezeNow = inKeltner(i);
  const compressNow = compressed(i);

  let bbwExpanding3 = true;
  for (let j = i - R.bbwExpandBars + 1; j <= i; j += 1) {
    const w = widths[j];
    const prev = widths[j - 1];
    if (w === null || prev === null || !(w > prev)) {
      bbwExpanding3 = false;
      break;
    }
  }

  const closeOutside: VolatilityTf["closeOutside"] =
    band === null ? null : close > band.upper ? "upper" : close < band.lower ? "lower" : null;

  const measured = bbwPct !== null && atrRatio !== null && band !== null;
  const reasons: string[] = [];
  if (!measured) reasons.push("지표 계산 불가(값 부족)");

  const ratioOn = atrRatio !== null && atrRatio >= R.atrRatioOn;
  const core = squeezeWithin10 && ratioOn && bbwExpanding3;
  const on = !measured || !core ? null : closeOutside === "upper" ? "long" : closeOutside === "lower" ? "short" : null;

  const warnRatio = atrRatio !== null && atrRatio >= R.atrRatioWarn;
  const warnBbw = bbwPct !== null && bbwPct >= R.bbwWarnPct;
  const warn = measured && (warnRatio || warnBbw);

  if (measured) {
    reasons.push(
      `BB폭 백분위 ${pct(bbwPct)}, ATR비 ${atrRatio.toFixed(2)}`,
      squeezeWithin10 ? "직전 10봉 안 압축 있음" : "직전 10봉 안 압축 없음",
      bbwExpanding3 ? "BB폭 3봉 연속 확대" : "BB폭 3봉 확대 아님",
      closeOutside === "upper" ? "종가 상단 밖" : closeOutside === "lower" ? "종가 하단 밖" : "종가 밴드 안",
    );
    if (on) reasons.push(on === "long" ? "켜짐: 롱(상단 이탈)" : "켜짐: 숏(하단 이탈)");
    if (warnRatio) reasons.push(`경고: ATR비 ≥ ${R.atrRatioWarn}`);
    if (warnBbw) reasons.push(`경고: BB폭 백분위 ≥ ${pct(R.bbwWarnPct)}`);
  }

  const label = !measured
    ? "측정 불가"
    : compressNow
      ? "압축"
      : warn
        ? "과열(팽창 끝물)"
        : ratioOn
          ? "팽창 중"
          : "보통";

  return {
    tf,
    lastClosedMs,
    bbwPct,
    atrRatio,
    squeezeWithin10,
    squeezeNow,
    bbwExpanding3,
    closeOutside,
    atrOverCost,
    label,
    state: { on, warn, measured, reasons },
  };
}
