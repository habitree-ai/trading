import { describe, expect, it } from "vitest";

import { parseBookDepth, parseOiHistory } from "@/lib/threshold/fetch";

const H = 3_600_000;
const T0 = 1_794_049_200_000;

describe("parseOiHistory — [ts, oi, oiCcy, oiUsd] 최신부터", () => {
  it("최신 칸과 정확히 24시간 앞 칸의 oiCcy 로 변화율", () => {
    const data = Array.from({ length: 30 }, (_, i) => [
      String(T0 - i * H),
      "0",
      i === 0 ? "106" : i === 24 ? "100" : "103",
      "0",
    ]);
    const r = parseOiHistory({ code: "0", msg: "", data });
    expect(r).toEqual({ ts: T0, oiNow: 106, oi24hAgo: 100, chgPct: expect.closeTo(6, 9) });
  });

  it("24시간 앞 칸이 없으면 null", () => {
    const data = Array.from({ length: 10 }, (_, i) => [String(T0 - i * H), "0", "100", "0"]);
    expect(parseOiHistory({ code: "0", msg: "", data })).toBeNull();
    expect(parseOiHistory({ code: "0", msg: "", data: [] })).toBeNull();
    expect(parseOiHistory(null)).toBeNull();
  });
});

/** 중간값 100 근처 호가 — 가격 간격 0.1 씩 n 단계, 크기 sz. */
function book(n: number, askSz: number, bidSz: number) {
  const asks = Array.from({ length: n }, (_, i) => [(100.05 + i * 0.1).toFixed(2), String(askSz), "1"]);
  const bids = Array.from({ length: n }, (_, i) => [(99.95 - i * 0.1).toFixed(2), String(bidSz), "1"]);
  return { code: "0", msg: "", data: [{ asks, bids, ts: "0" }] };
}

describe("parseBookDepth", () => {
  it("±0.5% 를 덮으면 위 매도 명목 ÷ 아래 매수 명목", () => {
    // 중간 100, 경계 99.5~100.5 — 매도 100.05…100.45 다섯 단계, 매수 99.95…99.55 다섯 단계.
    const r = parseBookDepth(book(10, 1, 2), 0.005);
    const ask = [100.05, 100.15, 100.25, 100.35, 100.45].reduce((s, p) => s + p, 0);
    const bid = [99.95, 99.85, 99.75, 99.65, 99.55].reduce((s, p) => s + p * 2, 0);
    expect(r).toBeCloseTo(ask / bid, 12);
  });

  it("호가가 범위를 다 덮지 못하면 null(0 이 아니다)", () => {
    // 세 단계 — 100.25 / 99.75 까지만, 경계 100.5 / 99.5 에 못 닿는다.
    expect(parseBookDepth(book(3, 1, 1), 0.005)).toBeNull();
  });

  it("매수 쪽만 못 덮어도 null", () => {
    const b = book(10, 1, 1);
    b.data[0].bids = b.data[0].bids.slice(0, 3);
    expect(parseBookDepth(b, 0.005)).toBeNull();
  });

  it("모양이 깨지면 null", () => {
    expect(parseBookDepth({ code: "0", data: [] })).toBeNull();
    expect(parseBookDepth({ code: "0", data: [{ asks: [], bids: [] }] })).toBeNull();
    expect(parseBookDepth("x")).toBeNull();
  });
});
