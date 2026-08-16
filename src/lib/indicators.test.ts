import { describe, expect, it } from 'vitest';

import { rsi } from '@/lib/indicators';

describe('rsi — Wilder 방식', () => {
  it('앞 period개는 재료가 모자라 null', () => {
    const r = rsi([1, 2, 3, 4, 5], 3);
    expect(r.slice(0, 3)).toEqual([null, null, null]);
    expect(r[3]).not.toBeNull();
  });

  it('내내 오르면 100, 내내 내리면 0', () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(rsi(up)[19]).toBe(100);
    expect(rsi(down)[19]).toBe(0);
  });

  it('표준 예제 값과 맞는다 — Wilder 14기간 참조 수열', () => {
    // StockCharts RSI 예제 데이터. 첫 RSI ≈ 70.53, 마지막 ≈ 37.77.
    const closes = [
      44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245,
      45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028,
      46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515,
      45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628,
      43.1314,
    ];
    const r = rsi(closes);
    expect(r[14]).toBeCloseTo(70.53, 1);
    expect(r[32]).toBeCloseTo(37.77, 1);
  });
});
