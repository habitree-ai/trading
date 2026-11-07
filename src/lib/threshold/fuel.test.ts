import { describe, expect, it } from "vitest";

import { annualizeFunding, fuelState } from "@/lib/threshold/fuel";

const base = { fundingRate: 0, price24hAgo: 100, priceNow: 100, oiNow: 100, oi24hAgo: 100 };

describe("fuelState", () => {
  it("펀딩 −0.0001 · 가격 상승 · OI +6% → 켜짐 롱", () => {
    const r = fuelState({ ...base, fundingRate: -0.0001, priceNow: 102, oiNow: 106 });
    expect(r.state.measured).toBe(true);
    expect(r.state.on).toBe("long");
    expect(r.state.warn).toBe(false);
    expect(r.priceChg24h).toBeCloseTo(0.02, 12);
    expect(r.oiChg24hPct).toBeCloseTo(6, 9);
    expect(r.fundingAnnual).toBeCloseTo(-0.1095, 12);
  });

  it("대칭: 펀딩 ≥ 0 · 가격 하락 · OI +6% → 켜짐 숏", () => {
    const r = fuelState({ ...base, fundingRate: 0.0001, priceNow: 98, oiNow: 106 });
    expect(r.state.on).toBe("short");
  });

  it("OI 증가가 5% 미만이면 꺼짐", () => {
    const r = fuelState({ ...base, fundingRate: -0.0001, priceNow: 102, oiNow: 104 });
    expect(r.state.measured).toBe(true);
    expect(r.state.on).toBeNull();
  });

  it("0.000274/8h(연 30.0%) → 롱 쏠림 경고", () => {
    const r = fuelState({ ...base, fundingRate: 0.000274 });
    expect(annualizeFunding(0.000274)).toBeCloseTo(0.30003, 5);
    expect(r.state.warn).toBe(true);
    expect(r.state.reasons.some((s) => s.includes("롱 쏠림"))).toBe(true);
  });

  it("대칭: −0.000274/8h → 숏 쏠림 경고", () => {
    const r = fuelState({ ...base, fundingRate: -0.000274 });
    expect(r.state.warn).toBe(true);
    expect(r.state.reasons.some((s) => s.includes("숏 쏠림"))).toBe(true);
  });

  it("값이 null 이면 measured=false — 다른 값은 그대로 보인다", () => {
    const r = fuelState({ ...base, fundingRate: 0.0001, oi24hAgo: null });
    expect(r.state.measured).toBe(false);
    expect(r.state.on).toBeNull();
    expect(r.state.warn).toBe(false);
    expect(r.fundingAnnual).toBeCloseTo(0.1095, 12);
    expect(r.oiChg24hPct).toBeNull();
    expect(fuelState({ ...base, fundingRate: null }).state.measured).toBe(false);
  });
});
