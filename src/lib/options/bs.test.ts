import { describe, expect, it } from "vitest";

import { bsD1, bsDelta, bsGamma, normCdf, normPdf } from "@/lib/options/bs";

describe("normPdf · normCdf — 표준정규", () => {
  it("normPdf(0) = 1/√(2π)", () => {
    expect(normPdf(0)).toBeCloseTo(0.3989422804014327, 12);
  });

  it("normCdf 기준값 — 0.5, 1.96 → 0.975, 그 밖의 표 값 1e-9 안", () => {
    expect(normCdf(0)).toBe(0.5);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 4);
    // 정밀 기준값(1e-9) — 유리근사 계수가 맞는지 확인한다.
    expect(normCdf(1.96)).toBeCloseTo(0.9750021048517795, 9);
    expect(normCdf(0.5)).toBeCloseTo(0.6914624612740131, 9);
    expect(normCdf(1)).toBeCloseTo(0.8413447460685429, 9);
    expect(normCdf(2)).toBeCloseTo(0.9772498680518208, 9);
    expect(normCdf(3)).toBeCloseTo(0.9986501019683699, 9);
    expect(normCdf(-1.5)).toBeCloseTo(0.0668072012688581, 9);
  });

  it("대칭·꼬리 — N(x) + N(−x) = 1, 먼 꼬리는 0/1", () => {
    for (const x of [0.3, 1.2, 2.5, 4, 8]) {
      expect(normCdf(x) + normCdf(-x)).toBeCloseTo(1, 12);
    }
    expect(normCdf(10)).toBeCloseTo(1, 12);
    expect(normCdf(-10)).toBeCloseTo(0, 12);
    expect(normCdf(40)).toBe(1);
    expect(normCdf(-40)).toBe(0);
  });
});

describe("bsD1 — 재료 검증", () => {
  it("S·K·σ·T 중 하나라도 0 이하거나 비유한이면 null", () => {
    expect(bsD1(0, 80_000, 0.4, 0.5)).toBeNull();
    expect(bsD1(80_000, -1, 0.4, 0.5)).toBeNull();
    expect(bsD1(80_000, 80_000, 0, 0.5)).toBeNull();
    expect(bsD1(80_000, 80_000, 0.4, 0)).toBeNull();
    expect(bsD1(Number.NaN, 80_000, 0.4, 0.5)).toBeNull();
    expect(bsD1(80_000, 80_000, Number.POSITIVE_INFINITY, 0.5)).toBeNull();
  });

  it("S = K 이면 d1 = σ√T / 2", () => {
    expect(bsD1(80_000, 80_000, 0.4, 0.25)).toBeCloseTo(0.1, 12);
  });
});

describe("bsDelta · bsGamma — OKX opt-summary 실측과 5% 이내", () => {
  // BTC-USD-270326-90000-C, 2026-09-18 ~12:00 UTC. OKX 는 r·T 셈이 조금 달라 정확히 같진 않다.
  const S = 80_000.98;
  const K = 90_000;
  const sigma = 0.3784;
  const T = (Date.UTC(2027, 2, 26, 8) - Date.UTC(2026, 8, 18, 12)) / (365 * 86_400_000);
  const okxDelta = 0.3833;
  const okxGamma = 1.799e-5;

  it("콜 델타", () => {
    const delta = bsDelta("C", S, K, sigma, T);
    expect(delta).not.toBeNull();
    expect(Math.abs((delta as number) / okxDelta - 1)).toBeLessThan(0.05);
  });

  it("감마", () => {
    const gamma = bsGamma(S, K, sigma, T);
    expect(gamma).not.toBeNull();
    expect(Math.abs((gamma as number) / okxGamma - 1)).toBeLessThan(0.05);
  });

  it("풋 델타 = 콜 델타 − 1", () => {
    const call = bsDelta("C", S, K, sigma, T) as number;
    const put = bsDelta("P", S, K, sigma, T) as number;
    expect(put).toBeCloseTo(call - 1, 12);
    expect(put).toBeLessThan(0);
  });

  it("재료가 없으면 델타·감마도 null", () => {
    expect(bsDelta("C", S, K, 0, T)).toBeNull();
    expect(bsGamma(S, K, sigma, -0.1)).toBeNull();
  });
});
