import { describe, expect, it } from 'vitest';

import { atrPercent, stopAtrMultiple } from '@/lib/atr';
import { type Candle } from '@/lib/okx';

/** 고저폭이 일정한 봉 — TR 이 매번 `range` 로 같아 ATR 도 `range` 가 된다. */
function flatCandles(count: number, close: number, range: number): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    t: i * 60_000,
    o: close,
    h: close + range / 2,
    l: close - range / 2,
    c: close,
    v: 0,
  }));
}

describe('atrPercent', () => {
  it('봉이 기간+1 개 미만이면 null — 모자란 표본으로 배수를 보여 주면 안 된다', () => {
    expect(atrPercent(flatCandles(14, 100, 1))).toBeNull();
    expect(atrPercent(flatCandles(15, 100, 1))).not.toBeNull();
  });

  it('고저폭이 일정하면 ATR 은 그 폭이고, 종가 대비 %로 나온다', () => {
    // 종가 100, 고저폭 2 → ATR 2 → 2%
    expect(atrPercent(flatCandles(30, 100, 2))).toBeCloseTo(2, 6);
  });

  it('갭을 흔들림에 넣는다 — 전봉 종가에서 멀어진 봉은 고저폭보다 큰 TR 을 갖는다', () => {
    const base = flatCandles(20, 100, 1);
    // 마지막 봉을 통째로 위로 띄운다: 고저폭은 1 이지만 전봉 종가(100)까지는 10 이 넘는다.
    const gapped = [...base.slice(0, -1), { ...base[base.length - 1], h: 111, l: 110, c: 110 }];
    const flat = atrPercent(base);
    const withGap = atrPercent(gapped);
    expect(flat).not.toBeNull();
    expect(withGap).not.toBeNull();
    expect(withGap as number).toBeGreaterThan(flat as number);
  });
});

describe('stopAtrMultiple', () => {
  it('손절 폭을 ATR 로 나눈 배수 — 2% 손절에 ATR 1% 면 2.0 ATR', () => {
    expect(stopAtrMultiple(100, 98, 1)).toBeCloseTo(2, 6);
  });

  it('방향을 가리지 않는다 — 숏의 위쪽 손절도 같은 배수', () => {
    expect(stopAtrMultiple(100, 102, 1)).toBeCloseTo(2, 6);
  });

  it('값이 비었거나 0 이하이면 null — 빈 칸에 배수를 지어내지 않는다', () => {
    expect(stopAtrMultiple(null, 98, 1)).toBeNull();
    expect(stopAtrMultiple(100, null, 1)).toBeNull();
    expect(stopAtrMultiple(100, 98, null)).toBeNull();
    expect(stopAtrMultiple(100, 100, 1)).toBeNull();
    expect(stopAtrMultiple(0, 98, 1)).toBeNull();
  });
});
