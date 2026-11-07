import { describe, expect, it } from "vitest";

import { liquidityState, volumeProfile } from "./liquidity";
import type { VolumeBin } from "./types";

/** ref 100, 칸 1(=1%) 짜리 칸을 거래량 배열로 만든다 */
const binsOf = (vols: number[]): VolumeBin[] =>
  vols.map((vol, i) => ({ lo: 100 + i, hi: 101 + i, vol }));

describe("volumeProfile", () => {
  it("칸 합 = 거래량 합, 겹친 길이 비례 배분", () => {
    const cs = [
      { h: 102, l: 100, v: 10 }, // 100~101: 5, 101~102: 5
      { h: 100.5, l: 100.5, v: 3 }, // 점 봉 → 한 칸
      { h: 103.7, l: 101.3, v: 7.3 },
      { h: 99.2, l: 98.4, v: 2 },
    ];
    const bins = volumeProfile(cs, 0.01, 100);
    const sum = bins.reduce((s, b) => s + b.vol, 0);
    expect(sum).toBeCloseTo(10 + 3 + 7.3 + 2, 9);
    expect(bins[0].lo).toBeCloseTo(98, 9);
    expect(bins[bins.length - 1].hi).toBeCloseTo(104, 9);
    const at = (lo: number) => bins.find((b) => Math.abs(b.lo - lo) < 1e-9);
    expect(at(99)?.vol).toBeCloseTo(0.5, 9); // 99~99.2 = 0.2/0.8 × 2
    // 101.3~103.7 (2.4): 101 칸 0.7, 102 칸 1, 103 칸 0.7
    expect(at(102)?.vol).toBeCloseTo(7.3 / 2.4, 9);
  });

  it("빈 입력 → []", () => {
    expect(volumeProfile([], 0.0025, 100)).toEqual([]);
  });
});

describe("liquidityState", () => {
  it("중앙값 35% 이하 3칸 연속 → LVN, 2칸이면 아님", () => {
    // 중앙값 10, 기준 3.5
    const r3 = liquidityState(binsOf([10, 10, 10, 3, 3, 3, 10, 10, 10]), 100.5, 1);
    expect(r3.lvn).toEqual([{ lo: 103, hi: 106 }]);
    const r2 = liquidityState(binsOf([10, 10, 10, 3, 3, 10, 10, 10, 10]), 100.5, 1);
    expect(r2.lvn).toEqual([]);
    expect(r2.gapUpDistPct).toBeNull();
  });

  it("HVN 연속 묶기·현재 칸 HVN·바로 위 HVN 경고", () => {
    const bins = binsOf([10, 10, 20, 20, 10, 10, 30, 10, 10]);
    const r = liquidityState(bins, 102.5, 1);
    expect(r.hvn).toEqual([
      { lo: 102, hi: 104 },
      { lo: 106, hi: 107 },
    ]);
    expect(r.inHvn).toBe(true);
    expect(r.state.warn).toBe(true); // 103 칸도 HVN
    const r2 = liquidityState(bins, 104.5, 1);
    expect(r2.inHvn).toBe(false);
    expect(r2.state.warn).toBe(false);
  });

  it("롱 켜짐 — HVN 밖, 위쪽 공백 입구 0.3% 안, 위 매도 얇음", () => {
    const bins = binsOf([10, 10, 10, 10, 3, 3, 3, 10, 10]);
    const r = liquidityState(bins, 103.8, 0.4);
    expect(r.gapUpDistPct).toBeCloseTo((0.2 / 103.8) * 100, 9);
    expect(r.state.measured).toBe(true);
    expect(r.state.on).toBe("long");
    // 매도가 두꺼우면 꺼짐
    expect(liquidityState(bins, 103.8, 1).state.on).toBeNull();
  });

  it("숏 켜짐 — 아래쪽 공백 입구 + 아래 매수 얇음(depthRatio > 2)", () => {
    const bins = binsOf([10, 10, 3, 3, 3, 10, 10, 10, 10]);
    const r = liquidityState(bins, 105.2, 3);
    expect(r.gapDownDistPct).toBeCloseTo((0.2 / 105.2) * 100, 9);
    expect(r.state.on).toBe("short");
  });

  it("depth null → measured false, 공백·HVN 은 채움", () => {
    const bins = binsOf([10, 10, 10, 10, 3, 3, 3, 10, 30]);
    const r = liquidityState(bins, 103.8, null);
    expect(r.state.measured).toBe(false);
    expect(r.state.on).toBeNull();
    expect(r.depthRatio).toBeNull();
    expect(r.gapUpDistPct).not.toBeNull();
    expect(r.lvn).toHaveLength(1);
    expect(r.hvn).toHaveLength(1);
  });
});
