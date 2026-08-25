import { describe, expect, it } from "vitest";

import { toOpenTradeInsert } from "@/lib/okx/map";
import type { OkxOpenPosition } from "@/lib/okx/schema";
import { computeMetrics, deriveTrades } from "@/lib/metrics";
import { reconcileEquity } from "@/lib/reconcile";
import type { Book, CashFlow, Trade } from "@/lib/domain";

/**
 * 부분청산으로 확정된 돈은 이미 현금이다.
 *
 * 2026-08-21 실계좌에서 이 값들을 그대로 떠 왔다. 그때 화면은 현재자금을 −53.04로
 * 그리고 있었고 거래소 현금은 178.09였다 — 231.13이 비었는데, 그 액수는 열린
 * 포지션이 부분청산으로 이미 확정해 둔 realizedPnl 과 같았다. 확정된 그 돈으로
 * 130을 자금계좌로 옮기자 장부가 마이너스로 내려갔다.
 *
 * 더 나빴던 것은 화면이 "거래소 잔고와 일치합니다"라고 말한 점이다. 대조식도 같은
 * 값을 빼고 있어서 두 숫자가 서로 맞아 보였을 뿐, 실제와는 231 벌어져 있었다.
 */

/** 2026-08-21T07:28Z 실계좌: BTC 롱 100배, 절반이 이미 청산된 상태. */
const LIVE_POSITION: OkxOpenPosition = {
  posId: "3711868481042571264",
  instId: "BTC-USDT-SWAP",
  mgnMode: "isolated",
  posSide: "long",
  pos: 5.14,
  avgPx: 71586.0611489776,
  lever: 100,
  upl: 237.92,
  realizedPnl: 231.01,
  pnl: 234.12,
  fee: -2.59,
  fundingFee: -0.52,
  // 이 테스트는 잔고 대조만 본다 — 손절 예약 유무와 무관하다.
  closeOrderAlgo: [],
  cTime: "1787233383415",
};

/** 그 시각 거래계좌: 현금 178.09 + 미실현 237.92 = 416.01 */
const LIVE_EQUITY = 416.01;
const LIVE_CASH = 178.09;

const BOOK: Book = {
  id: "book",
  user_id: "user",
  name: "100$ TEST",
  exchange: "okx",
  exchange_account_id: "acct",
  base_currency: "USDT",
  initial_capital: 3.65,
  start_date: "2026-08-11",
  status: "active",
  memo: null,
  created_at: "2026-08-11T00:00:00Z",
};

function trade(over: Partial<Trade>): Trade {
  return {
    id: over.okx_pos_id ?? "t",
    book_id: "book",
    user_id: "user",
    seq: 1,
    symbol: "BTC",
    side: "long",
    entry_at: "2026-08-19T00:00:00Z",
    exit_at: "2026-08-19T01:00:00Z",
    result: "win",
    entry_price: 70000,
    exit_price: 71000,
    pnl: 0,
    fee: 0,
    funding_fee: 0,
    realized_pnl: 0,
    unrealized_pnl: null,
    notional: null,
    leverage: 100,
    margin_mode: "isolated",
    equity_before: null,
    equity_after: null,
    withdrawal: null,
    okx_pos_id: null,
    stop_price: null,
    tp1_price: null,
    tp2_price: null,
    tp3_price: null,
    setup: null,
    emotion: null,
    note: null,
    rationale: null,
    review: null,
    created_at: "2026-08-19T00:00:00Z",
    ...over,
  } as Trade;
}

/** 완결 거래 20건의 실현손익 합 = +5.11 (실계좌 값). 한 줄로 대표한다. */
const CLOSED = trade({ seq: 1, okx_pos_id: "closed", realized_pnl: 5.11, pnl: 78.18, fee: -71.77, funding_fee: -1.3 });

/** 거래계좌 이체 순합 −61.81 (실계좌 값) — 130 을 자금계좌로 옮긴 뒤의 값이다. */
const FLOWS: CashFlow[] = [
  {
    id: "f1",
    book_id: "book",
    user_id: "user",
    at: "2026-08-21T07:23:39Z",
    kind: "transfer",
    amount: -61.81,
    ccy: "USDT",
    fee: null,
    note: null,
    okx_ref: "3851868244172525568",
    source: "okx",
    created_at: "2026-08-21T07:23:39Z",
  } as CashFlow,
];

function openRow(): Trade {
  const insert = toOpenTradeInsert({
    pos: LIVE_POSITION,
    ctVal: 0.01,
    bookId: "book",
    userId: "user",
    seq: 2,
  });
  if (insert === null) throw new Error("열린 포지션 행을 만들지 못했습니다");
  return trade({ ...insert, id: "open", exit_at: null, result: "open" } as Partial<Trade>);
}

describe("부분청산 — 확정된 돈은 장부에도 현금이어야 한다", () => {
  it("열린 행은 미실현과 확정분을 따로 들고 있다", () => {
    const row = openRow();
    // 미실현 칸에 확정분까지 섞어 담으면 그 돈은 장부 어디에도 없는 돈이 된다.
    expect(row.unrealized_pnl).toBeCloseTo(237.92, 2);
    expect(row.realized_pnl).toBeCloseTo(231.01, 2);
    // 비용 분해가 실현손익과 어긋나지 않게 세 항도 같이 들어온다.
    expect(row.pnl).toBeCloseTo(234.12, 2);
    expect(row.fee).toBeCloseTo(-2.59, 2);
    expect(row.funding_fee).toBeCloseTo(-0.52, 2);
  });

  it("현재자금이 거래소 현금과 맞는다", () => {
    const derived = deriveTrades(BOOK, [CLOSED, openRow()], FLOWS);
    const m = computeMetrics(BOOK, derived, FLOWS);

    // 3.65(초기) + 5.11(완결) + 231.01(부분청산 확정) − 61.81(이체) = 177.96
    expect(m.finalEquity).toBeCloseTo(177.96, 1);
    // 실계좌 현금 178.09 와의 차이는 수수료 반올림 수준이어야 한다.
    expect(Math.abs(m.finalEquity - LIVE_CASH)).toBeLessThan(0.5);
  });

  it("아직 안 끝난 거래는 승패에 들어가지 않는다", () => {
    const derived = deriveTrades(BOOK, [CLOSED, openRow()], FLOWS);
    const m = computeMetrics(BOOK, derived, FLOWS);

    expect(m.openCount).toBe(1);
    expect(m.closedCount).toBe(1);
    expect(m.wins + m.losses + m.breakEvens).toBe(1);
  });

  it("잔고 대조가 실제 현금 기준으로 맞아떨어진다", () => {
    const derived = deriveTrades(BOOK, [CLOSED, openRow()], FLOWS);
    const m = computeMetrics(BOOK, derived, FLOWS);
    const row = openRow();

    const audit = reconcileEquity({
      initialCapital: m.initialCapital,
      netPnl: m.netPnl,
      netTransfer: m.netTransfer,
      tradeWithdrawal: m.totalWithdrawal,
      computedEquity: m.finalEquity,
      actual: LIVE_EQUITY,
      // 스냅샷의 미실현은 순수 평가손익이어야 한다 — 확정분을 섞으면 대조가 무의미해진다.
      unrealizedPnl: row.unrealized_pnl,
      foreignFlowCount: 0,
      baseCurrency: "USDT",
      startDate: BOOK.start_date,
      historyFloorMs: Date.parse("2026-05-01T00:00:00Z"),
      lastSyncAt: "2026-08-21T07:26:22Z",
      linked: true,
    });

    // 미실현을 걷어낸 잔고 = 실제 현금
    expect(audit.settled).toBeCloseTo(LIVE_CASH, 1);
    expect(Math.abs(audit.diff ?? 999)).toBeLessThan(0.5);
    expect(audit.tone).toBe("good");
    // 원장 항등식(초기+손익+이체−출금)도 같은 값이어야 한다.
    expect(audit.ledgerEquity).toBeCloseTo(m.finalEquity, 2);
  });

  /**
   * 최종 청산되는 날 거래소가 주는 realizedPnl 은 부분청산분까지 합친 값이다.
   * 열린 행을 그 값으로 덮어쓰므로(같은 행), 확정분을 미리 세도 두 번 잡히지 않는다.
   */
  it("완전 청산되면 같은 돈이 두 번 잡히지 않는다", () => {
    const closedSame = trade({
      seq: 2,
      okx_pos_id: LIVE_POSITION.posId,
      exit_at: "2026-08-22T00:00:00Z",
      result: "win",
      // 부분청산 231.01 + 나머지 청산분 = 거래소가 주는 최종 실현손익
      realized_pnl: 468.93,
      pnl: 471.5,
      fee: -2.05,
      funding_fee: -0.52,
      unrealized_pnl: null,
    });

    const derived = deriveTrades(BOOK, [CLOSED, closedSame], FLOWS);
    const m = computeMetrics(BOOK, derived, FLOWS);

    // 5.11 + 468.93 — 231.01 이 한 번 더 붙지 않는다.
    expect(m.netPnl).toBeCloseTo(474.04, 2);
    expect(m.finalEquity).toBeCloseTo(3.65 + 474.04 - 61.81, 2);
  });
});
