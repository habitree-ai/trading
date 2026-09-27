import { describe, expect, it } from "vitest";

import type { Trade } from "@/lib/domain";
import type { Candle } from "@/lib/okx";
import {
  pathRequest,
  pickPathBar,
  reviewPath,
  summarizePathReviews,
  type PathInput,
  type PathPoint,
  type PathReview,
  type VerdictKey,
} from "@/lib/trade-path";

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
  notional: 1000,
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
  it("롱 — 청산 전 TP 도달: 도달점·도달 전 최대손실·최대수익, 청산점은 따로", () => {
    const c = bars([
      [101, 99], // 진입 봉
      [106, 101], // 도달 전 최대수익 106
      [103, 96], // 도달 전 최대손실 96
      [104, 98],
      [111, 100], // TP
      [115, 105], // TP 뒤 — 추적 밖
    ]);
    const r = reviewPath(base, c, "1m")!;
    expect(r.tp).toMatchObject({ ms: T0 + 4 * M, price: 110, elapsedMs: 4 * M });
    expect(r.tp!.pct).toBeCloseTo(10);
    expect(r.tp!.marginPct).toBeCloseTo(100);
    expect(r.trough).toMatchObject({ ms: T0 + 2 * M, price: 96, elapsedMs: 2 * M });
    expect(r.trough!.pct).toBeCloseTo(-4);
    expect(r.peak).toMatchObject({ ms: T0 + M, price: 106 });
    expect(r.peak!.pct).toBeCloseTo(6);
    expect(r.stopHit).toBeNull();
    expect(r.exit).toMatchObject({ ms: T0 + 5 * M, price: 110 });
    expect(r.status).toBe("reached");
    expect(r.tpVsExit).toBe("before-exit");
    expect(r.analyzedUntilMs).toBe(T0 + 4 * M);
    // 손절폭 10% 중 4% 역행 = 40% → 진입의 문제(50%) 아님.
    expect(r.verdicts).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("TP 봉의 저가도 최대손실에 넣는다(봉 안 순서를 모르니 보수적으로)", () => {
    const c = bars([
      [101, 99],
      [111, 93], // 같은 봉에서 93 까지 밀렸다가 TP
    ]);
    const r = reviewPath(base, c, "1m")!;
    expect(r.tp).toMatchObject({ ms: T0 + M });
    expect(r.trough).toMatchObject({ ms: T0 + M, price: 93 });
    expect(r.peak).toMatchObject({ ms: T0, price: 101 }); // TP 봉은 최대수익에서 뺀다
    expect(r.verdicts.map((v) => v.key)).toEqual(["entry"]);
    expect(r.verdicts[0].reason).toBe("도달 전 손절폭의 70% 역행");
  });

  it("숏 — 방향이 뒤집힌다", () => {
    const c = bars([
      [101, 99],
      [99, 95], // 최대수익 95
      [108, 97], // 최대손실 108
      [96, 89], // TP 90
    ]);
    const r = reviewPath({ ...base, side: "short", tp: 90, stop: 110, exitPrice: 90 }, c, "1m")!;
    expect(r.peak).toMatchObject({ price: 95 });
    expect(r.peak!.pct).toBeCloseTo(5);
    expect(r.trough).toMatchObject({ price: 108 });
    expect(r.trough!.pct).toBeCloseTo(-8);
    expect(r.tp).toMatchObject({ ms: T0 + 3 * M, price: 90 });
    expect(r.stopHit).toBeNull();
    expect(r.verdicts.map((v) => v.key)).toEqual(["entry"]);
    expect(r.verdicts[0].reason).toBe("도달 전 손절폭의 80% 역행");
  });

  it("청산 뒤 도달 — tp 가 채워지고 after-exit, 조급한 청산", () => {
    const c = bars([
      [101, 99],
      [104, 100],
      [103, 97], // 최대손실 97
      [103, 100], // 청산 봉
      [105, 101],
      [110.5, 104], // 청산 뒤 TP
    ]);
    const r = reviewPath({ ...base, exitMs: T0 + 3 * M + 30_000, exitPrice: 102 }, c, "1m")!;
    expect(r.tp).toMatchObject({ ms: T0 + 5 * M, price: 110, elapsedMs: 5 * M });
    expect(r.exit).toMatchObject({ ms: T0 + 3 * M + 30_000, price: 102 });
    expect(r.exit!.pct).toBeCloseTo(2);
    expect(r.status).toBe("reached");
    expect(r.tpVsExit).toBe("after-exit");
    expect(r.trough).toMatchObject({ price: 97 });
    expect(r.verdicts).toEqual([{ key: "wait", label: "조급한 청산", reason: "청산 1분 30초 뒤 TP 도달" }]);
  });

  it("손절선 먼저 닿고 계속 추적해 도달 — stopHit + tp, 손절폭의 문제(손절선 넘김, REQ-0083)", () => {
    const c = bars([
      [101, 99],
      [100, 89], // 손절선 90 도달, 최대손실 89
      [95, 91],
      [103, 99],
      [111, 105], // TP
    ]);
    const r = reviewPath({ ...base, exitMs: T0 + M + 30_000, exitPrice: 89.5 }, c, "1m")!;
    expect(r.stopHit).toMatchObject({ ms: T0 + M, price: 90, elapsedMs: M });
    expect(r.stopHit!.pct).toBeCloseTo(-10);
    expect(r.trough).toMatchObject({ ms: T0 + M, price: 89 });
    expect(r.tp).toMatchObject({ ms: T0 + 4 * M, price: 110 });
    expect(r.status).toBe("reached");
    expect(r.tpVsExit).toBe("after-exit");
    expect(r.verdicts.map((v) => v.key)).toEqual(["stop", "wait"]);
    expect(r.verdicts[0].reason).toBe("손절선 넘김(손절폭의 110%) 뒤 도달");
    expect(r.verdicts[1].reason).toBe("청산 2분 30초 뒤 TP 도달");

    // 저가가 손절가와 정확히 같아도(손절폭의 100%) 손절선에 닿은 것 — stopHit 과 같은 편에 선다
    const edge = bars([
      [101, 99],
      [100, 90],
      [111, 105],
    ]);
    const r2 = reviewPath({ ...base, exitMs: null, exitPrice: null }, edge, "1m")!;
    expect(r2.stopHit).toMatchObject({ price: 90 });
    expect(r2.verdicts.map((v) => v.key)).toEqual(["stop"]);
    expect(r2.verdicts[0].reason).toBe("손절선 넘김(손절폭의 100%) 뒤 도달");
  });

  // 청산됐는데 끝까지 110 못 닿는 경로 — 최대수익 108(TP 거리 80%), 최대손실 97, 청산 봉은 넷째.
  const unreached = bars([
    [101, 99],
    [108, 100],
    [104, 97],
    [103, 100],
    [105, 101],
    [106, 104],
  ]);

  it("손실 청산·미도달 — closed-unreached, 방향성 실패 + TP 거리 70%↑면 목표가의 문제", () => {
    const r = reviewPath({ ...base, exitMs: T0 + 3 * M + 30_000, exitPrice: 98 }, unreached, "1m")!;
    expect(r.tp).toBeNull();
    expect(r.status).toBe("closed-unreached");
    expect(r.tpVsExit).toBe("unreached");
    expect(r.exit).toMatchObject({ ms: T0 + 3 * M + 30_000, price: 98 });
    expect(r.analyzedUntilMs).toBe(T0 + 5 * M);
    expect(r.peak).toMatchObject({ price: 108 });
    expect(r.trough).toMatchObject({ price: 97 });
    expect(r.verdicts).toEqual([
      { key: "direction", label: "방향성 실패", reason: "5분 동안 미도달" },
      { key: "target", label: "목표가의 문제", reason: "TP 거리의 80%까지 갔다가 미도달" },
    ]);
  });

  it("수익 청산·미도달 — 방향은 맞았으니 방향성 실패 대신 목표가의 문제(REQ-0082)", () => {
    const r = reviewPath({ ...base, exitMs: T0 + 3 * M + 30_000, exitPrice: 102 }, unreached, "1m")!;
    expect(r.status).toBe("closed-unreached");
    expect(r.verdicts).toEqual([
      { key: "target", label: "목표가의 문제", reason: "수익 청산 +2.00% · 최대수익은 TP 거리의 80%" },
    ]);

    // 최대수익이 70% 에 못 미쳐도 수익 청산이면 목표가의 문제 — 얼마나 못 미쳤는지 사유에 남는다
    const small = bars([
      [101, 99],
      [103, 100], // 최대수익 103 = TP 거리 30%
      [102, 100],
    ]);
    const r2 = reviewPath({ ...base, exitMs: T0 + M + 30_000, exitPrice: 101 }, small, "1m")!;
    expect(r2.verdicts).toEqual([
      { key: "target", label: "목표가의 문제", reason: "수익 청산 +1.00% · 최대수익은 TP 거리의 30%" },
    ]);

    // 본절 청산은 수익이 아니다 — 방향성 실패
    const r3 = reviewPath({ ...base, exitMs: T0 + M + 30_000, exitPrice: 100 }, small, "1m")!;
    expect(r3.verdicts.map((v) => v.key)).toEqual(["direction"]);

    // 청산가를 모르면 수익 청산인지 알 수 없다 — 방향성 실패 쪽
    const r4 = reviewPath({ ...base, exitMs: T0 + M + 30_000, exitPrice: null }, small, "1m")!;
    expect(r4.exit).toBeNull();
    expect(r4.verdicts.map((v) => v.key)).toEqual(["direction"]);
  });

  it("미도달 청산에 손절선 먼저 — 방향성 실패 사유에 붙고, 최대수익이 작으면 목표가 판정 없음", () => {
    const c = bars([
      [101, 99],
      [100, 89], // 손절선 도달
      [95, 91],
    ]);
    const r = reviewPath({ ...base, exitMs: T0 + M + 30_000, exitPrice: 89.5 }, c, "1m")!;
    expect(r.stopHit).toMatchObject({ ms: T0 + M, price: 90 });
    expect(r.status).toBe("closed-unreached");
    expect(r.verdicts).toEqual([{ key: "direction", label: "방향성 실패", reason: "2분 동안 미도달 · 손절선 먼저 도달" }]);
  });

  it("보유중 미도달 — open-unreached, 판정 없음, 지금(nowMs)까지만 본다", () => {
    const c = bars([
      [101, 98],
      [104, 99],
      [111, 100], // nowMs 뒤 봉 — 구간 밖
    ]);
    const r = reviewPath({ ...base, exitMs: null, exitPrice: null, nowMs: T0 + 90_000 }, c, "1m")!;
    expect(r.tp).toBeNull();
    expect(r.exit).toBeNull();
    expect(r.stopHit).toBeNull();
    expect(r.status).toBe("open-unreached");
    expect(r.tpVsExit).toBe("unreached");
    expect(r.analyzedUntilMs).toBe(T0 + M);
    expect(r.peak).toMatchObject({ price: 104 });
    expect(r.trough).toMatchObject({ price: 98 });
    expect(r.verdicts).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("보유중 도달 — no-exit, 청산점 없음", () => {
    const c = bars([
      [101, 99],
      [111, 100],
    ]);
    const r = reviewPath({ ...base, exitMs: null, exitPrice: null }, c, "1m")!;
    expect(r.status).toBe("reached");
    expect(r.tpVsExit).toBe("no-exit");
    expect(r.exit).toBeNull();
  });

  it("TP 없음 — 도달·판정 생략 사유만", () => {
    const c = bars([
      [101, 99],
      [103, 95],
    ]);
    const r = reviewPath({ ...base, tp: null, exitMs: T0 + M, exitPrice: 97 }, c, "1m")!;
    expect(r.tp).toBeNull();
    expect(r.status).toBe("closed-unreached");
    expect(r.tpVsExit).toBe("unreached");
    expect(r.trough).toMatchObject({ price: 95 });
    expect(r.exit).toMatchObject({ price: 97 });
    expect(r.verdicts).toEqual([]);
    expect(r.skipped).toEqual(["TP 없음 — 도달·판정 생략"]);
  });

  it("손절 미기록·무효 — 도달했어도 진입 판정 생략, stopHit 없음", () => {
    const c = bars([
      [101, 99],
      [103, 92], // 손절폭 기준을 못 세우니 진입 판정 없음
      [111, 100],
    ]);
    const r = reviewPath({ ...base, stop: null }, c, "1m")!;
    expect(r.tp).toMatchObject({ ms: T0 + 2 * M });
    expect(r.trough).toMatchObject({ price: 92 });
    expect(r.stopHit).toBeNull();
    expect(r.verdicts).toEqual([]);
    expect(r.skipped).toEqual(["손절 미기록 — 진입 판정 생략"]);

    // 롱인데 손절이 진입가 위(본절 이상) — 손절폭을 못 재니 판정은 같이 생략하되 사유는 다르다
    const r2 = reviewPath({ ...base, stop: 105 }, c, "1m")!;
    expect(r2.stopHit).toBeNull();
    expect(r2.skipped).toEqual(["손절이 진입가보다 유리한 쪽 — 진입 판정 생략"]);
  });

  it("금액 = 명목가 × pct/100, 명목가·레버리지 없으면 null", () => {
    const c = bars([
      [101, 99],
      [106, 101],
      [103, 96],
      [104, 98],
      [111, 100],
    ]);
    const r = reviewPath(base, c, "1m")!;
    expect(r.tp!.amount).toBeCloseTo(100);
    expect(r.trough!.amount).toBeCloseTo(-40);
    expect(r.peak!.amount).toBeCloseTo(60);
    expect(r.exit!.amount).toBeCloseTo(100);

    const r2 = reviewPath({ ...base, notional: null, leverage: null }, c, "1m")!;
    expect(r2.tp!.amount).toBeNull();
    expect(r2.trough!.amount).toBeNull();
    expect(r2.tp!.marginPct).toBeNull();
  });

  it("경로에 봉이 없으면 null", () => {
    expect(reviewPath(base, [], "1m")).toBeNull();
  });
});

describe("pathRequest", () => {
  const trade = {
    side: "long",
    entry_at: "2026-09-20T00:00:00Z",
    exit_at: "2026-09-20T00:05:00Z",
    entry_price: 100,
    exit_price: 110,
    notional: 1000,
    leverage: 10,
    stop_price: 90,
    okx_stop_price: null,
    tp1_price: 110,
    tp2_price: null,
    tp3_price: null,
    okx_tp_price: null,
  } as Trade;

  it("끝은 청산과 무관하게 지금까지, notional 을 넘긴다", () => {
    const now = T0 + 100 * M;
    const q = pathRequest(trade, now);
    expect(q.bar).toBe("1m");
    expect(q.from).toBe(T0);
    expect(q.to).toBe(now + M);
    expect(q.input).toMatchObject({ side: "long", entryMs: T0, entryPrice: 100, exitMs: T0 + 5 * M, exitPrice: 110, tp: 110, stop: 90, leverage: 10, notional: 1000, nowMs: now });
  });

  it("청산이 5분 뒤여도 지금이 10일 뒤면 봉은 10일 기준", () => {
    const now = T0 + 10 * 24 * 60 * M;
    const q = pathRequest(trade, now);
    expect(q.bar).toBe("5m"); // 14400분 → 1m 은 3800봉 초과
    expect(q.to).toBe(now + 5 * M);
  });

  it("진입가가 없으면 input 은 null", () => {
    expect(pathRequest({ ...trade, entry_price: null }, T0 + M).input).toBeNull();
  });
});

describe("summarizePathReviews", () => {
  const pt = (elapsedMs: number, amount: number | null = null): PathPoint => ({ ms: 0, price: 0, elapsedMs, pct: 0, marginPct: null, amount });
  const rv = (status: PathReview["status"], keys: VerdictKey[], o: Partial<PathReview> = {}): PathReview => ({
    bar: "1m", analyzedUntilMs: 0, tp: null, trough: null, peak: null, stopHit: null, exit: null, status, tpVsExit: "unreached", skipped: [],
    verdicts: keys.map((key) => ({ key, label: key, reason: "" })),
    ...o,
  });

  it("판정별 건수·순손익, 보유중은 pending, 청산됐고 판정 없으면 clean, 최대손실 평균 금액", () => {
    const s = summarizePathReviews([
      { review: rv("reached", ["entry"], { tp: pt(600_000), trough: pt(60_000, -50) }), net: 5 },
      { review: rv("closed-unreached", ["direction", "target"], { trough: pt(120_000, -30) }), net: -10 },
      { review: rv("open-unreached", [], { trough: pt(30_000, null) }), net: null },
      { review: rv("reached", ["wait"], { tp: pt(1_200_000) }), net: 3 },
      { review: rv("reached", [], { tp: pt(300_000), trough: pt(90_000, -10) }), net: 8 },
      { review: rv("reached", ["entry"], { tp: pt(900_000) }), net: -2 },
    ]);
    expect(s.total).toBe(6);
    expect(s.byVerdict.direction).toEqual({ count: 1, net: -10 });
    expect(s.byVerdict.entry).toEqual({ count: 2, net: 3 });
    expect(s.byVerdict.stop).toEqual({ count: 0, net: 0 });
    expect(s.byVerdict.target).toEqual({ count: 1, net: -10 });
    expect(s.byVerdict.wait).toEqual({ count: 1, net: 3 });
    expect(s.clean).toEqual({ count: 1, net: 8 });
    expect(s.pending).toBe(1);
    expect(s.tpReached).toBe(4);
    expect(s.avgToTpMs).toBe(750_000);
    expect(s.avgTroughAmount).toBe(-30);
    expect(s.top).toBe("entry");
  });

  it("보유중(net null)인데 TP 에 닿아 판정에 걸리면 건수만 세고 순손익 합에는 넣지 않는다", () => {
    const s = summarizePathReviews([
      { review: rv("reached", ["entry"], { tp: pt(600_000) }), net: null },
      { review: rv("reached", [], { tp: pt(300_000) }), net: null },
      { review: rv("reached", ["entry"], { tp: pt(900_000) }), net: -2 },
    ]);
    expect(s.byVerdict.entry).toEqual({ count: 2, net: -2 });
    expect(s.clean).toEqual({ count: 1, net: 0 });
    expect(s.pending).toBe(0);
  });

  it("동수면 VERDICT_KEYS 앞선 것이 top", () => {
    const s = summarizePathReviews([
      { review: rv("closed-unreached", ["direction"]), net: -1 },
      { review: rv("reached", ["wait"]), net: 1 },
    ]);
    expect(s.top).toBe("direction");
  });

  it("비어 있으면 평균·top 은 null, pending 0", () => {
    const s = summarizePathReviews([]);
    expect(s.top).toBeNull();
    expect(s.avgToTpMs).toBeNull();
    expect(s.avgTroughAmount).toBeNull();
    expect(s.pending).toBe(0);
  });
});
