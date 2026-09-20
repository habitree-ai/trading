import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildOptionsSnapshot,
  collectOptionsSnapshot,
  type OkxOptionsBundle,
  type SettledOptionSources,
} from "@/lib/options/collect";
import { fetchDeribitIndexPrice, fetchDeribitOptions, fetchDvol } from "@/lib/options/deribit";
import { fetchOkxDailyCloses, fetchOkxIndexPrice, fetchOkxOptions } from "@/lib/options/okx";
import type { OptionRow } from "@/lib/options/types";

// 수집기 테스트는 fetch 계층을 통째로 바꿔 끼운다 — 여기서 검증할 것은 조립·throw 규칙뿐이다.
vi.mock("@/lib/options/okx", () => ({
  fetchOkxOptions: vi.fn(),
  fetchOkxIndexPrice: vi.fn(),
  fetchOkxDailyCloses: vi.fn(),
}));
vi.mock("@/lib/options/deribit", () => ({
  fetchDeribitOptions: vi.fn(),
  fetchDvol: vi.fn(),
  fetchDeribitIndexPrice: vi.fn(),
}));

const NOW_ISO = "2026-09-18T12:00:00.000Z";

function ok<T>(value: T): PromiseFulfilledResult<T> {
  return { status: "fulfilled", value };
}

function fail(message: string): PromiseRejectedResult {
  return { status: "rejected", reason: new Error(message) };
}

function row(venue: OptionRow["venue"], strike: number, type: OptionRow["type"]): OptionRow {
  const instId =
    venue === "okx" ? `BTC-USD-260925-${strike}-${type}` : `BTC-25SEP26-${strike}-${type}`;
  return {
    venue,
    instId,
    expiry: "2026-09-25",
    expiryMs: Date.UTC(2026, 8, 25, 8),
    strike,
    type,
    oi: 10,
    vol24h: 1,
    markIv: 0.38,
    forward: 78_000,
  };
}

function okxBundle(): OkxOptionsBundle {
  return {
    rows: [row("okx", 80_000, "C"), row("okx", 70_000, "P")],
    flow: { ts: 1, callBuy: 9, callSell: 8, putBuy: 10, putSell: 8, callBlock: 3, putBlock: 3 },
    history: [{ t: 1, oi: 30_000, vol: 4_000, pcrOi: 0.6, pcrVol: 0.9 }],
  };
}

/** 전부 성공한 기본 조합 — 각 케이스가 필요한 소스만 덮어쓴다. */
function allOk(): SettledOptionSources {
  return {
    okx: ok(okxBundle()),
    deribit: ok([row("deribit", 80_000, "C"), row("deribit", 70_000, "P")]),
    dvol: ok(0.34),
    candles: ok([76_000, 77_000, 78_000]),
    okxIndex: ok(78_291.3),
    deribitIndex: ok(78_289.54),
  };
}

describe("buildOptionsSnapshot — allSettled 결과를 스냅샷으로 조립한다", () => {
  it("전부 성공하면 두 거래소 행이 합쳐지고 sources 는 전부 ok 다", () => {
    const snapshot = buildOptionsSnapshot(allOk(), NOW_ISO);

    expect(snapshot.collectedAt).toBe(NOW_ISO);
    expect(snapshot.rows).toHaveLength(4);
    expect(snapshot.rows.map((r) => r.venue)).toEqual(["okx", "okx", "deribit", "deribit"]);
    expect(snapshot.indexPrice).toBe(78_291.3);
    expect(snapshot.okxFlow?.callBuy).toBe(9);
    expect(snapshot.okxHistory).toHaveLength(1);
    expect(snapshot.dvol).toBe(0.34);
    expect(snapshot.dailyCloses).toEqual([76_000, 77_000, 78_000]);
    expect(snapshot.sources).toEqual({ okx: "ok", deribit: "ok", dvol: "ok", candles: "ok" });
  });

  it("Deribit 만 죽으면 rows 는 OKX 것만이고 sources.deribit 에 사유가 남는다", () => {
    const snapshot = buildOptionsSnapshot(
      { ...allOk(), deribit: fail("Deribit 응답 오류 502") },
      NOW_ISO,
    );

    expect(snapshot.rows).toHaveLength(2);
    expect(snapshot.rows.every((r) => r.venue === "okx")).toBe(true);
    expect(snapshot.sources.deribit).toBe("error: Deribit 응답 오류 502");
    // 나머지는 그대로다.
    expect(snapshot.sources.okx).toBe("ok");
    expect(snapshot.dvol).toBe(0.34);
  });

  it("응답은 왔는데 종목이 0행이면 그 거래소는 실패로 적는다 — OI 0 으로 읽히면 안 된다", () => {
    const snapshot = buildOptionsSnapshot(
      { ...allOk(), deribit: ok([]), okx: ok({ ...okxBundle(), rows: [] }) },
      NOW_ISO,
    );

    expect(snapshot.rows).toEqual([]);
    expect(snapshot.sources.deribit).toBe("error: Deribit 응답에 종목이 없습니다");
    expect(snapshot.sources.okx).toBe("error: OKX 응답에 종목이 없습니다");
    // 흐름·이력은 왔으면 그대로 싣는다 — 실패로 적은 것은 종목 목록이다.
    expect(snapshot.okxHistory).toHaveLength(1);
  });

  it("OKX 만 죽으면 흐름·이력이 비고 rows 는 Deribit 것만이다", () => {
    const snapshot = buildOptionsSnapshot({ ...allOk(), okx: fail("OKX 응답 오류 429") }, NOW_ISO);

    expect(snapshot.rows.every((r) => r.venue === "deribit")).toBe(true);
    expect(snapshot.okxFlow).toBeNull();
    expect(snapshot.okxHistory).toEqual([]);
    expect(snapshot.sources.okx).toBe("error: OKX 응답 오류 429");
  });

  it("DVOL·캔들이 죽으면 null·빈 배열이고 옵션 행은 그대로다", () => {
    const snapshot = buildOptionsSnapshot(
      { ...allOk(), dvol: fail("타임아웃"), candles: fail("OKX 오류: 50011") },
      NOW_ISO,
    );

    expect(snapshot.dvol).toBeNull();
    expect(snapshot.dailyCloses).toEqual([]);
    expect(snapshot.sources.dvol).toBe("error: 타임아웃");
    expect(snapshot.sources.candles).toBe("error: OKX 오류: 50011");
    expect(snapshot.rows).toHaveLength(4);
  });

  it("지수가는 OKX 가 죽으면 Deribit 값, 둘 다 없으면 null — sources 키가 아니다", () => {
    const fallback = buildOptionsSnapshot({ ...allOk(), okxIndex: fail("타임아웃") }, NOW_ISO);
    expect(fallback.indexPrice).toBe(78_289.54);
    expect(Object.keys(fallback.sources)).toEqual(["okx", "deribit", "dvol", "candles"]);

    // OKX 가 응답은 했는데 값이 비어 있어도(null) Deribit 으로 넘어간다.
    const empty = buildOptionsSnapshot({ ...allOk(), okxIndex: ok(null) }, NOW_ISO);
    expect(empty.indexPrice).toBe(78_289.54);

    const none = buildOptionsSnapshot(
      { ...allOk(), okxIndex: fail("a"), deribitIndex: fail("b") },
      NOW_ISO,
    );
    expect(none.indexPrice).toBeNull();
  });

  it("옵션 거래소 둘 다 죽어도 순수 함수는 빈 스냅샷을 돌린다 — throw 는 수집기의 몫", () => {
    const snapshot = buildOptionsSnapshot(
      { ...allOk(), okx: fail("a"), deribit: fail("b") },
      NOW_ISO,
    );
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.sources.okx).toBe("error: a");
    expect(snapshot.sources.deribit).toBe("error: b");
  });
});

describe("collectOptionsSnapshot — 여섯 호출을 병렬로 모으고 둘 다 죽었을 때만 throw 한다", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  function stubAll() {
    vi.mocked(fetchOkxOptions).mockResolvedValue(okxBundle());
    vi.mocked(fetchDeribitOptions).mockResolvedValue([row("deribit", 80_000, "C")]);
    vi.mocked(fetchDvol).mockResolvedValue(0.34);
    vi.mocked(fetchOkxDailyCloses).mockResolvedValue([76_000, 77_000]);
    vi.mocked(fetchOkxIndexPrice).mockResolvedValue(78_291.3);
    vi.mocked(fetchDeribitIndexPrice).mockResolvedValue(78_289.54);
  }

  it("전부 성공: 종목 fetch 둘에 같은 nowMs 를 넘기고 collectedAt 이 그 시각이다", async () => {
    stubAll();
    const snapshot = await collectOptionsSnapshot();

    expect(snapshot.rows).toHaveLength(3);
    expect(snapshot.sources).toEqual({ okx: "ok", deribit: "ok", dvol: "ok", candles: "ok" });
    const okxNow = vi.mocked(fetchOkxOptions).mock.calls[0][0];
    const deribitNow = vi.mocked(fetchDeribitOptions).mock.calls[0][0];
    expect(okxNow).toBe(deribitNow);
    expect(Date.parse(snapshot.collectedAt)).toBe(okxNow);
  });

  it("Deribit 만 죽으면 throw 하지 않고 OKX 만으로 돌린다", async () => {
    stubAll();
    vi.mocked(fetchDeribitOptions).mockRejectedValue(new Error("Deribit 응답 오류 502"));

    const snapshot = await collectOptionsSnapshot();
    expect(snapshot.rows.every((r) => r.venue === "okx")).toBe(true);
    expect(snapshot.sources.deribit).toBe("error: Deribit 응답 오류 502");
  });

  it("OKX·Deribit 둘 다 죽으면 두 사유를 담아 throw 한다", async () => {
    stubAll();
    vi.mocked(fetchOkxOptions).mockRejectedValue(new Error("OKX 응답 오류 429"));
    vi.mocked(fetchDeribitOptions).mockRejectedValue(new Error("Deribit 응답 오류 502"));

    await expect(collectOptionsSnapshot()).rejects.toThrow(
      "옵션 소스 두 곳 모두 수집에 실패했습니다: OKX error: OKX 응답 오류 429 · Deribit error: Deribit 응답 오류 502",
    );
  });
});
