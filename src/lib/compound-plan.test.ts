import { describe, expect, it } from "vitest";

import {
  annualFromMonthly,
  dailyFromMonthly,
  futureValue,
  monthPerformance,
  monthsToTarget,
  monthVerdict,
  PLAN_DEFAULT,
  requiredMonthlyRate,
  stageOf,
  weeklyFromMonthly,
} from "@/lib/compound-plan";

const TARGET = 100_000_000 / 1390; // 71,942 USD

describe("복리 산식 — 기획서 표의 값을 고정한다", () => {
  it("futureValue: r=0 은 단순 합, 복리는 닫힌 식", () => {
    expect(futureValue(100, 150, 0, 12)).toBe(1900);
    expect(futureValue(100, 0, 0.1, 2)).toBeCloseTo(121, 6);
    expect(futureValue(0, 100, 0.01, 2)).toBeCloseTo(201, 6);
  });

  it("requiredMonthlyRate: 60개월·납입 150 → 5.65%, 120개월 → 1.96%, 36개월·납입 0 → 20.05%", () => {
    expect(requiredMonthlyRate(100, 150, TARGET, 60) * 100).toBeCloseTo(5.65, 1);
    expect(requiredMonthlyRate(100, 150, TARGET, 120) * 100).toBeCloseTo(1.96, 1);
    expect(requiredMonthlyRate(100, 0, TARGET, 36) * 100).toBeCloseTo(20.05, 1);
  });

  it("requiredMonthlyRate: 납입만으로 닿으면 0", () => {
    expect(requiredMonthlyRate(100, 1000, 5000, 12)).toBe(0);
  });

  it("monthsToTarget: 월 2%·납입 150 → 119개월, 월 5% → 66, 월 10% → 41", () => {
    expect(monthsToTarget(100, 150, 0.02, TARGET)).toBe(119);
    expect(monthsToTarget(100, 150, 0.05, TARGET)).toBe(66);
    expect(monthsToTarget(100, 150, 0.1, TARGET)).toBe(41);
    expect(monthsToTarget(100, 0, 0, TARGET)).toBeNull();
    expect(monthsToTarget(200, 0, 0.01, 100)).toBe(0);
  });

  it("환산: 월 2% = 주 0.458% = 거래일 0.094% = 연 26.8%", () => {
    expect(weeklyFromMonthly(0.02) * 100).toBeCloseTo(0.458, 2);
    expect(dailyFromMonthly(0.02) * 100).toBeCloseTo(0.094, 2);
    expect(annualFromMonthly(0.02) * 100).toBeCloseTo(26.8, 0);
  });
});

describe("단계", () => {
  it("자금으로 단계를 가른다 — 상한은 미포함", () => {
    expect(stageOf(66.47).level).toBe(0);
    expect(stageOf(999.99).level).toBe(0);
    expect(stageOf(1_000).level).toBe(1);
    expect(stageOf(10_000).level).toBe(3);
    expect(stageOf(-5).level).toBe(0);
  });
});

describe("monthPerformance", () => {
  const samples = [
    { at: "2026-07-30T00:00:00Z", performance: 120 },
    { at: "2026-08-03T00:00:00Z", performance: 130 },
    { at: "2026-08-10T00:00:00Z", performance: 100 },
    { at: "2026-08-20T00:00:00Z", performance: 126 },
  ];

  it("시작값은 직전 달의 마지막 점, 수익률은 끝/시작, 낙폭은 달 안의 고점 대비", () => {
    const p = monthPerformance(samples, 100, "2026-08");
    expect(p.startValue).toBe(120);
    expect(p.endValue).toBe(126);
    expect(p.returnPct).toBeCloseTo(0.05, 6);
    // 고점 130 → 100: −23.1%
    expect(p.drawdown).toBeCloseTo(1 - 100 / 130, 6);
    expect(p.samples).toBe(3);
  });

  it("직전 점이 없으면 초기자금에서 시작하고, 점이 없는 달은 변화 없음", () => {
    expect(monthPerformance(samples, 100, "2026-07").startValue).toBe(100);
    const empty = monthPerformance(samples, 100, "2026-09");
    expect(empty.startValue).toBe(126);
    expect(empty.returnPct).toBe(0);
    expect(empty.samples).toBe(0);
  });
});

describe("monthVerdict — 정지선이 α보다 먼저다", () => {
  const { beta, alpha } = PLAN_DEFAULT;
  const base = { month: "2026-08", startValue: 100, endValue: 100, samples: 3 };

  it("낙폭이 정지선에 닿으면 수익률과 무관하게 중단", () => {
    expect(monthVerdict({ ...base, returnPct: 0.08, drawdown: 0.2 }, beta, alpha)).toBe("stopped");
  });

  it("α · β · 양수 · 음수 · 무거래", () => {
    expect(monthVerdict({ ...base, returnPct: 0.05, drawdown: 0.05 }, beta, alpha)).toBe("alpha");
    expect(monthVerdict({ ...base, returnPct: 0.03, drawdown: 0.05 }, beta, alpha)).toBe("beta");
    expect(monthVerdict({ ...base, returnPct: 0.01, drawdown: 0.05 }, beta, alpha)).toBe("positive");
    expect(monthVerdict({ ...base, returnPct: -0.1, drawdown: 0.1 }, beta, alpha)).toBe("negative");
    expect(monthVerdict({ ...base, returnPct: 0, drawdown: 0, samples: 0 }, beta, alpha)).toBe("idle");
  });
});
