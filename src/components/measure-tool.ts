/**
 * 측정(자) 도구의 계산부 — 트레이딩뷰의 Measure 도구와 같은 값을 낸다.
 *
 * 화면 좌표는 차트가 넘겨주고, 여기서는 두 지점 사이의 가격 변화·비율·기간만 계산한다.
 * 그래야 렌더링과 무관하게 검증할 수 있다.
 */

export interface MeasurePoint {
  /** 봉 시각(초). lightweight-charts의 UTCTimestamp와 같은 단위. */
  time: number;
  price: number;
}

export interface MeasureResult {
  /** 가격 변화(끝 − 시작) */
  priceDelta: number;
  /** 가격 변화율. 시작가가 0이면 null */
  pctDelta: number | null;
  /** 기간(밀리초). 방향과 무관하게 양수 */
  durationMs: number;
  /** 걸친 봉 개수(양 끝 포함) */
  bars: number;
  /** 위로 움직였는가 — 색을 정할 때 쓴다 */
  up: boolean;
}

export function measure(
  a: MeasurePoint,
  b: MeasurePoint,
  barSeconds: number,
): MeasureResult {
  // 드래그 방향과 무관하게 항상 '왼쪽에서 오른쪽으로'를 기준으로 삼는다.
  const [from, to] = a.time <= b.time ? [a, b] : [b, a];

  const priceDelta = to.price - from.price;
  const durationMs = (to.time - from.time) * 1000;

  return {
    priceDelta,
    pctDelta: from.price === 0 ? null : priceDelta / from.price,
    durationMs,
    bars: barSeconds > 0 ? Math.round((to.time - from.time) / barSeconds) + 1 : 1,
    up: priceDelta >= 0,
  };
}

/** `2일 3시간 20분` 처럼 큰 단위부터 두 자리만 보여 준다. */
export function formatDuration(ms: number): string {
  const total = Math.round(Math.abs(ms) / 1000);
  if (total === 0) return '0초';

  const units: [number, string][] = [
    [86400, '일'],
    [3600, '시간'],
    [60, '분'],
    [1, '초'],
  ];

  const parts: string[] = [];
  let rest = total;
  for (const [size, label] of units) {
    const value = Math.floor(rest / size);
    if (value > 0) {
      parts.push(`${value}${label}`);
      rest -= value * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}
