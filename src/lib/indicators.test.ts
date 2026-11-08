import { describe, expect, it } from 'vitest';

import {
  ATR_BAND_MULTIPLES,
  ATR_BAND_PERIOD,
  atrBands,
  atrWilder,
  rsi,
  stopAtrMultiple,
} from '@/lib/indicators';

const hlc = (h: number, l: number, c: number) => ({ h, l, c });

describe('atrBands — 종가 ± k×ATR', () => {
  // TR: 2, 3, 1, 3 → ATR(3): [null, null, 2, 7/3] (atrWilder 손계산과 같은 수열)
  const cs = [hlc(10, 8, 9), hlc(12, 10, 11), hlc(11.5, 10.5, 11), hlc(14, 12, 13)];

  it('ATR 이 없는 앞 period−1 봉은 null — 종가에 붙은 가짜 밴드를 긋지 않는다', () => {
    const b = atrBands(cs, ATR_BAND_MULTIPLES, 3);
    expect(b[0]).toBeNull();
    expect(b[1]).toBeNull();
    expect(b[2]).not.toBeNull();
  });

  it('배수마다 종가 위아래로 k×ATR — 기본 배수는 1·2·3', () => {
    const b = atrBands(cs, ATR_BAND_MULTIPLES, 3)[3];
    const atr = 7 / 3;
    expect(b?.atr).toBeCloseTo(atr, 10);
    expect(b?.basis).toBe(13);
    expect(b?.upper.map((v) => +v.toFixed(10))).toEqual([13 + atr, 13 + 2 * atr, 13 + 3 * atr].map((v) => +v.toFixed(10)));
    expect(b?.lower.map((v) => +v.toFixed(10))).toEqual([13 - atr, 13 - 2 * atr, 13 - 3 * atr].map((v) => +v.toFixed(10)));
  });

  it('배수는 넘긴 순서 그대로 — 고른 것만 계산한다', () => {
    const b = atrBands(cs, [1.5], 3)[2];
    expect(b?.upper).toEqual([11 + 1.5 * 2]);
    expect(b?.lower).toEqual([11 - 1.5 * 2]);
  });

  it('기본 기간은 14 — ATR·시스템매매 손절과 같은 값', () => {
    const flat = Array.from({ length: ATR_BAND_PERIOD }, () => hlc(101, 99, 100));
    const b = atrBands(flat);
    expect(ATR_BAND_PERIOD).toBe(14);
    expect(b[ATR_BAND_PERIOD - 2]).toBeNull();
    expect(b[ATR_BAND_PERIOD - 1]?.lower).toEqual([98, 96, 94]);
  });

  it('지난 봉만 쓴다 — 뒤 봉을 잘라도 앞 값이 같다(복기에서 미래가 새지 않는다)', () => {
    const series = Array.from({ length: 60 }, (_, i) => {
      const c = 100 + Math.sin(i / 3) * 5;
      return hlc(c + 1 + (i % 4), c - 1 - (i % 3), c);
    });
    const full = atrBands(series);
    const cut = atrBands(series.slice(0, 30));
    expect(cut).toEqual(full.slice(0, 30));
    expect(full[29]?.atr).toBe(atrWilder(series, ATR_BAND_PERIOD)[29]);
  });
});

describe('stopAtrMultiple — 손절폭 ÷ ATR', () => {
  it('롱·숏 모두 거리의 절댓값으로 잰다', () => {
    expect(stopAtrMultiple(100, 98, 1)).toBe(2);
    expect(stopAtrMultiple(100, 103, 2)).toBe(1.5);
  });

  it('재료가 비거나 ATR 이 0 이하면 null', () => {
    expect(stopAtrMultiple(null, 98, 1)).toBeNull();
    expect(stopAtrMultiple(100, null, 1)).toBeNull();
    expect(stopAtrMultiple(100, 98, null)).toBeNull();
    expect(stopAtrMultiple(100, 98, 0)).toBeNull();
    expect(stopAtrMultiple(100, Number.NaN, 1)).toBeNull();
  });
});

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
