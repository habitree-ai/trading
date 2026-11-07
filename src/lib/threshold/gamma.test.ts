import { describe, expect, it } from "vitest";

import { analyzeOptions } from "@/lib/options/analyze";
import type { OptionRow, OptionsSnapshot, OptionType } from "@/lib/options/types";
import { BIG_EXPIRY_OI_SHARE, gammaState } from "@/lib/threshold/gamma";

/** 2026-09-18 12:00 UTC — 픽스처의 "지금". */
const NOW = Date.UTC(2026, 8, 18, 12);
/** 20시간 뒤 만기 — 48시간 안. */
const SEP19 = { expiry: "2026-09-19", expiryMs: Date.UTC(2026, 8, 19, 8) };
const DEC25 = { expiry: "2026-12-25", expiryMs: Date.UTC(2026, 11, 25, 8) };

interface RowSpec {
  expiry?: { expiry: string; expiryMs: number };
  strike: number;
  type: OptionType;
  oi: number;
  markIv?: number | null;
}

function row(spec: RowSpec): OptionRow {
  const expiry = spec.expiry ?? DEC25;
  return {
    venue: "deribit",
    instId: `deribit-${expiry.expiry}-${spec.strike}-${spec.type}`,
    expiry: expiry.expiry,
    expiryMs: expiry.expiryMs,
    strike: spec.strike,
    type: spec.type,
    oi: spec.oi,
    vol24h: 0,
    markIv: spec.markIv === undefined ? 0.5 : spec.markIv,
    forward: null,
  };
}

function snapshot(rows: OptionRow[], indexPrice: number): OptionsSnapshot {
  return {
    collectedAt: new Date(NOW).toISOString(),
    indexPrice,
    rows,
    okxFlow: null,
    okxHistory: [],
    dvol: null,
    dailyCloses: [],
    sources: { okx: "ok", deribit: "ok", dvol: "ok", candles: "ok" },
  };
}

function report(rows: OptionRow[], spot: number) {
  return gammaState(analyzeOptions(snapshot(rows, spot), NOW), spot, NOW);
}

describe("gammaState", () => {
  it("순 GEX 음수 + 플립이 현재가 아래 → 켜짐 롱(위로 갈수록 음감마가 깊어진다)", () => {
    // 아래엔 콜(+), 위엔 풋(−) — 현재가 85k 에선 풋 90k 감마가 커서 음수, 70k 쪽으로 가면 양수.
    const rows = [
      row({ strike: 70_000, type: "C", oi: 100 }),
      row({ strike: 90_000, type: "P", oi: 100 }),
    ];
    const r = report(rows, 85_000);
    expect(r).not.toBeNull();
    expect(r?.netGexNearSpot as number).toBeLessThan(0);
    expect(r?.flipStrike as number).toBeLessThan(85_000);
    expect(r?.state.measured).toBe(true);
    expect(r?.state.on).toBe("long");
    expect(r?.state.warn).toBe(false);
    expect(r?.state.reasons.some((s) => s.includes("순 GEX 음수"))).toBe(true);
  });

  it("대칭: 순 GEX 음수 + 플립이 현재가 위 → 켜짐 숏", () => {
    // 위엔 콜, 아래엔 풋 — 75k 에선 풋 70k 감마가 커서 음수, 90k 쪽으로 가면 양수.
    const rows = [
      row({ strike: 70_000, type: "P", oi: 100 }),
      row({ strike: 90_000, type: "C", oi: 100 }),
    ];
    const r = report(rows, 75_000);
    expect(r?.netGexNearSpot as number).toBeLessThan(0);
    expect(r?.flipStrike as number).toBeGreaterThan(75_000);
    expect(r?.state.on).toBe("short");
  });

  it("순 GEX 양수 + 벽 0.5% 안 + 48h 안 대형 만기 → 경고", () => {
    const rows = [
      row({ expiry: SEP19, strike: 80_300, type: "C", oi: 100 }),
      row({ expiry: SEP19, strike: 79_000, type: "P", oi: 20 }),
      row({ strike: 90_000, type: "C", oi: 30 }),
    ];
    const r = report(rows, 80_000);
    expect(r?.netGexNearSpot as number).toBeGreaterThan(0);
    expect(r?.callWall).toBe(80_300);
    expect(r?.wallDistPct.call as number).toBeCloseTo(0.375, 6);
    expect(r?.bigExpiry?.expiry).toBe("2026-09-19");
    expect(r?.bigExpiry?.hoursLeft).toBeCloseTo(20, 6);
    expect(r?.bigExpiry?.oiShare as number).toBeGreaterThanOrEqual(BIG_EXPIRY_OI_SHARE);
    expect(r?.state.warn).toBe(true);
    expect(r?.state.on).toBeNull();
  });

  it("대형 만기가 48시간 밖이면 경고 없음", () => {
    const rows = [
      row({ strike: 80_300, type: "C", oi: 100 }),
      row({ strike: 79_000, type: "P", oi: 20 }),
    ];
    const r = report(rows, 80_000);
    expect(r?.bigExpiry).toBeNull();
    expect(r?.state.warn).toBe(false);
  });

  it("큰 콜 벽 돌파 + 다음 콜 벽까지 ≥ 1.5% → 켜짐 롱", () => {
    const rows = [
      row({ strike: 78_000, type: "C", oi: 200 }),
      row({ strike: 82_000, type: "C", oi: 50 }),
      row({ strike: 75_000, type: "P", oi: 10 }),
    ];
    const r = report(rows, 80_000);
    expect(r?.netGexNearSpot as number).toBeGreaterThan(0);
    expect(r?.callWall).toBe(82_000);
    expect(r?.nextWallDistPct as number).toBeCloseTo(2.5, 6);
    expect(r?.state.on).toBe("long");
    expect(r?.state.reasons.some((s) => s.includes("큰 콜 벽 78000 돌파"))).toBe(true);
  });

  it("벽은 넘었지만 다음 벽까지 1.5% 미만이면 켜지지 않는다", () => {
    const rows = [
      row({ strike: 78_000, type: "C", oi: 200 }),
      row({ strike: 81_000, type: "C", oi: 50 }),
      row({ strike: 75_000, type: "P", oi: 10 }),
    ];
    const r = report(rows, 80_000);
    expect(r?.nextWallDistPct as number).toBeCloseTo(1.25, 6);
    expect(r?.state.on).toBeNull();
  });

  it("IV 가 없어 GEX 를 못 내면 measured=false", () => {
    const r = report([row({ strike: 80_000, type: "C", oi: 10, markIv: null })], 79_000);
    expect(r?.netGexNearSpot).toBeNull();
    expect(r?.state.measured).toBe(false);
    expect(r?.state.on).toBeNull();
    expect(r?.state.warn).toBe(false);
  });

  it("옵션 행이 없거나 spot 이 잘못이면 null", () => {
    expect(report([], 80_000)).toBeNull();
    const a = analyzeOptions(snapshot([row({ strike: 80_000, type: "C", oi: 1 })], 80_000), NOW);
    expect(gammaState(a, 0, NOW)).toBeNull();
  });
});
