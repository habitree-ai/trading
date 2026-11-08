/**
 * 차트 보조지표 계산.
 *
 * 차트(복기·4분할)와 백테스트가 같은 값을 봐야 "그때 지표가 이랬다"는 말이 성립한다.
 * 그래서 계산은 화면이 아니라 여기 한 곳에 둔다.
 */

/**
 * RSI — Wilder 방식(표준).
 *
 * 첫 평균은 앞 `period`개 변화량의 단순평균, 그 뒤로는
 * `(직전평균 × (period-1) + 이번 변화량) / period` 로 굴린다.
 * 트레이딩뷰가 쓰는 방식과 같아 화면에서 본 값과 어긋나지 않는다.
 *
 * 앞 `period`개는 평균을 만들 재료가 모자라 null 이다 — 0으로 채우면
 * 차트에 가짜 과매도가 그려진다.
 */
export function rsi(closes: readonly number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gain += change;
    else loss -= change;
  }
  gain /= period;
  loss /= period;
  out[period] = toRsi(gain, loss);

  for (let i = period + 1; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = toRsi(gain, loss);
  }
  return out;
}

/**
 * 단순이동평균 — 앞 `period-1`개는 재료가 모자라 null.
 * 롤링 합으로 O(n) — 현물 스캐너가 종목마다 부르므로 반복 합산을 피한다.
 */
export function sma(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 내림폭 평균이 0이면 나눗셈이 터진다 — 전부 올랐으면 100이다. */
function toRsi(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** ATR 의 재료 — 캔들 타입에 묶이지 않게 고가·저가·종가만 받는다. */
interface Hlc {
  h: number;
  l: number;
  c: number;
}

/**
 * ATR — Wilder 방식(트레이딩뷰 `ta.atr` 과 같다).
 *
 * TR[0] = 고−저(직전 종가 없음), 이후 max(고−저, |고−전종|, |저−전종|).
 * 첫 값은 index period−1 에 TR[0..period−1] 단순평균, 이후 (전값×(p−1)+TR)/p.
 *
 * 임계점 판정(threshold/volatility)과 차트의 ATR 밴드가 같은 값을 봐야 해서 여기 둔다.
 */
export function atrWilder(candles: readonly Hlc[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (period < 1 || candles.length < period) return out;
  const tr = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const pc = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  });
  let atr = 0;
  for (let i = 0; i < period; i += 1) atr += tr[i];
  atr /= period;
  out[period - 1] = atr;
  for (let i = period; i < candles.length; i += 1) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

/** ATR 밴드의 기간 — 시스템매매 손절(진입가 ∓ k×ATR)·ATR÷비용이 쓰는 14 와 같다. */
export const ATR_BAND_PERIOD = 14;

/** 밴드로 긋는 배수 — 손절 후보 1·2·3배. */
export const ATR_BAND_MULTIPLES = [1, 2, 3] as const;

/** 한 봉의 ATR 밴드. `upper[j]`·`lower[j]` 는 넘겨준 `multiples[j]` 배다. */
export interface AtrBandPoint {
  atr: number;
  /** 기준가 — 그 봉의 종가 */
  basis: number;
  /** 종가 + k×ATR — 숏의 손절 후보 */
  upper: number[];
  /** 종가 − k×ATR — 롱의 손절 후보 */
  lower: number[];
}

/**
 * ATR 밴드 — 종가 ± k × ATR.
 *
 * "이 봉 종가에 들어갔다면 k×ATR 손절은 어디인가"를 봉마다 잇는다. 롱은 아래 밴드, 숏은
 * 위 밴드가 손절 후보다. 시스템매매 봇의 손절(진입가 ∓ sl×ATR)과 같은 정의라 차트에서 본
 * 선이 봇이 거는 자리와 같다. 꼬리가 1배 밴드를 수시로 뚫는 구간이면 1배 손절은 잡음에 털린다.
 *
 * ATR 이 아직 없는 앞 period−1 봉은 null — 0으로 채우면 밴드가 종가에 붙어 그려진다.
 */
export function atrBands(
  candles: readonly Hlc[],
  multiples: readonly number[] = ATR_BAND_MULTIPLES,
  period: number = ATR_BAND_PERIOD,
): (AtrBandPoint | null)[] {
  const atr = atrWilder(candles, period);
  return candles.map((c, i) => {
    const a = atr[i];
    if (a === null) return null;
    return {
      atr: a,
      basis: c.c,
      upper: multiples.map((k) => c.c + k * a),
      lower: multiples.map((k) => c.c - k * a),
    };
  });
}

/**
 * 손절폭이 ATR 의 몇 배인가 — |진입가 − 손절가| ÷ ATR.
 *
 * 1 아래면 그 봉의 평소 흔들림 안에 손절을 둔 것이다 — 방향을 본 봉의 ATR 바깥에 손절이
 * 있어야 한다는 기준(domain `timeframe_bias`)을 숫자로 읽는 자리. 재료가 비거나 ATR 이 0 이하면 null.
 */
export function stopAtrMultiple(
  entry: number | null,
  stop: number | null,
  atr: number | null,
): number | null {
  if (entry === null || stop === null || atr === null) return null;
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !(atr > 0)) return null;
  return Math.abs(entry - stop) / atr;
}
