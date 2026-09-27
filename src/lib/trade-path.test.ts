import { describe, expect, it } from "vitest";

import type { Candle } from "@/lib/okx";
import { pickPathBar, reviewPath, summarizePathReviews, type PathInput, type PathReview } from "@/lib/trade-path";

const M = 60_000;
const T0 = Date.UTC(2026, 8, 20, 0, 0);

/** 1분봉 — [고가, 저가] 만 의미 있다 */
function bars(hl: [number, number][], start = T0): Candle[] {
  return hl.map(([h, l], i) => ({ t: start + i * M, o: (h + l) / 2, h, l, c: (h + l) / 2, v: 1 }));
}

const base: PathInput = {
  side: "long",
  entryMs: T0,
  entryPrice: 100,
  exitMs: T0 + 5 * M,
  exitPrice: 110,
  tp: 110,
  stop: 90,
  leverage: 10,
  nowMs: T0 + 100 * M,
};

describe("pickPathBar", () => {
  it("3800봉 안에 드는 가장 짧은 봉", () => {
    expect(pickPathBar(60 * M)).toBe("1m");
    expect(pickPathBar(3 * 24 * 60 * M)).toBe("5m"); // 4320분 > 3800
    expect(pickPathBar(30 * 24 * 60 * M)).toBe("15m");
  });
});

describe("reviewPath", () => {
  it("롱 — 1차 수익 → 최대손실 → TP 도달", () => {
    const c = bars([
      [101, 99], // 진입 봉
      [106, 101], // 1차 최대수익 106
      [103, 92], // 최대손실 92
      [104, 95],
      [111, 100], // TP
      [115, 105], // TP 뒤 — 경로 밖
    ]);
    const r = reviewPath(base, c, "1m")!;
    expect(r.peak).toMatchObject({ ms: T0 + M, price: 106, elapsedMs: M });
    expect(r.peak!.pct).toBeCloseTo(6);
    expect(r.peak!.marginPct).toBeCloseTo(60);
    expect(r.peakFirst).toBe(true);
    expect(r.trough).toMatchObject({ ms: T0 + 2 * M, price: 92 });
    expect(r.trough!.pct).toBeCloseTo(-8);
    expect(r.tp).toMatchObject({ ms: T0 + 4 * M, price: 110, elapsedMs: 4 * M });
    expect(r.exit).toBeNull();
    // 손절폭 10% 중 8% 역행 = 80% → 손절라인(90%) 아님. 역행이 경로 50% 지점 → 타점(25%) 아님.
    // 1차 수익 6% / TP 거리 10% = 60% → 수익라인(70%) 아님.
    expect(r.verdicts).toEqual([]);
  });

  it("숏 — 방향이 뒤집힌다", () => {
    const c = bars([
      [101, 99],
      [99, 95], // 1차 최대수익 95
      [108, 97], // 최대손실 108
      [96, 89], // TP 90
    ]);
    const r = reviewPath({ ...base, side: "short", tp: 90, stop: 110, exitPrice: 90 }, c, "1m")!;
    expect(r.peak).toMatchObject({ price: 95 });
    expect(r.peak!.pct).toBeCloseTo(5);
    expect(r.trough).toMatchObject({ price: 108 });
    expect(r.trough!.pct).toBeCloseTo(-8);
    expect(r.tp).toMatchObject({ ms: T0 + 3 * M, price: 90 });
  });

  it("손실 먼저 — 진입 직후 크게 역행하면 타점·손절라인 후보", () => {
    const c = bars([
      [100.5, 90.5], // 진입 봉에서 손절폭 95% 역행
      [102, 96],
      [104, 99],
      [106, 101],
      [108, 103],
      [111, 106], // TP
    ]);
    const r = reviewPath({ ...base, exitMs: T0 + 10 * M }, c, "1m")!;
    expect(r.peakFirst).toBe(false);
    expect(r.trough).toMatchObject({ ms: T0, elapsedMs: 0, price: 90.5 });
    expect(r.peak).toMatchObject({ price: 108 }); // TP 봉은 뺀다
    expect(r.verdicts.map((v) => v.key)).toEqual(["entry", "hold-stop"]);
  });

  it("TP 미도달 청산 — 청산점, 청산 뒤 TP 도달이면 기다림", () => {
    const c = bars([
      [101, 99],
      [108, 100], // 1차 최대수익 108 = TP 거리 80%
      [104, 97], // 최대손실 97
      [103, 100], // 청산 봉
      [105, 101],
      [110.5, 104], // 청산 뒤 TP
    ]);
    const r = reviewPath({ ...base, exitMs: T0 + 3 * M + 30_000, exitPrice: 102 }, c, "1m")!;
    expect(r.tp).toBeNull();
    expect(r.exit).toMatchObject({ ms: T0 + 3 * M + 30_000, price: 102 });
    expect(r.exit!.pct).toBeCloseTo(2);
    expect(r.tpAfterExit).toEqual({ ms: T0 + 5 * M, afterExitMs: 90_000 });
    expect(r.verdicts.map((v) => v.key)).toEqual(["hold-profit", "wait"]);
  });

  it("손절 미기록·TP 없음 — 판정 생략 사유만", () => {
    const c = bars([
      [101, 99],
      [103, 95],
    ]);
    const r = reviewPath({ ...base, stop: null, tp: null, leverage: null, exitMs: T0 + M, exitPrice: 97 }, c, "1m")!;
    expect(r.tp).toBeNull();
    expect(r.trough!.marginPct).toBeNull();
    expect(r.verdicts).toEqual([]);
    expect(r.skipped).toHaveLength(2);
  });

  it("역행이 한 번도 없으면 최대손실 없음", () => {
    const c = bars([
      [102, 100],
      [111, 101],
    ]);
    const r = reviewPath(base, c, "1m")!;
    expect(r.trough).toBeNull();
    expect(r.peakFirst).toBe(true);
    expect(r.peak).toMatchObject({ price: 102 });
    expect(r.tp).not.toBeNull();
  });

  it("보유중 — 끝은 지금, 청산점 없음", () => {
    const c = bars([
      [101, 98],
      [104, 99],
    ]);
    const r = reviewPath({ ...base, exitMs: null, exitPrice: null, nowMs: T0 + 90_000 }, c, "1m")!;
    expect(r.exit).toBeNull();
    expect(r.tpAfterExit).toBeNull();
    expect(r.peak).toMatchObject({ price: 104 });
  });

  it("경로에 봉이 없으면 null", () => {
    expect(reviewPath(base, [], "1m")).toBeNull();
  });
});

describe("summarizePathReviews", () => {
  const pt = (elapsedMs: number) => ({ ms: 0, price: 0, elapsedMs, pct: 0, marginPct: null });
  const rv = (keys: PathReview["verdicts"][number]["key"][], o: Partial<PathReview> = {}): PathReview => ({
    bar: "1m", peak: null, peakFirst: true, trough: null, tp: null, exit: null, tpAfterExit: null, skipped: [],
    verdicts: keys.map((key) => ({ key, label: key, reason: "" })),
    ...o,
  });

  it("판정별 건수·순손익, 복수 판정은 각각, 없으면 clean", () => {
    const s = summarizePathReviews([
      { review: rv(["entry", "hold-stop"], { trough: pt(60_000) }), net: -10 },
      { review: rv(["hold-profit"], { peak: pt(120_000), trough: pt(300_000), tp: pt(600_000) }), net: 5 },
      { review: rv(["hold-profit"], { peak: pt(240_000) }), net: -3 },
      { review: rv([], { tp: pt(1_200_000) }), net: 8 },
    ]);
    expect(s.total).toBe(4);
    expect(s.byVerdict.entry).toEqual({ count: 1, net: -10 });
    expect(s.byVerdict["hold-stop"]).toEqual({ count: 1, net: -10 });
    expect(s.byVerdict["hold-profit"]).toEqual({ count: 2, net: 2 });
    expect(s.byVerdict.wait).toEqual({ count: 0, net: 0 });
    expect(s.clean).toEqual({ count: 1, net: 8 });
    expect(s.tpReached).toBe(2);
    expect(s.avgToPeakMs).toBe(180_000);
    expect(s.avgToTroughMs).toBe(180_000);
    expect(s.avgToTpMs).toBe(900_000);
    expect(s.top).toBe("hold-profit");
  });

  it("비어 있으면 평균·top 은 null", () => {
    const s = summarizePathReviews([]);
    expect(s.top).toBeNull();
    expect(s.avgToTpMs).toBeNull();
  });
});
