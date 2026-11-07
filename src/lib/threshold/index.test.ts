import { describe, expect, it } from "vitest";

import { hvnBelow, judgeThresholds, summarize, toLegSignals } from "@/lib/threshold/index";
import type {
  FuelReport,
  GammaReport,
  LiquidityReport,
  SignalSide,
  SignalState,
  SignalTf,
  ThresholdReport,
  VolatilityTf,
  VolumeBin,
} from "@/lib/threshold/types";

const st = (on: SignalSide | null = null, warn = false, measured = true): SignalState => ({
  on,
  warn,
  measured,
  reasons: [],
});

function vol(tf: SignalTf, state: SignalState, extra: Partial<VolatilityTf> = {}): VolatilityTf {
  return {
    tf,
    lastClosedMs: 0,
    bbwPct: 0.5,
    atrRatio: 1,
    squeezeWithin10: false,
    squeezeNow: false,
    bbwExpanding3: false,
    closeOutside: null,
    atrOverCost: 10,
    label: "보통",
    state,
    ...extra,
  };
}

const quietVol = (): VolatilityTf[] => [
  vol("1D", st()),
  vol("4H", st()),
  vol("1H", st()),
  vol("15m", st()),
];

function gamma(state: SignalState, extra: Partial<GammaReport> = {}): GammaReport {
  return {
    spot: 100,
    netGexNearSpot: -5,
    flipStrike: 99,
    callWall: 102,
    putWall: 97,
    wallDistPct: { call: 2, put: 3 },
    nextWallDistPct: 2,
    bigExpiry: null,
    state,
    ...extra,
  };
}

function fuel(state: SignalState, fundingAnnual: number | null = 0.1): FuelReport {
  return { fundingRate: 0.0001, fundingAnnual, priceChg24h: 0.01, oiChg24hPct: 1, state };
}

/** 1칸 = 1, 100~109. 현재가 104.5 → 칸 4. */
const binsOf = (vols: number[]): VolumeBin[] => vols.map((v, i) => ({ lo: 100 + i, hi: 101 + i, vol: v }));

function liq(state: SignalState, bins: VolumeBin[] = binsOf([10, 10, 10, 10, 10, 10, 10, 10, 10])): LiquidityReport {
  return {
    bins,
    lvn: [],
    hvn: [],
    gapUpDistPct: 0.2,
    gapDownDistPct: 1.1,
    inHvn: false,
    depthRatio: 0.4,
    state,
  };
}

const parts = (over: Partial<Pick<ThresholdReport, "volatility" | "gamma" | "fuel" | "liquidity">> = {}) => ({
  spot: 104.5,
  volatility: quietVol(),
  gamma: gamma(st()),
  fuel: fuel(st()),
  liquidity: liq(st()),
  ...over,
});

describe("summarize", () => {
  it("넷 다 측정·조용함 → 켜짐 0 · 경고 0 · 측정 4/4", () => {
    const s = summarize(parts());
    expect(s).toEqual({ warnings: { long: [], short: [] }, on: { long: 0, short: 0 }, measuredCount: 4, measured: true });
  });

  it("변동성은 15m·1H 만 판정 — 4H·1D 켜짐·과열은 세지 않는다", () => {
    const s = summarize(
      parts({ volatility: [vol("1D", st("long", true)), vol("4H", st("short", true)), vol("1H", st()), vol("15m", st())] }),
    );
    expect(s.on).toEqual({ long: 0, short: 0 });
    expect(s.warnings).toEqual({ long: [], short: [] });
  });

  it("15m 켜짐 롱 + 1H 과열 → 롱 켜짐 1, 과열 경고는 양쪽", () => {
    const s = summarize(
      parts({ volatility: [vol("1D", st()), vol("4H", st()), vol("1H", st(null, true)), vol("15m", st("long"))] }),
    );
    expect(s.on).toEqual({ long: 1, short: 0 });
    expect(s.warnings.long).toEqual(["변동성 과열(1H)"]);
    expect(s.warnings.short).toEqual(["변동성 과열(1H)"]);
  });

  it("판정 TF 하나라도 미측정이면 변동성 미측정 — 켜짐도 세지 않는다", () => {
    const s = summarize(
      parts({ volatility: [vol("1D", st()), vol("4H", st()), vol("1H", st(null, false, false)), vol("15m", st("long"))] }),
    );
    expect(s.measuredCount).toBe(3);
    expect(s.measured).toBe(false);
    expect(s.on.long).toBe(0);
  });

  it("감마 핀닝은 양쪽 경고, 켜짐은 그 방향만", () => {
    const s = summarize(parts({ gamma: gamma(st("short", true)) }));
    expect(s.on).toEqual({ long: 0, short: 1 });
    expect(s.warnings.long).toEqual(["감마 핀닝"]);
    expect(s.warnings.short).toEqual(["감마 핀닝"]);
  });

  it("감마 null(BTC 외) → 미측정, 꺼짐으로 세지 않는다", () => {
    const s = summarize(parts({ gamma: null }));
    expect(s.measuredCount).toBe(3);
  });

  it("펀딩 연 +30% 이상 → 롱 경고만, −30% 이하 → 숏 경고만", () => {
    expect(summarize(parts({ fuel: fuel(st(null, true), 0.3) })).warnings).toEqual({ long: ["펀딩 롱 쏠림"], short: [] });
    expect(summarize(parts({ fuel: fuel(st(null, true), -0.31) })).warnings).toEqual({ long: [], short: ["펀딩 숏 쏠림"] });
  });

  it("OI 를 못 받아 연료 미측정이어도 펀딩 경고는 남긴다", () => {
    const s = summarize(parts({ fuel: fuel(st(null, false, false), 0.4) }));
    expect(s.measuredCount).toBe(3);
    expect(s.warnings.long).toEqual(["펀딩 롱 쏠림"]);
  });

  it("유동성: 롱 경고 = state.warn(바로 위 HVN), 숏 경고 = 바로 아래 칸 HVN(bins 로 계산)", () => {
    // 중앙값 10, HVN 기준 15. 현재가 104.5 → 칸 4, 아래 칸 3 이 20.
    const below = binsOf([10, 10, 10, 20, 10, 10, 10, 10, 10]);
    const s = summarize(parts({ liquidity: liq(st(), below) }));
    expect(s.warnings).toEqual({ long: [], short: ["바로 아래 고거래량"] });

    const above = summarize(parts({ liquidity: liq(st(null, true)) }));
    expect(above.warnings).toEqual({ long: ["바로 위 고거래량"], short: [] });
  });

  it("호가 미측정이면 유동성 미측정 — 켜짐은 안 세고 HVN 경고는 남는다", () => {
    const s = summarize(parts({ liquidity: liq(st("long", true, false)) }));
    expect(s.on.long).toBe(0);
    expect(s.measuredCount).toBe(3);
    expect(s.warnings.long).toEqual(["바로 위 고거래량"]);
  });
});

describe("hvnBelow", () => {
  it("현재가가 맨 아래 칸이거나 프로파일 밖이면 false", () => {
    const bins = binsOf([20, 10, 10, 10]);
    expect(hvnBelow(bins, 100.5)).toBe(false);
    expect(hvnBelow(bins, 99)).toBe(false);
    expect(hvnBelow(bins, null)).toBe(false);
    expect(hvnBelow(bins, 101.5)).toBe(true);
  });
});

describe("judgeThresholds", () => {
  it("순서는 변동성·감마·연료·유동성", () => {
    expect(judgeThresholds(parts()).map((v) => v.key)).toEqual(["volatility", "gamma", "fuel", "liquidity"]);
  });
});

describe("toLegSignals", () => {
  const base = parts({
    volatility: [
      vol("1D", st()),
      vol("4H", st()),
      vol("1H", st("long"), { bbwPct: 0.83, atrRatio: 1.42 }),
      vol("15m", st(), { bbwPct: 0.1, atrRatio: 0.9 }),
    ],
    gamma: gamma(st(null, true), { netGexNearSpot: 3e6, wallDistPct: { call: 0.4, put: 1.2 } }),
  });
  const report: ThresholdReport = {
    symbol: "BTC-USDT-SWAP",
    collectedAt: "2026-11-07T00:00:00.000Z",
    ...base,
    summary: summarize(base),
    sources: { candles: "ok", options: "ok", derivs: "ok", book: "ok" },
  };

  it("롱 — 1H 값, 콜 벽, 위쪽 공백, 롱 경고", () => {
    expect(toLegSignals(report, "long")).toEqual({
      bbwPct: 0.83,
      atrRatio: 1.42,
      netGexSign: 1,
      wallDistPct: 0.4,
      depthRatio: 0.4,
      lvnDistPct: 0.2,
      warnings: ["감마 핀닝"],
      onLong: 1,
      onShort: 0,
      collectedAt: "2026-11-07T00:00:00.000Z",
    });
  });

  it("숏 — 풋 벽, 아래쪽 공백", () => {
    const s = toLegSignals(report, "short");
    expect(s.wallDistPct).toBe(1.2);
    expect(s.lvnDistPct).toBe(1.1);
    expect(s.warnings).toEqual(["감마 핀닝"]);
  });

  it("못 잰 칸은 null — 0 이 아니다", () => {
    const empty: ThresholdReport = { ...report, gamma: null, liquidity: null, volatility: [] };
    const s = toLegSignals(empty, "long");
    expect(s.bbwPct).toBeNull();
    expect(s.netGexSign).toBeNull();
    expect(s.wallDistPct).toBeNull();
    expect(s.depthRatio).toBeNull();
    expect(s.lvnDistPct).toBeNull();
  });
});
