import { describe, expect, it } from "vitest";

import type { Candle } from "@/lib/okx";

import { atrWilder, bollinger, keltner, percentileRank, volatilityState, VOL_MIN_BARS } from "./volatility";

const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c, v: 1 });

describe("atrWilder", () => {
  it("3봉 손계산과 일치", () => {
    const cs = [
      bar(0, 9, 10, 8, 9), // TR 2
      bar(1, 9, 12, 10, 11), // TR max(2, |12−9|=3, |10−9|=1) = 3
      bar(2, 11, 11.5, 10.5, 11), // TR max(1, 0.5, 0.5) = 1
      bar(3, 11, 14, 12, 13), // TR max(2, 3, 1) = 3
    ];
    const a = atrWilder(cs, 3);
    expect(a[0]).toBeNull();
    expect(a[1]).toBeNull();
    expect(a[2]).toBeCloseTo(2, 10); // (2+3+1)/3
    expect(a[3]).toBeCloseTo(7 / 3, 10); // (2×2+3)/3
  });
});

describe("bollinger·keltner·percentileRank", () => {
  it("일정 종가 → 폭 0", () => {
    const b = bollinger(new Array(25).fill(100), 20, 2);
    expect(b[18]).toBeNull();
    expect(b[24]).toEqual({ mid: 100, upper: 100, lower: 100, width: 0 });
  });

  it("폭 = 4σ/SMA (k=2)", () => {
    const b = bollinger([1, 3], 2, 2)[1];
    // mid 2, σ 1 → 폭 4/2
    expect(b?.width).toBeCloseTo(2, 10);
  });

  it("켈트너 = SMA ± mult×ATR", () => {
    const cs = Array.from({ length: 5 }, (_, i) => bar(i, 100, 101, 99, 100));
    const k = keltner(cs, 3, 3, 1.5)[4];
    expect(k?.upper).toBeCloseTo(103, 10);
    expect(k?.lower).toBeCloseTo(97, 10);
  });

  it("백분위 — 직전 창 중 더 작았던 비율, null 섞이면 null", () => {
    expect(percentileRank([1, 2, 3, 4, 2.5], 4, 4)).toBe(0.5);
    expect(percentileRank([null, 2, 3, 4, 2.5], 4, 4)).toBeNull();
    expect(percentileRank([1, 2], 1, 4)).toBeNull();
  });
});

/** 잔잔한 출렁임 → 납작(압축) → 상승 이탈 */
function squeezeThenBreakout(): Candle[] {
  const cs: Candle[] = [];
  let t = 0;
  for (let i = 0; i < 140; i += 1) {
    const c = 100 + Math.sin(i * 0.9) * 0.2;
    cs.push(bar(t++, c, c + 0.05, c - 0.05, c));
  }
  for (let i = 0; i < 20; i += 1) cs.push(bar(t++, 100, 100.02, 99.98, 100));
  let c = 100;
  for (const step of [0.4, 0.8, 1.4]) {
    const o = c;
    c += step;
    cs.push(bar(t++, o, c + 0.05, o - 0.05, c));
  }
  return cs;
}

describe("volatilityState", () => {
  it("봉 부족 → measured false, 값 null", () => {
    const s = volatilityState(squeezeThenBreakout().slice(0, VOL_MIN_BARS - 1), "1H", 0.001);
    expect(s.state.measured).toBe(false);
    expect(s.bbwPct).toBeNull();
    expect(s.atrRatio).toBeNull();
    expect(s.atrOverCost).toBeNull();
    expect(s.state.on).toBeNull();
  });

  it("압축 → 팽창 이탈 → 롱 켜짐", () => {
    const cs = squeezeThenBreakout();
    const s = volatilityState(cs, "15m", 0.001);
    expect(s.state.measured).toBe(true);
    expect(s.squeezeWithin10).toBe(true);
    expect(s.bbwExpanding3).toBe(true);
    expect(s.atrRatio).not.toBeNull();
    expect(s.atrRatio ?? 0).toBeGreaterThanOrEqual(1.3);
    expect(s.closeOutside).toBe("upper");
    expect(s.state.on).toBe("long");
    expect(s.lastClosedMs).toBe(cs[cs.length - 1].t);
  });

  it("납작 구간 한가운데 → 압축", () => {
    const s = volatilityState(squeezeThenBreakout().slice(0, 160), "1H", 0.001);
    expect(s.label).toBe("압축");
    expect(s.squeezeNow).toBe(true);
    expect(s.state.on).toBeNull();
  });

  it("ATR비 ≥ 2.0 → 경고", () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 150; i += 1) {
      const c = 100 + (i % 2 ? 0.2 : -0.2);
      cs.push(bar(i, c, c + 0.5, c - 0.5, c));
    }
    for (let i = 0; i < 5; i += 1) cs.push(bar(150 + i, 100, 104, 96, 100));
    const s = volatilityState(cs, "1H", 0.001);
    expect(s.atrRatio ?? 0).toBeGreaterThanOrEqual(2);
    expect(s.state.warn).toBe(true);
    expect(s.label).not.toBe("보통");
  });

  it("ATR ÷ 왕복 비용", () => {
    const cs = Array.from({ length: VOL_MIN_BARS }, (_, i) => bar(i, 100, 101, 99, 100));
    const s = volatilityState(cs, "1H", 0.001);
    // ATR14 = 2, 비용 = 100 × 0.001 = 0.1
    expect(s.atrOverCost).toBeCloseTo(20, 8);
  });
});
