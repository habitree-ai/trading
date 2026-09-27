import { describe, expect, it } from "vitest";

import { IMPULSE, impulseIndex, impulseLevel, requiredWaitMs, type PrevExit } from "@/lib/impulse";

const MIN = 60_000;
const prev: PrevExit = { net: -50, equityBefore: 1000, margin: 100 };

describe("impulseIndex", () => {
  it("손실 5%·같은 규모·공백 0 — 손실 절반 + 시간 만점", () => {
    const r = impulseIndex(prev, 0, 100);
    expect(r.loss).toBeCloseTo(0.5);
    expect(r.size).toBe(0);
    expect(r.time).toBe(1);
    expect(r.score).toBe(50); // 40×0.5 + 30×1
    expect(r.prevNetPct).toBeCloseTo(-0.05);
    expect(r.marginRatio).toBe(1);
  });

  it("손실 10%↑·두 배 규모·즉시 — 100", () => {
    expect(impulseIndex({ ...prev, net: -200 }, 0, 250).score).toBe(100);
  });

  it("이익 청산 뒤 4시간 이상 같은 규모 — 0", () => {
    const r = impulseIndex({ ...prev, net: 80 }, 4 * 60 * MIN, 100);
    expect(r.score).toBe(0);
    expect(r.waitMs).toBe(IMPULSE.baseWaitMs);
  });

  it("공백 2시간이면 시간항 절반", () => {
    expect(impulseIndex({ ...prev, net: 10 }, 120 * MIN, 100).time).toBeCloseTo(0.5);
  });

  it("규모가 줄면 규모항 0, 1.5배면 0.5", () => {
    expect(impulseIndex(prev, 0, 50).size).toBe(0);
    expect(impulseIndex(prev, 0, 150).size).toBeCloseTo(0.5);
  });

  it("잔고·증거금을 모르면 그 항은 0 이고 비율은 null", () => {
    const r = impulseIndex({ net: -50, equityBefore: null, margin: null }, 0, 100);
    expect(r.loss).toBe(0);
    expect(r.size).toBe(0);
    expect(r.prevNetPct).toBeNull();
    expect(r.marginRatio).toBeNull();
    expect(impulseIndex(prev, 0, null).marginRatio).toBeNull();
  });
});

describe("requiredWaitMs", () => {
  it("60분 + 손실항 × 180분, 최대 4시간", () => {
    expect(requiredWaitMs({ ...prev, net: 5 })).toBe(60 * MIN);
    expect(requiredWaitMs(prev)).toBe(150 * MIN);
    expect(requiredWaitMs({ ...prev, net: -500 })).toBe(240 * MIN);
  });
});

describe("impulseLevel", () => {
  it("30·60 경계", () => {
    expect(impulseLevel(29)).toBe("low");
    expect(impulseLevel(30)).toBe("mid");
    expect(impulseLevel(60)).toBe("high");
  });
});
