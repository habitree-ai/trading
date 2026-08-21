import { describe, expect, it } from "vitest";

import { assessSystemHealth, type SystemHealthInput } from "@/lib/system-health";
import type { SystemEquityPoint, SystemState, SystemTrade } from "@/lib/system-trading";

const H = 3600_000;
/** 4H 봉 마감 시각 하나를 기준점으로 잡는다 — 2026-08-21T00:00Z. */
const CLOSE = Date.UTC(2026, 7, 21, 0, 0, 0);
/** 봇은 마감 2분 뒤에 돈다. */
const CYCLE = CLOSE + 2 * 60_000;

function state(over: Partial<SystemState> = {}): SystemState {
  return {
    mode: "live",
    createdAt: CLOSE - 5 * 24 * H,
    updatedAt: CYCLE,
    equity: null,
    liveEnabled: false,
    // 마지막으로 평가한 봉 = 방금 마감한 봉의 시작(마감 4시간 전).
    lastBarTs: { gc: CLOSE - 4 * H, ob: CLOSE - 4 * H, fade: CLOSE - 4 * H },
    positions: {},
    ...over,
  };
}

/** 마감마다 하나씩 남은 잔고 스냅샷 — 정상 운전의 모습. */
function equityEvery4h(count: number, until = CYCLE): SystemEquityPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    at: until - (count - 1 - i) * 4 * H,
    equity: 100,
    openMembers: [],
  })).sort((a, b) => a.at - b.at);
}

/** 한 사이클이 남기는 판정 한 줄 — 경고 없는 평범한 평가. */
function decision(at: number): SystemHealthInput["decisions"][number] {
  return {
    at,
    member: "gc",
    tf: "4H",
    barTs: CLOSE - 4 * H,
    fired: false,
    action: "none",
    skip: null,
    warn: null,
    indicators: null,
  };
}

function input(over: Partial<SystemHealthInput> = {}): SystemHealthInput {
  return {
    mode: "live",
    real: true,
    state: state(),
    equity: equityEvery4h(12),
    decisions: [decision(CYCLE)],
    trades: [],
    now: CLOSE + 70 * 60_000, // 마감 70분 뒤 — 사이클은 이미 돌았다
    ...over,
  };
}

const check = (r: ReturnType<typeof assessSystemHealth>, id: string) =>
  r.checks.find((c) => c.id === id)!;

describe("assessSystemHealth — 봇이 돌고 있나", () => {
  it("한 주기 안에 사이클이 있으면 정상 가동이다", () => {
    const r = assessSystemHealth(input());
    expect(r.run).toBe("running");
    expect(check(r, "cycle").tone).toBe("good");
    expect(check(r, "cadence").value).toBe("6/6회");
    expect(check(r, "bars").value).toBe("최신 봉까지");
  });

  it("한 주기를 넘기면 지연, 두 주기를 넘기면 멈춤이다", () => {
    const late = assessSystemHealth(input({ now: CYCLE + 5 * H }));
    expect(late.run).toBe("late");

    const down = assessSystemHealth(input({ now: CYCLE + 10 * H }));
    expect(down.run).toBe("down");
    expect(check(down, "cycle").tone).toBe("bad");
  });

  /**
   * PC 가 자다 깨면 마지막 사이클은 방금이어도 그 사이 봉이 통째로 빈다.
   * "지금 살아 있다"가 "빠짐없이 돌았다"를 뜻하지 않는다는 것이 이 점검의 이유다.
   */
  it("마지막 사이클이 최신이어도 중간에 빈 봉이 있으면 잡아낸다", () => {
    const full = equityEvery4h(12);
    const holed = full.filter((p) => p.at !== CYCLE - 8 * H && p.at !== CYCLE - 12 * H);
    const r = assessSystemHealth(input({ equity: holed }));

    expect(r.run).toBe("running");
    expect(check(r, "cadence").tone).toBe("bad");
    expect(check(r, "cadence").value).toBe("4/6회");
  });

  it("방금 닫힌 봉은 유예 안에서는 놓친 것으로 세지 않는다", () => {
    // 마감 5분 뒤 — 정상이어도 이 봉의 기록은 아직 없다.
    const r = assessSystemHealth(input({ now: CLOSE + 5 * 60_000, equity: equityEvery4h(12, CLOSE - 4 * H + 2 * 60_000), state: state({ updatedAt: CLOSE - 4 * H + 2 * 60_000, lastBarTs: { gc: CLOSE - 8 * H } }) }));
    expect(check(r, "cadence").tone).toBe("good");
  });

  it("평가가 봉을 못 따라가면 몇 봉 뒤인지 말한다", () => {
    const r = assessSystemHealth(input({ state: state({ lastBarTs: { gc: CLOSE - 12 * H } }) }));
    expect(check(r, "bars").value).toBe("2봉 뒤");
    expect(check(r, "bars").tone).toBe("bad");
  });

  it("판정만 남고 잔고 스냅샷이 빠지면 기록 적재를 의심한다", () => {
    const r = assessSystemHealth(
      input({
        equity: equityEvery4h(12, CYCLE - 4 * H),
        decisions: [decision(CYCLE)],
      }),
    );
    expect(check(r, "sink").tone).toBe("warn");
  });

  /**
   * 킬스위치를 누르면 상태 행의 updated_at 이 움직인다 — 그걸 신선도의 근거로 삼으면
   * 봇이 죽어 있어도 "방금 돌았다"가 된다. 신선도는 봇이 남긴 기록만 본다.
   */
  it("사람이 상태 행을 건드려도 신선도는 속지 않는다", () => {
    const touched = state({ updatedAt: CLOSE + 60 * 60_000, liveEnabled: true });
    const r = assessSystemHealth(
      input({ state: touched, equity: equityEvery4h(12, CYCLE - 12 * H), now: CYCLE + 12 * H }),
    );
    expect(r.run).toBe("down");
  });

  it("상태의 열린 포지션과 거래 표가 갈리면 이상이다", () => {
    const open = {
      at: CYCLE,
      tradeId: "gc-1",
      member: "gc",
      name: "골든크로스",
      side: "long",
      open: true,
      entryTs: CYCLE - 4 * H,
      exitTs: CYCLE - 4 * H,
      entryPrice: 60_000,
      exitPrice: 0,
      exitType: "unknown",
      lev: 10,
      netPct: 0,
    } satisfies SystemTrade;

    const r = assessSystemHealth(input({ trades: [open] }));
    expect(check(r, "positions").tone).toBe("bad");
    expect(check(r, "positions").detail).toContain("gc(거래표만)");
  });

  it("경고가 있으면 건수와 최근 시각을 세운다", () => {
    const r = assessSystemHealth(
      input({
        decisions: [
          { at: CYCLE, member: "fade", tf: "4H", barTs: CLOSE - 4 * H, fired: true, action: "skip", skip: null, warn: "주문 수량 미달(sz=0) — 진입 생략", indicators: null },
          { at: CYCLE - 4 * H, member: "gc", tf: "4H", barTs: CLOSE - 8 * H, fired: false, action: "none", skip: null, warn: null, indicators: null },
        ],
      }),
    );
    expect(check(r, "warns").value).toBe("1건");
    expect(check(r, "warns").tone).toBe("bad");
  });

  it("실계좌에서는 실주문 게이트가 열렸는지 밝힌다", () => {
    const off = assessSystemHealth(input());
    expect(check(off, "gate").value).toBe("실주문 차단");

    const on = assessSystemHealth(input({ state: state({ liveEnabled: true }) }));
    expect(check(on, "gate").value).toBe("실주문 허용");

    const paper = assessSystemHealth(input({ mode: "paper", real: false }));
    expect(paper.checks.find((c) => c.id === "gate")).toBeUndefined();
  });

  it("수동 클릭 모드에는 지연이라는 것이 없다", () => {
    const r = assessSystemHealth(input({ mode: "manual", real: false, now: CYCLE + 30 * H }));
    expect(r.run).toBe("manual");
    expect(r.nextCycleAt).toBeNull();
    expect(r.checks.find((c) => c.id === "cadence")).toBeUndefined();
  });
});
