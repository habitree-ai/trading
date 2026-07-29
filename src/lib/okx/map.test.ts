import { describe, expect, it } from "vitest";

import { fillSchema, positionSchema, type OkxFill, type OkxPosition } from "@/lib/okx/schema";
import {
  baseSymbol,
  fillRole,
  matchPosition,
  notionalOf,
  resultOf,
  sideOf,
  toFillInsert,
  toTradeInsert,
} from "@/lib/okx/map";

/** OKX 문서 예시를 본뜬 응답 — 모든 수치가 문자열로 온다. */
function position(over: Record<string, string> = {}): OkxPosition {
  return positionSchema.parse({
    posId: "1752922805906812928",
    instId: "BTC-USDT-SWAP",
    mgnMode: "cross",
    direction: "long",
    lever: "10",
    openAvgPx: "29783.9",
    closeAvgPx: "29786.6",
    pnl: "0.0027",
    realizedPnl: "0.0026",
    fee: "-0.0001",
    fundingFee: "0",
    closeTotalPos: "100",
    cTime: "1695359700000",
    uTime: "1695360000000",
    ...over,
  });
}

function fill(over: Record<string, string> = {}): OkxFill {
  return fillSchema.parse({
    billId: "1111111111111111111",
    ordId: "2222222222",
    instId: "BTC-USDT-SWAP",
    fillPx: "29783.9",
    fillSz: "60",
    side: "buy",
    fee: "-0.0001",
    ts: "1695359700000",
    ...over,
  });
}

describe("baseSymbol", () => {
  it("계약 이름에서 기초자산만 남긴다", () => {
    expect(baseSymbol("BTC-USDT-SWAP")).toBe("BTC");
    expect(baseSymbol("eth-usdt-swap")).toBe("ETH");
  });
});

describe("sideOf", () => {
  it("direction을 그대로 쓴다", () => {
    expect(sideOf(position())).toBe("long");
    expect(sideOf(position({ direction: "short" }))).toBe("short");
  });

  it("넷 모드는 가격 방향과 손익 부호로 되짚는다", () => {
    // 가격이 올랐고 벌었다 → 롱
    expect(sideOf(position({ direction: "net" }))).toBe("long");
    // 가격이 올랐는데 잃었다 → 숏
    expect(sideOf(position({ direction: "net", pnl: "-0.0027" }))).toBe("short");
  });

  it("되짚을 근거가 없으면 null", () => {
    expect(sideOf(position({ direction: "net", pnl: "0" }))).toBeNull();
    expect(sideOf(position({ direction: "net", closeAvgPx: "29783.9" }))).toBeNull();
  });
});

describe("resultOf", () => {
  it("손익 부호로 승패를 정한다", () => {
    expect(resultOf(1)).toBe("win");
    expect(resultOf(-1)).toBe("loss");
    expect(resultOf(0)).toBe("be");
    expect(resultOf(null)).toBe("open");
  });
});

describe("notionalOf", () => {
  it("계약 수 × 계약 크기 × 진입가", () => {
    // 100 계약 × 0.01 BTC × 29783.9 = 29783.9 USDT
    expect(notionalOf(position(), 0.01)).toBeCloseTo(29783.9, 6);
  });

  it("계약 크기를 모르면 비워 둔다 — 틀린 금액보다 빈 칸이 낫다", () => {
    expect(notionalOf(position(), null)).toBeNull();
  });
});

describe("toTradeInsert", () => {
  const base = { ctVal: 0.01, bookId: "book-1", userId: "user-1", seq: 7 };

  it("포지션 1건을 거래 1건으로 옮긴다", () => {
    const row = toTradeInsert({ pos: position(), ...base });

    expect(row).toMatchObject({
      book_id: "book-1",
      user_id: "user-1",
      seq: 7,
      okx_pos_id: "1752922805906812928",
      side: "long",
      symbol: "BTC",
      result: "win",
      entry_price: 29783.9,
      exit_price: 29786.6,
      leverage: 10,
      pnl: 0.0027,
      fee: -0.0001,
      funding_fee: 0,
      margin_mode: "cross",
    });
    expect(row?.entry_at).toBe("2023-09-22T05:15:00.000Z");
    expect(row?.exit_at).toBe("2023-09-22T05:20:00.000Z");
  });

  it("수수료와 펀딩비를 나눠 담는다", () => {
    const row = toTradeInsert({ pos: position({ fundingFee: "-0.5" }), ...base });
    expect(row?.fee).toBe(-0.0001);
    expect(row?.funding_fee).toBe(-0.5);
  });

  it("모르는 마진 모드는 비워 둔다", () => {
    expect(toTradeInsert({ pos: position({ mgnMode: "cash" }), ...base })?.margin_mode).toBeNull();
  });

  it("방향을 못 정하면 넣지 않는다", () => {
    expect(toTradeInsert({ pos: position({ direction: "net", pnl: "0" }), ...base })).toBeNull();
  });
});

describe("fillRole", () => {
  it("숏은 매도가 진입이다", () => {
    expect(fillRole("buy", "long")).toBe("open");
    expect(fillRole("sell", "long")).toBe("close");
    expect(fillRole("sell", "short")).toBe("open");
    expect(fillRole("buy", "short")).toBe("close");
  });
});

describe("matchPosition", () => {
  // 경계 여유(±1초)보다 넉넉히 벌어진 구간이라야 "사이에 낀" 체결을 시험할 수 있다.
  const first = position({ posId: "A", cTime: "100000", uTime: "200000" });
  const second = position({ posId: "B", cTime: "300000", uTime: "400000" });
  const other = position({ posId: "C", instId: "ETH-USDT-SWAP", cTime: "100000", uTime: "400000" });
  const all = [first, second, other];

  it("종목과 구간이 모두 맞는 포지션을 고른다", () => {
    expect(matchPosition(fill({ ts: "150000" }), all)?.posId).toBe("A");
    expect(matchPosition(fill({ ts: "350000" }), all)?.posId).toBe("B");
    expect(matchPosition(fill({ ts: "150000", instId: "ETH-USDT-SWAP" }), all)?.posId).toBe("C");
  });

  it("구간 사이에 낀 체결은 짝이 없다", () => {
    expect(matchPosition(fill({ ts: "250000" }), all)).toBeNull();
  });

  it("경계 시각도 그 포지션에 넣는다", () => {
    expect(matchPosition(fill({ ts: "100000" }), all)?.posId).toBe("A");
    expect(matchPosition(fill({ ts: "400000" }), all)?.posId).toBe("B");
  });
});

describe("toFillInsert", () => {
  const base = { ctVal: 0.01, tradeId: "trade-1", userId: "user-1", side: "long" as const };

  it("체결 1건을 좌표로 옮긴다", () => {
    const row = toFillInsert({ fill: fill(), ...base });

    expect(row).toMatchObject({
      trade_id: "trade-1",
      role: "open",
      price: 29783.9,
      fee: -0.0001,
      order_no: "2222222222",
      okx_bill_id: "1111111111111111111",
    });
    // 60 계약 × 0.01 BTC × 29783.9
    expect(row?.amount).toBeCloseTo(17870.34, 6);
    expect(row?.filled_at).toBe("2023-09-22T05:15:00.000Z");
  });

  it("가격이 없으면 차트에 찍을 수 없어 버린다", () => {
    expect(toFillInsert({ fill: fill({ fillPx: "" }), ...base })).toBeNull();
  });
});
