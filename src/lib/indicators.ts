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

/** 내림폭 평균이 0이면 나눗셈이 터진다 — 전부 올랐으면 100이다. */
function toRsi(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}
