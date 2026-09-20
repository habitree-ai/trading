import { describe, expect, it } from "vitest";

import {
  analyzeOptions,
  atmIv,
  gammaExposure,
  HEADLINE_MIN_DTE,
  maxPain,
  pickHeadline,
  putCallRatio,
  realizedVol,
  riskReversal25,
} from "@/lib/options/analyze";
import type { OptionRow, OptionsSnapshot, OptionType, OptionVenue } from "@/lib/options/types";

/** 2026-09-18 12:00 UTC — 픽스처의 "지금". */
const NOW = Date.UTC(2026, 8, 18, 12);
const SEP25 = { expiry: "2026-09-25", expiryMs: Date.UTC(2026, 8, 25, 8) };
const DEC25 = { expiry: "2026-12-25", expiryMs: Date.UTC(2026, 11, 25, 8) };

interface RowSpec {
  venue?: OptionVenue;
  expiry?: { expiry: string; expiryMs: number };
  strike: number;
  type: OptionType;
  oi?: number;
  vol24h?: number | null;
  markIv?: number | null;
  forward?: number | null;
}

/** 필요한 칸만 적는 행 생성기 — 나머지는 흔한 기본값. */
function row(spec: RowSpec): OptionRow {
  const venue = spec.venue ?? "deribit";
  const expiry = spec.expiry ?? DEC25;
  return {
    venue,
    instId: `${venue}-${expiry.expiry}-${spec.strike}-${spec.type}`,
    expiry: expiry.expiry,
    expiryMs: expiry.expiryMs,
    strike: spec.strike,
    type: spec.type,
    oi: spec.oi ?? 1,
    vol24h: spec.vol24h === undefined ? 0 : spec.vol24h,
    markIv: spec.markIv === undefined ? 0.5 : spec.markIv,
    forward: spec.forward === undefined ? null : spec.forward,
  };
}

describe("putCallRatio", () => {
  it("콜이 0 이면 null, 아니면 풋/콜", () => {
    expect(putCallRatio(10, 0)).toBeNull();
    expect(putCallRatio(10, 20)).toBe(0.5);
    expect(putCallRatio(0, 20)).toBe(0);
  });
});

describe("maxPain — 손계산 픽스처", () => {
  it("70k/80k/90k, 콜 {10,20,5}·풋 {5,15,30}: payout 750k/400k/400k → 동률이면 작은 80k", () => {
    const rows = [
      { strike: 70_000, callOi: 10, putOi: 5 },
      { strike: 80_000, callOi: 20, putOi: 15 },
      { strike: 90_000, callOi: 5, putOi: 30 },
    ];
    // payout(70k) = 풋 15·10k + 30·20k = 750k
    // payout(80k) = 콜 10·10k + 풋 30·10k = 400k
    // payout(90k) = 콜 10·20k + 20·10k = 400k
    expect(maxPain(rows)).toBe(80_000);
  });

  it("풋 90k 를 25 로 줄이면 400k/350k/400k → 80k 단독 최소", () => {
    const rows = [
      { strike: 70_000, callOi: 10, putOi: 5 },
      { strike: 80_000, callOi: 20, putOi: 15 },
      { strike: 90_000, callOi: 5, putOi: 25 },
    ];
    // payout(70k) = 150k + 500k = 650k, payout(80k) = 100k + 250k = 350k, payout(90k) = 400k
    expect(maxPain(rows)).toBe(80_000);
  });

  it("OI 합이 0 이거나 행이 없으면 null", () => {
    expect(maxPain([])).toBeNull();
    expect(maxPain([{ strike: 80_000, callOi: 0, putOi: 0 }])).toBeNull();
  });
});

describe("atmIv — forward 에 가장 가까운 행사가의 콜·풋 IV 평균", () => {
  const rows = [
    row({ strike: 78_000, type: "C", markIv: 0.5 }),
    row({ strike: 78_000, type: "P", markIv: 0.52 }),
    row({ strike: 80_000, type: "C", markIv: 0.4 }),
    row({ strike: 80_000, type: "P", markIv: 0.44 }),
    row({ strike: 82_000, type: "C", markIv: 0.42 }),
    row({ strike: 82_000, type: "P", markIv: null }),
  ];

  it("80.5k → 80k 의 콜·풋 평균 0.42", () => {
    expect(atmIv(rows, 80_500)).toBeCloseTo(0.42, 12);
  });

  it("81.5k → 82k, 풋 IV 가 없으니 콜 하나만", () => {
    expect(atmIv(rows, 81_500)).toBeCloseTo(0.42, 12);
  });

  it("거리 동률(81k)이면 작은 행사가 80k", () => {
    expect(atmIv(rows, 81_000)).toBeCloseTo(0.42, 12);
  });

  it("IV 가 있는 행이 없으면 null", () => {
    expect(atmIv([row({ strike: 80_000, type: "C", markIv: null })], 80_000)).toBeNull();
    expect(atmIv([], 80_000)).toBeNull();
  });
});

describe("riskReversal25 — 합성 스마일", () => {
  const forward = 80_000;
  const T = 0.25;
  /** IV 가 행사가에 선형으로 내려가는 스마일 — 낮은 행사가(풋 쪽)가 더 비싸다. */
  function smile(strikes: number[], iv: (k: number) => number): OptionRow[] {
    return strikes.flatMap((k) => [
      row({ strike: k, type: "C", markIv: iv(k) }),
      row({ strike: k, type: "P", markIv: iv(k) }),
    ]);
  }
  const wide = [60_000, 65_000, 70_000, 75_000, 80_000, 85_000, 90_000, 95_000, 100_000, 105_000, 110_000];

  it("풋 IV > 콜 IV 면 rr 이 음이다", () => {
    const rows = smile(wide, (k) => 0.5 - (k - 80_000) / 1e6);
    const rr = riskReversal25(rows, forward, T);
    expect(rr).not.toBeNull();
    expect(rr as number).toBeLessThan(0);
    // 25Δ 콜 ≈ 97.7k, 25Δ 풋 ≈ 69.7k → 차이 ≈ −0.028.
    expect(rr as number).toBeCloseTo(-0.028, 2);
  });

  it("IV 가 평평하면 rr = 0", () => {
    expect(riskReversal25(smile(wide, () => 0.5), forward, T)).toBeCloseTo(0, 12);
  });

  it("행사가가 좁아 0.25 를 못 감싸면 null", () => {
    const rows = smile([75_000, 80_000, 85_000], (k) => 0.5 - (k - 80_000) / 1e6);
    expect(riskReversal25(rows, forward, T)).toBeNull();
  });

  it("IV 가 없는 행은 점이 되지 않는다", () => {
    const rows = smile(wide, () => 0.5).map((r) => ({ ...r, markIv: null }));
    expect(riskReversal25(rows, forward, T)).toBeNull();
  });
});

describe("gammaExposure", () => {
  const spot = 80_000;

  it("콜만 있으면 total > 0, byStrike 전부 양수·행사가 오름차순", () => {
    const rows = [
      row({ strike: 85_000, type: "C", oi: 100 }),
      row({ strike: 75_000, type: "C", oi: 100 }),
      row({ strike: 80_000, type: "C", oi: 100 }),
    ];
    const gex = gammaExposure(rows, spot, NOW);
    expect(gex.total).not.toBeNull();
    expect(gex.total as number).toBeGreaterThan(0);
    expect(gex.byStrike.map((r) => r.strike)).toEqual([75_000, 80_000, 85_000]);
    for (const r of gex.byStrike) expect(r.gex).toBeGreaterThan(0);
    // 부호가 안 바뀌니 플립 없음.
    expect(gex.flipStrike).toBeNull();
  });

  it("풋만 있으면 total < 0", () => {
    const rows = [row({ strike: 80_000, type: "P", oi: 100 })];
    expect(gammaExposure(rows, spot, NOW).total as number).toBeLessThan(0);
  });

  it("IV 가 없거나 만기가 지난 행은 무시한다", () => {
    const base = [row({ strike: 80_000, type: "C", oi: 100 })];
    const noisy = [
      ...base,
      row({ strike: 80_000, type: "P", oi: 10_000, markIv: null }),
      row({
        strike: 80_000,
        type: "P",
        oi: 10_000,
        expiry: { expiry: "2026-09-11", expiryMs: Date.UTC(2026, 8, 11, 8) },
      }),
    ];
    expect(gammaExposure(noisy, spot, NOW).total).toBe(gammaExposure(base, spot, NOW).total);
    expect(gammaExposure(noisy, spot, NOW).byStrike).toHaveLength(1);
  });

  it("재료가 하나도 없으면 total null·byStrike 빈 배열", () => {
    const gex = gammaExposure([row({ strike: 80_000, type: "C", markIv: null })], spot, NOW);
    expect(gex).toEqual({ total: null, byStrike: [], flipStrike: null });
  });

  it("flipStrike — 풋 70k·콜 90k 가 갈리면 그 사이에 떨어진다", () => {
    const rows = [
      row({ strike: 70_000, type: "P", oi: 100 }),
      row({ strike: 90_000, type: "C", oi: 100 }),
    ];
    const gex = gammaExposure(rows, spot, NOW);
    expect(gex.byStrike.map((r) => Math.sign(r.gex))).toEqual([-1, 1]);
    expect(gex.flipStrike).not.toBeNull();
    expect(gex.flipStrike as number).toBeGreaterThan(70_000);
    expect(gex.flipStrike as number).toBeLessThan(90_000);
  });
});

describe("realizedVol", () => {
  it("종가가 일정하면 0", () => {
    expect(realizedVol(new Array<number>(31).fill(100))).toBe(0);
  });

  it("window + 1 개 미만이면 null", () => {
    expect(realizedVol(new Array<number>(30).fill(100))).toBeNull();
    expect(realizedVol([])).toBeNull();
  });

  it("손계산 — 로그수익률 ±0.01 교대 30개: 0.01·√(30/29)·√365 ≈ 0.19432", () => {
    const closes = [100];
    for (let i = 0; i < 30; i++) closes.push(i % 2 === 0 ? 100 * Math.exp(0.01) : 100);
    expect(realizedVol(closes)).toBeCloseTo(0.194316, 5);
  });

  it("손계산 — window 2, [100, 110, 99]: sd(ln1.1, ln0.9)·√365 ≈ 2.71091", () => {
    expect(realizedVol([100, 110, 99], 2)).toBeCloseTo(2.71091, 4);
  });

  it("0 이하 종가가 끼면 null — 로그가 깨진다", () => {
    expect(realizedVol([100, 0, 99], 2)).toBeNull();
  });
});

describe("analyzeOptions — 두 거래소 섞인 작은 스냅샷", () => {
  const rows: OptionRow[] = [
    // 뒤 만기를 먼저 넣어 정렬을 확인한다.
    row({ venue: "okx", expiry: DEC25, strike: 85_000, type: "C", oi: 10, vol24h: 2, markIv: 0.45, forward: 81_000 }),
    row({ venue: "okx", expiry: DEC25, strike: 75_000, type: "P", oi: 20, vol24h: null, markIv: 0.5, forward: 81_000 }),
    row({ venue: "deribit", expiry: DEC25, strike: 85_000, type: "C", oi: 30, vol24h: 5, markIv: 0.46, forward: 81_200 }),
    row({ venue: "deribit", expiry: DEC25, strike: 75_000, type: "P", oi: 40, vol24h: 6, markIv: 0.52, forward: 81_200 }),
    row({ venue: "deribit", expiry: SEP25, strike: 80_000, type: "C", oi: 5, vol24h: 1, markIv: 0.4, forward: 80_100 }),
    row({ venue: "deribit", expiry: SEP25, strike: 80_000, type: "P", oi: 7, vol24h: 1, markIv: 0.42, forward: 80_100 }),
    row({ venue: "okx", expiry: SEP25, strike: 90_000, type: "C", oi: 3, vol24h: 0.5, markIv: null, forward: null }),
    row({ venue: "okx", expiry: SEP25, strike: 70_000, type: "P", oi: 4, vol24h: null, markIv: 0.6, forward: 80_050 }),
  ];
  const alternating = [100];
  for (let i = 0; i < 30; i++) alternating.push(i % 2 === 0 ? 100 * Math.exp(0.01) : 100);

  function snapshot(overrides: Partial<OptionsSnapshot> = {}): OptionsSnapshot {
    return {
      collectedAt: new Date(NOW).toISOString(),
      indexPrice: 80_000,
      rows,
      okxFlow: null,
      okxHistory: [],
      dvol: 0.5,
      dailyCloses: alternating,
      sources: { okx: "ok", deribit: "ok", dvol: "ok", candles: "ok" },
      ...overrides,
    };
  }

  it("totals — 합산 OI·거래량·풋콜비, byVenue 는 두 거래소 고정 순서", () => {
    const { totals, spot } = analyzeOptions(snapshot(), NOW);
    expect(spot).toBe(80_000);
    expect(totals.oi).toBe(119);
    expect(totals.oiUsd).toBe(119 * 80_000);
    expect(totals.vol24h).toBeCloseTo(15.5, 12);
    expect(totals.pcrOi).toBeCloseTo(71 / 48, 12);
    expect(totals.pcrVol).toBeCloseTo(7 / 8.5, 12);
    expect(totals.byVenue).toEqual([
      { venue: "okx", oi: 37, vol24h: 2.5 },
      { venue: "deribit", oi: 82, vol24h: 13 },
    ]);
  });

  it("expiries — 만기 오름차순, 만기별 합산·맥스페인·ATM IV(deribit 행)", () => {
    const { expiries } = analyzeOptions(snapshot(), NOW);
    expect(expiries.map((e) => e.expiry)).toEqual(["2026-09-25", "2026-12-25"]);

    const [sep, dec] = expiries;
    expect(sep.callOi).toBe(8);
    expect(sep.putOi).toBe(11);
    expect(sep.callVol).toBe(1.5);
    expect(sep.putVol).toBe(1);
    expect(sep.pcrOi).toBeCloseTo(11 / 8, 12);
    // payout: 70k → 70k, 80k → 0, 90k → 50k.
    expect(sep.maxPain).toBe(80_000);
    expect(sep.forward).toBe(80_100);
    expect(sep.atmIv).toBeCloseTo(0.41, 12);
    // 행사가가 하나뿐이라 25Δ 를 못 감싼다.
    expect(sep.rr25).toBeNull();
    expect(sep.dte).toBeCloseTo(7 - 4 / 24, 9);

    expect(dec.callOi).toBe(40);
    expect(dec.putOi).toBe(60);
    expect(dec.forward).toBe(81_200);
    // deribit 행 중 81.2k 에 가까운 건 85k 콜(0.46).
    expect(dec.atmIv).toBeCloseTo(0.46, 12);
  });

  it("strikesByExpiry.all·walls — 현재가 위 콜 OI 최대 85k, 아래 풋 OI 최대 75k", () => {
    const { strikesByExpiry, walls } = analyzeOptions(snapshot(), NOW);
    expect(Object.keys(strikesByExpiry).sort()).toEqual(["2026-09-25", "2026-12-25", "all"]);
    expect(strikesByExpiry.all).toEqual([
      { strike: 70_000, callOi: 0, putOi: 4 },
      { strike: 75_000, callOi: 0, putOi: 60 },
      { strike: 80_000, callOi: 5, putOi: 7 },
      { strike: 85_000, callOi: 40, putOi: 0 },
      { strike: 90_000, callOi: 3, putOi: 0 },
    ]);
    expect(walls).toEqual({ callWall: 85_000, putWall: 75_000 });
  });

  it("ivVenue·ivTerm·변동성 — deribit 우선, RV 는 손계산값, IV−RV", () => {
    const result = analyzeOptions(snapshot(), NOW);
    expect(result.ivVenue).toBe("deribit");
    expect(result.ivTerm.map((p) => p.expiry)).toEqual(["2026-09-25", "2026-12-25"]);
    expect(result.ivTerm[0].atmIv).toBeCloseTo(0.41, 12);
    expect(result.rv30).toBeCloseTo(0.194316, 5);
    expect(result.dvol).toBe(0.5);
    expect(result.ivMinusRv).toBeCloseTo(0.5 - 0.194316, 5);
  });

  it("gex — IV 없는 90k 콜은 빠지고 나머지 행사가가 오름차순으로 남는다", () => {
    const { gex } = analyzeOptions(snapshot(), NOW);
    expect(gex.total).not.toBeNull();
    expect(gex.byStrike.map((r) => r.strike)).toEqual([70_000, 75_000, 80_000, 85_000]);
  });

  it("deribit 행을 빼면 ivVenue 가 okx 고 IV 지표도 okx 행으로 낸다", () => {
    const okxOnly = rows.filter((r) => r.venue === "okx");
    const result = analyzeOptions(snapshot({ rows: okxOnly }), NOW);
    expect(result.ivVenue).toBe("okx");
    const sep = result.expiries[0];
    // okx 9/25 행: 90k 콜(IV 없음)·70k 풋(0.6) → 선도가는 첫 non-null 80_050, ATM 은 70k 풋.
    expect(sep.forward).toBe(80_050);
    expect(sep.atmIv).toBe(0.6);
  });

  it("IV 가 전혀 없으면 ivVenue null·IV 지표 null·선도가도 null(현물을 선도가로 찍지 않는다)", () => {
    const noIv = rows.map((r) => ({ ...r, markIv: null }));
    const result = analyzeOptions(snapshot({ rows: noIv }), NOW);
    expect(result.ivVenue).toBeNull();
    expect(result.ivTerm).toEqual([]);
    expect(result.expiries.every((e) => e.atmIv === null && e.rr25 === null)).toBe(true);
    expect(result.expiries[0].forward).toBeNull();
    expect(result.gex).toEqual({ total: null, byStrike: [], flipStrike: null });
  });

  it("indexPrice 가 없으면 oiUsd·gex.total·벽이 전부 null — 위/아래가 없는데 벽을 고르지 않는다", () => {
    const result = analyzeOptions(snapshot({ indexPrice: null }), NOW);
    expect(result.spot).toBeNull();
    expect(result.totals.oiUsd).toBeNull();
    expect(result.gex).toEqual({ total: null, byStrike: [], flipStrike: null });
    expect(result.walls).toEqual({ callWall: null, putWall: null });
    expect(result.expiries[0].forward).toBe(80_100);
  });

  it("IV 거래소 행에 선도가가 없으면 표의 선도가는 null 이고, ATM IV 는 현물을 기준점으로 낸다", () => {
    const base = snapshot({});
    const rows = base.rows.map((r) => ({ ...r, forward: null }));
    const result = analyzeOptions({ ...base, rows }, NOW);
    expect(result.expiries[0].forward).toBeNull();
    expect(result.expiries[0].atmIv).not.toBeNull();
  });

  it("GEX 크기 — 콜 하나, S=K=80,000·σ=0.5·T=0.25·OI 100: Γ_F·OI·F·S·0.01 ≈ 126,668", () => {
    const expiryMs = NOW + 0.25 * 365 * 86_400_000;
    const call: OptionRow = {
      venue: "deribit",
      instId: "deribit-test-80000-C",
      expiry: "test",
      expiryMs,
      strike: 80_000,
      type: "C",
      oi: 100,
      vol24h: 0,
      markIv: 0.5,
      forward: 80_000,
    };
    const { total } = gammaExposure([call], 80_000, NOW);
    // d1 = 0.125, φ(d1) = 0.395838, Γ_F = φ/(F·σ·√T) = 1.97919e-5 → × 100 × 80,000² × 0.01
    expect(total).not.toBeNull();
    expect(total as number).toBeGreaterThan(126_500);
    expect(total as number).toBeLessThan(126_850);
  });

  it("dvol 이나 종가가 없으면 ivMinusRv 는 null", () => {
    expect(analyzeOptions(snapshot({ dvol: null }), NOW).ivMinusRv).toBeNull();
    const short = analyzeOptions(snapshot({ dailyCloses: [100, 101] }), NOW);
    expect(short.rv30).toBeNull();
    expect(short.ivMinusRv).toBeNull();
  });

  it("행이 없어도 모양은 유지된다", () => {
    const result = analyzeOptions(snapshot({ rows: [] }), NOW);
    expect(result.totals.oi).toBe(0);
    expect(result.totals.pcrOi).toBeNull();
    expect(result.totals.byVenue).toEqual([
      { venue: "okx", oi: 0, vol24h: 0 },
      { venue: "deribit", oi: 0, vol24h: 0 },
    ]);
    expect(result.expiries).toEqual([]);
    expect(result.strikesByExpiry).toEqual({ all: [] });
    expect(result.walls).toEqual({ callWall: null, putWall: null });
    expect(result.gex).toEqual({ total: null, byStrike: [], flipStrike: null });
  });
});

describe("pickHeadline — 일주일 이상 남은 첫 만기, 없으면 첫 만기", () => {
  it("만기 직전 점을 건너뛰고 화면 D-day(올림)가 7 이상인 첫 점을 고른다 — 6.2일은 D-7 이라 포함", () => {
    const points = [{ dte: 0.8 }, { dte: 2 }, { dte: 6.2 }, { dte: 42 }];
    expect(HEADLINE_MIN_DTE).toBe(7);
    expect(pickHeadline(points)).toBe(points[2]);
    expect(pickHeadline([{ dte: 6 }, { dte: 42 }])).toEqual({ dte: 42 });
  });

  it("전부 일주일 안이면 첫 점, 비어 있으면 null", () => {
    const points = [{ dte: 0.8 }, { dte: 2 }];
    expect(pickHeadline(points)).toBe(points[0]);
    expect(pickHeadline([])).toBeNull();
  });
});
