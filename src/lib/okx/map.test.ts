import { describe, expect, it } from "vitest";

import {
  accountBillSchema,
  algoOrderSchema,
  depositSchema,
  fillSchema,
  openPositionSchema,
  orderSchema,
  positionSchema,
  withdrawalSchema,
  type OkxAccountBill,
  type OkxAlgoOrder,
  type OkxDeposit,
  type OkxFill,
  type OkxOpenPosition,
  type OkxOrder,
  type OkxPosition,
  type OkxWithdrawal,
} from "@/lib/okx/schema";
import {
  baseSymbol,
  fillRole,
  isFullyClosed,
  matchOpenPosition,
  openRealizedOf,
  openSideOf,
  positionKey,
  matchPosition,
  notionalOf,
  realizedOf,
  resultOf,
  sideOf,
  toCloseUpdate,
  toDepositInsert,
  toFillInsert,
  toOpenTradeInsert,
  toOpenUpdate,
  toTradeInsert,
  toTransferInsert,
  toWithdrawalInsert,
  spanOfClosed,
  spanOfOpen,
  stopTargetOf,
} from "@/lib/okx/map";

/** OKX 문서 예시를 본뜬 응답 — 모든 수치가 문자열로 온다. */
function position(over: Record<string, string> = {}): OkxPosition {
  return positionSchema.parse({
    posId: "1752922805906812928",
    instId: "BTC-USDT-SWAP",
    mgnMode: "cross",
    direction: "long",
    posSide: "long",
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

/** `GET /api/v5/account/positions` 응답을 본뜬 미청산 포지션. */
function openPosition(over: Record<string, string> = {}): OkxOpenPosition {
  return openPositionSchema.parse({
    posId: "1752922805906812928",
    instId: "BTC-USDT-SWAP",
    mgnMode: "cross",
    posSide: "long",
    pos: "100",
    avgPx: "29783.9",
    lever: "10",
    upl: "1.5",
    realizedPnl: "-0.2",
    cTime: "1695359700000",
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

describe("positionKey", () => {
  it("posId 가 같아도 청산 시각이 다르면 다른 거래다", () => {
    // 실계좌 100건에 고유 posId 가 6개뿐이었다 — posId 하나가 60건에 재사용됐다.
    expect(positionKey("3711868481042571264", 1000)).not.toBe(
      positionKey("3711868481042571264", 2000),
    );
  });

  it("같은 포지션·같은 청산 시각이면 같은 거래", () => {
    expect(positionKey("A", 1000)).toBe(positionKey("A", 1000));
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

describe("matchOpenPosition", () => {
  const held = () => openPosition({ posId: "OPEN", cTime: "300000", posSide: "long" });

  it("개시 시각 뒤의 체결을 들고 있는 포지션에 붙인다", () => {
    // 부분청산은 포지션을 닫지 않는다 — 이 체결이 버려지면 근거가 사라진다.
    expect(matchOpenPosition(fill({ ts: "350000" }), [held()])?.posId).toBe("OPEN");
  });

  it("개시 전 체결은 붙이지 않는다 — posId 는 재사용된다", () => {
    expect(matchOpenPosition(fill({ ts: "100000" }), [held()])).toBeNull();
  });

  it("종목이 다르면 붙이지 않는다", () => {
    expect(matchOpenPosition(fill({ ts: "350000", instId: "ETH-USDT-SWAP" }), [held()])).toBeNull();
  });

  it("롱·숏이 함께 열려 있으면 posSide 로 가른다", () => {
    const short = openPosition({ posId: "SHORT", cTime: "300000", posSide: "short" });
    const both = [held(), short];
    expect(matchOpenPosition(fill({ ts: "350000", posSide: "long" }), both)?.posId).toBe("OPEN");
    expect(matchOpenPosition(fill({ ts: "350000", posSide: "short" }), both)?.posId).toBe("SHORT");
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

/* ============ 입출금 ============ */

/** 실계좌 응답을 그대로 본뜬 것 — 쓰는 필드만 남겼다. */
function accountBill(over: Record<string, string> = {}): OkxAccountBill {
  return accountBillSchema.parse({
    billId: "3803011288393764864",
    ccy: "USDT",
    balChg: "0.5714666100000000",
    notes: "From: Funding",
    ts: "1785840968460",
    ...over,
  });
}

function deposit(over: Record<string, string> = {}): OkxDeposit {
  return depositSchema.parse({
    depId: "419554397",
    ccy: "USDT",
    amt: "139.178845",
    chain: "USDT-TRC20",
    state: "2",
    ts: "1785330713000",
    ...over,
  });
}

function withdrawal(over: Record<string, string> = {}): OkxWithdrawal {
  return withdrawalSchema.parse({
    wdId: "420079822",
    ccy: "USDT",
    amt: "35",
    fee: "0.0012",
    chain: "USDT-Aptos",
    state: "2",
    ts: "1785773477000",
    ...over,
  });
}

const owner = { bookId: "book-1", userId: "user-1" };

describe("toTransferInsert", () => {
  it("거래계좌 기준 부호를 그대로 쓴다", () => {
    expect(toTransferInsert({ bill: accountBill(), ...owner })).toMatchObject({
      kind: "transfer",
      amount: 0.57146661,
      note: "From: Funding",
      okx_ref: "3803011288393764864",
    });
  });

  it("빠져나간 이체는 음수 그대로 둔다", () => {
    const row = toTransferInsert({
      bill: accountBill({ balChg: "-33.9455830000000000", notes: "To: Funding" }),
      ...owner,
    });
    expect(row?.amount).toBeCloseTo(-33.945583, 8);
  });

  it("잔고가 움직이지 않은 줄은 버린다", () => {
    expect(toTransferInsert({ bill: accountBill({ balChg: "0" }), ...owner })).toBeNull();
    expect(toTransferInsert({ bill: accountBill({ balChg: "" }), ...owner })).toBeNull();
  });
});

describe("toDepositInsert / toWithdrawalInsert", () => {
  it("입금은 +, 출금은 −로 맞춘다", () => {
    expect(toDepositInsert({ deposit: deposit(), ...owner })).toMatchObject({
      kind: "deposit",
      amount: 139.178845,
      note: "USDT-TRC20",
      okx_ref: "419554397",
    });

    expect(toWithdrawalInsert({ withdrawal: withdrawal(), ...owner })).toMatchObject({
      kind: "withdrawal",
      amount: -35,
      fee: -0.0012,
      okx_ref: "420079822",
    });
  });

  it("완료되지 않은 건은 잔고가 아니라 버린다", () => {
    expect(toDepositInsert({ deposit: deposit({ state: "0" }), ...owner })).toBeNull();
    expect(toWithdrawalInsert({ withdrawal: withdrawal({ state: "-2" }), ...owner })).toBeNull();
  });
});

describe("realizedOf — 계좌가 실제로 움직인 금액", () => {
  it("거래소가 준 realizedPnl을 그대로 쓴다", () => {
    expect(realizedOf(position())).toBeCloseTo(0.0026, 10);
  });

  it("되짚기로는 못 잡는 비용까지 담는다", () => {
    // 실계좌 대조: pnl+fee+funding = -125.163 인데 거래소 값은 -130.385 였다.
    const pos = position({ pnl: "65.385", fee: "-190.205", fundingFee: "-0.343", realizedPnl: "-130.385" });
    expect(realizedOf(pos)).toBeCloseTo(-130.385, 10);
    expect(toTradeInsert({ pos, ctVal: 0.01, ...owner, seq: 1 })?.realized_pnl).toBeCloseTo(-130.385, 10);
  });

  it("realizedPnl이 비면 손익·수수료·펀딩비로 되짚는다", () => {
    const pos = position({ realizedPnl: "", pnl: "2", fee: "-5" });
    expect(realizedOf(pos)).toBeCloseTo(-3, 10);
  });

  it("수수료가 손익을 넘기면 승이 패가 된다", () => {
    const pos = position({ pnl: "2", fee: "-5", realizedPnl: "-3" });
    expect(resultOf(realizedOf(pos))).toBe("loss");
    expect(toTradeInsert({ pos, ctVal: 0.01, ...owner, seq: 1 })?.result).toBe("loss");
  });
});

describe("미청산 포지션", () => {
  it("방향은 posSide를 그대로 쓴다", () => {
    expect(openSideOf(openPosition({ posSide: "short" }))).toBe("short");
  });

  it("넷 모드는 계약 수의 부호가 방향이다", () => {
    expect(openSideOf(openPosition({ posSide: "net", pos: "-100" }))).toBe("short");
    expect(openSideOf(openPosition({ posSide: "net", pos: "100" }))).toBe("long");
  });

  it("계약 수가 0이면 방향을 정할 수 없다", () => {
    expect(openSideOf(openPosition({ posSide: "net", pos: "0" }))).toBeNull();
  });

  it("확정분은 미실현과 갈라 읽는다 — 시세로 흔들리는 건 upl 뿐이다", () => {
    expect(openRealizedOf(openPosition())).toBeCloseTo(-0.2, 10);
    // realizedPnl 이 비면 세 항으로 되짚는다.
    const derivedOnly = openPosition({ realizedPnl: "", pnl: "3", fee: "-0.5", fundingFee: "-0.1" });
    expect(openRealizedOf(derivedOnly)).toBeCloseTo(2.4, 10);
  });

  it("평가손익 칸에는 미실현만, 확정된 몫은 실현손익 칸에 담는다", () => {
    const row = toOpenTradeInsert({ pos: openPosition(), ctVal: 0.01, ...owner, seq: 7 });

    expect(row?.result).toBe("open");
    expect(row?.entry_price).toBe(29783.9);
    expect(row?.notional).toBeCloseTo(29783.9, 10); // 29783.9 × 100 × 0.01
    // 섞어 담으면 확정된 돈이 장부 어디에도 없는 돈이 된다.
    expect(row?.unrealized_pnl).toBeCloseTo(1.5, 10);
    expect(row?.realized_pnl).toBeCloseTo(-0.2, 10);
    expect(row).not.toHaveProperty("exit_at");
  });

  it("방향을 못 정하면 줄을 만들지 않는다", () => {
    const pos = openPosition({ posSide: "net", pos: "0" });
    expect(toOpenTradeInsert({ pos, ctVal: 0.01, ...owner, seq: 1 })).toBeNull();
  });

  it("갱신에는 북·사용자·순번이 없다 — 있던 줄의 자리를 흔들지 않는다", () => {
    const row = toOpenTradeInsert({ pos: openPosition(), ctVal: 0.01, ...owner, seq: 7 })!;
    const update = toOpenUpdate(row);

    expect(update).not.toHaveProperty("book_id");
    expect(update).not.toHaveProperty("user_id");
    expect(update).not.toHaveProperty("seq");
    expect(update).not.toHaveProperty("okx_pos_id");
    expect(update.unrealized_pnl).toBeCloseTo(1.5, 10);
    // 확정분도 매 사이클 갱신돼야 한다 — 부분청산이 또 나면 이 값이 늘어난다.
    expect(update.realized_pnl).toBeCloseTo(-0.2, 10);
  });

  /*
   * 청산은 새 줄이 아니라 있던 줄을 덮어쓴다.
   *
   * 들고 있는 동안 적어 둔 근거·복기·원칙 판단·차트 메모가 모두 그 줄의 id에 매달려
   * 있어서다. 그래서 덮어쓰는 칸에 그 기록들이 끼어 있으면 안 된다.
   */
  it("청산 갱신은 손으로 적은 칸을 건드리지 않는다", () => {
    const row = toTradeInsert({ pos: position(), ctVal: 0.01, ...owner, seq: 3 })!;
    const update = toCloseUpdate(row);

    for (const field of [
      "rationale",
      "review",
      "emotion",
      "note",
      "setup",
      "stop_price",
      "tp1_price",
      "tp1_pct",
      "tp2_pct",
      "tp3_pct",
    ]) {
      expect(update).not.toHaveProperty(field);
    }
    expect(update).not.toHaveProperty("book_id");
    expect(update).not.toHaveProperty("seq");
  });

  it("청산되면 평가손익을 지운다 — 안 지우면 같은 금액이 두 칸에 남는다", () => {
    const row = toTradeInsert({ pos: position(), ctVal: 0.01, ...owner, seq: 3 })!;
    expect(toCloseUpdate(row).unrealized_pnl).toBeNull();
    expect(toCloseUpdate(row).exit_at).toBe(row.exit_at);
    expect(toCloseUpdate(row).realized_pnl).toBe(row.realized_pnl);
  });
});

/**
 * 부분청산 — 포지션이 남아 있는데도 이력에 행이 생긴다.
 *
 * 실계좌에서 자금을 155 부풀린 원인이다. 같은 posId·같은 진입시각으로 부분청산 행이
 * 거래로 저장되고, 그 몫이 최종청산 행의 `realizedPnl` 안에서 한 번 더 잡혔다.
 */
describe("isFullyClosed — 부분청산은 거래로 세지 않는다", () => {
  it("부분청산(1)과 부분 강제청산(4)은 거래가 아니다", () => {
    expect(isFullyClosed(position({ type: "1" }))).toBe(false);
    expect(isFullyClosed(position({ type: "4" }))).toBe(false);
  });

  it("전량청산·강제청산·ADL은 거래로 센다", () => {
    for (const type of ["2", "3", "5"]) {
      expect(isFullyClosed(position({ type }))).toBe(true);
    }
  });

  it("type이 없으면 통과시킨다 — 못 읽었다고 거래를 잃으면 안 된다", () => {
    expect(isFullyClosed(position())).toBe(true);
  });

  /*
   * 실계좌 재현 — posId 3279154956531326976.
   * 08-19 07:19 진입 → 08-20 08:17 부분청산(+139.85), 포지션은 그대로 열려 있다.
   * 이 행을 거래로 세면 미청산 행이 이미 들고 있는 확정분(realizedPnl 139.85)과
   * 겹쳐 139.85가 두 번 잡힌다.
   */
  it("실계좌 부분청산 행은 걸러진다", () => {
    const partial = position({
      posId: "3279154956531326976",
      type: "1",
      pnl: "142.4025167256637168",
      realizedPnl: "139.8535039141899893",
      cTime: "1787123944438",
      uTime: "1787213863265",
    });

    expect(isFullyClosed(partial)).toBe(false);
    expect([partial].filter(isFullyClosed)).toHaveLength(0);
  });
});


/** `GET /api/v5/trade/orders-algo-history` 응답을 본뜬 손절 예약. */
function algo(over: Record<string, string> = {}): OkxAlgoOrder {
  return algoOrderSchema.parse({
    algoId: "3859466405197860864",
    instId: "BTC-USDT-SWAP",
    posSide: "long",
    slTriggerPx: "29000",
    tpTriggerPx: "",
    cTime: "1695359710000",
    ...over,
  });
}

/** `GET /api/v5/trade/orders-history-archive` 응답을 본뜬 진입 주문. */
function order(over: Record<string, unknown> = {}): OkxOrder {
  return orderSchema.parse({
    ordId: "ORD-1",
    instId: "BTC-USDT-SWAP",
    slTriggerPx: "",
    tpTriggerPx: "",
    attachAlgoOrds: [],
    cTime: "1695359700000",
    ...over,
  });
}

const NO_ORDERS = new Map<string, OkxOrder>();

describe("stopTargetOf — 거래소에 걸려 있던 손절·익절", () => {
  it("진입 주문에 부착돼 있으면 그걸 쓴다 — ordId가 일치하니 추정이 아니다", () => {
    const pos = position();
    const span = spanOfClosed(pos);
    const orders = new Map([
      ["ORD-1", order({ attachAlgoOrds: [{ slTriggerPx: "28500", tpTriggerPx: "31000" }] })],
    ]);

    expect(
      stopTargetOf({ span, entryOrdIds: ["ORD-1"], orders, algos: [], siblings: [span] }),
    ).toEqual({ okx_stop_price: 28500, okx_tp_price: 31000, okx_sl_source: "attached" });
  });

  it("부착이 없으면 알고 주문을 시각으로 되짚는다", () => {
    const pos = position({ posSide: "long" });
    const span = spanOfClosed(pos);

    expect(
      stopTargetOf({
        span,
        entryOrdIds: [],
        orders: NO_ORDERS,
        algos: [algo({ slTriggerPx: "29100" })],
        siblings: [span],
      }),
    ).toEqual({ okx_stop_price: 29100, okx_tp_price: null, okx_sl_source: "algo" });
  });

  /*
   * 손절을 옮기면 예약이 여러 건 남는다. 무엇을 남길지는 기획에서 정한 값이다 —
   * **마지막에 등록된 것**이다. 진입 시점 값이 아니다(REQ-0004 결정 2).
   */
  it("손절을 여러 번 옮겼으면 마지막에 등록한 값을 쓴다", () => {
    const pos = position();
    const span = spanOfClosed(pos);
    const algos = [
      algo({ algoId: "A1", slTriggerPx: "29000", cTime: "1695359710000" }),
      algo({ algoId: "A3", slTriggerPx: "29500", cTime: "1695359900000" }),
      algo({ algoId: "A2", slTriggerPx: "29200", cTime: "1695359800000" }),
    ];

    expect(
      stopTargetOf({ span, entryOrdIds: [], orders: NO_ORDERS, algos, siblings: [span] })
        .okx_stop_price,
    ).toBe(29500);
  });

  it("손절과 익절을 따로 걸었으면 각각의 마지막 값을 살린다", () => {
    const pos = position();
    const span = spanOfClosed(pos);
    const algos = [
      algo({ algoId: "SL", slTriggerPx: "29000", tpTriggerPx: "", cTime: "1695359710000" }),
      algo({ algoId: "TP", slTriggerPx: "", tpTriggerPx: "31000", cTime: "1695359800000" }),
    ];

    expect(
      stopTargetOf({ span, entryOrdIds: [], orders: NO_ORDERS, algos, siblings: [span] }),
    ).toEqual({ okx_stop_price: 29000, okx_tp_price: 31000, okx_sl_source: "algo" });
  });

  /*
   * 알고 주문에는 posId가 없다. 같은 종목·같은 방향 포지션이 겹쳐 있으면 그 예약이
   * 어느 쪽 것인지 가릴 방법이 없다 — 절반의 확률로 남의 손절가를 적어 넣게 된다.
   */
  it("같은 종목·방향 포지션이 겹치면 추정을 포기하고 비운다", () => {
    const mine = spanOfClosed(position({ cTime: "1695359700000", uTime: "1695360000000" }));
    const other = spanOfClosed(
      position({ posId: "OTHER", cTime: "1695359800000", uTime: "1695360100000" }),
    );

    expect(
      stopTargetOf({
        span: mine,
        entryOrdIds: [],
        orders: NO_ORDERS,
        algos: [algo()],
        siblings: [mine, other],
      }),
    ).toEqual({ okx_stop_price: null, okx_tp_price: null, okx_sl_source: null });
  });

  it("겹쳐도 부착 주문은 살아남는다 — 그쪽은 ordId로 특정되니 헷갈릴 일이 없다", () => {
    const mine = spanOfClosed(position({ cTime: "1695359700000", uTime: "1695360000000" }));
    const other = spanOfClosed(
      position({ posId: "OTHER", cTime: "1695359800000", uTime: "1695360100000" }),
    );
    const orders = new Map([
      ["ORD-1", order({ attachAlgoOrds: [{ slTriggerPx: "28500", tpTriggerPx: "" }] })],
    ]);

    expect(
      stopTargetOf({
        span: mine,
        entryOrdIds: ["ORD-1"],
        orders,
        algos: [],
        siblings: [mine, other],
      }).okx_stop_price,
    ).toBe(28500);
  });

  it("방향이 다른 포지션이 겹치는 것은 헷갈릴 일이 아니다", () => {
    const mine = spanOfClosed(position({ posSide: "long" }));
    const other = spanOfClosed(position({ posId: "OTHER", posSide: "short" }));

    expect(
      stopTargetOf({
        span: mine,
        entryOrdIds: [],
        orders: NO_ORDERS,
        algos: [algo({ posSide: "long", slTriggerPx: "29100" })],
        siblings: [mine, other],
      }).okx_stop_price,
    ).toBe(29100);
  });

  it("구간 밖에 걸린 예약은 남의 것이다", () => {
    const span = spanOfClosed(position({ cTime: "1695359700000", uTime: "1695360000000" }));

    expect(
      stopTargetOf({
        span,
        entryOrdIds: [],
        orders: NO_ORDERS,
        // 청산보다 2분 늦게 걸린 예약 — 여유(60초)를 넘어선다
        algos: [algo({ cTime: "1695360120000" })],
        siblings: [span],
      }).okx_sl_source,
    ).toBeNull();
  });

  it("아무 데서도 못 찾으면 셋 다 비운다 — 0이나 추정치를 넣지 않는다", () => {
    const span = spanOfClosed(position());

    expect(
      stopTargetOf({ span, entryOrdIds: [], orders: NO_ORDERS, algos: [], siblings: [span] }),
    ).toEqual({ okx_stop_price: null, okx_tp_price: null, okx_sl_source: null });
  });

  /*
   * 익절을 걸지 않은 포지션에 거래소는 `tpTriggerPx: "0"`을 실어 준다(실계좌 확인).
   * 이걸 값으로 읽으면 "0원에 익절 예약"이라는 거짓이 화면에 뜬다.
   */
  it("들고 있는 포지션은 지금 걸려 있는 예약을 읽고, 0은 없는 값으로 접는다", () => {
    const held = openPosition();
    const span = spanOfOpen(held);

    expect(
      stopTargetOf({
        span,
        entryOrdIds: [],
        orders: NO_ORDERS,
        algos: [],
        siblings: [span],
        closeOrderAlgo: openPositionSchema.parse({
          posId: "1752922805906812928",
          instId: "BTC-USDT-SWAP",
          mgnMode: "cross",
          posSide: "long",
          pos: "100",
          avgPx: "29783.9",
          lever: "10",
          upl: "1.5",
          realizedPnl: "-0.2",
          cTime: "1695359700000",
          closeOrderAlgo: [{ slTriggerPx: "28480", tpTriggerPx: "0" }],
        }).closeOrderAlgo,
      }),
    ).toEqual({ okx_stop_price: 28480, okx_tp_price: null, okx_sl_source: "position" });
  });
});
