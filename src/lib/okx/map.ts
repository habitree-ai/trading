/**
 * OKX 응답 → 도메인 모델 변환. 순수 함수만 둔다(네트워크·DB 없음).
 *
 * OKX 포지션 1건이 일지의 거래 1건, 체결 1건이 `trade_fills` 1행에 대응한다.
 */

import type { CashFlowKind, Side, TradeResult } from "@/lib/domain";
import type {
  OkxAccountBill,
  OkxDeposit,
  OkxFill,
  OkxPosition,
  OkxWithdrawal,
} from "@/lib/okx/schema";

/** `BTC-USDT-SWAP` → `BTC`. 일지는 기초자산만 저장하고 계약 이름은 화면에서 다시 편다. */
export function baseSymbol(instId: string): string {
  return instId.split("-")[0].toUpperCase();
}

/**
 * 포지션 방향.
 *
 * 넷 모드 계좌는 `direction`이 `net`으로 와서 롱/숏을 말해 주지 않는다.
 * 그때는 "가격이 오른 쪽에서 벌었으면 롱"으로 되짚는다.
 */
export function sideOf(pos: OkxPosition): Side | null {
  if (pos.direction === "long" || pos.direction === "short") return pos.direction;

  const { openAvgPx: open, closeAvgPx: close, pnl } = pos;
  if (open === null || close === null || pnl === null || pnl === 0 || open === close) return null;
  return close > open === pnl > 0 ? "long" : "short";
}

/**
 * 손익 부호로 승패를 정한다 — 수기 입력 경로(`inferResult`)와 같은 기준.
 *
 * 넣는 값은 수수료·펀딩비까지 뺀 실현손익이다. 계좌가 실제로 줄었는데 '승'으로
 * 적히면 승률·기대치가 부풀고, 표의 손익률과 배지가 서로 다른 말을 한다.
 */
export function resultOf(realizedPnl: number | null): TradeResult {
  if (realizedPnl === null) return "open";
  if (realizedPnl > 0) return "win";
  if (realizedPnl < 0) return "loss";
  return "be";
}

/**
 * 계좌가 실제로 움직인 금액.
 *
 * 거래소가 준 `realizedPnl`이 정본이다. 손익·수수료·펀딩비를 더해 되짚으면 청산
 * 수수료나 ADL처럼 세 항목 어디에도 실리지 않는 비용이 빠진다 — 실계좌 46건에서
 * 5.22 어긋났다. `realizedPnl`이 비어 있을 때만 되짚는다.
 */
export function realizedOf(pos: OkxPosition): number | null {
  if (pos.realizedPnl !== null) return pos.realizedPnl;
  if (pos.pnl === null) return null;
  return pos.pnl + (pos.fee ?? 0) + (pos.fundingFee ?? 0);
}

function marginModeOf(raw: string): "cross" | "isolated" | null {
  return raw === "cross" || raw === "isolated" ? raw : null;
}

function iso(epochMs: string): string {
  return new Date(Number(epochMs)).toISOString();
}

/**
 * 명목가(시트의 `투입`).
 *
 * OKX는 포지션 크기를 계약 수로 준다. 계약 1개가 기초자산 몇 개인지(`ctVal`)를
 * 곱해야 견적통화 금액이 된다 — BTC-USDT-SWAP은 계약 하나가 0.01 BTC다.
 */
export function notionalOf(pos: OkxPosition, ctVal: number | null): number | null {
  if (pos.openAvgPx === null || pos.closeTotalPos === null || ctVal === null) return null;
  return pos.openAvgPx * pos.closeTotalPos * ctVal;
}

export interface TradeInsert {
  book_id: string;
  user_id: string;
  seq: number;
  okx_pos_id: string;
  side: Side;
  symbol: string;
  entry_at: string;
  exit_at: string;
  result: TradeResult;
  entry_price: number | null;
  exit_price: number | null;
  notional: number | null;
  leverage: number | null;
  pnl: number | null;
  fee: number | null;
  funding_fee: number | null;
  realized_pnl: number | null;
  margin_mode: "cross" | "isolated" | null;
}

/** 방향을 못 정하면 null — 승패·손익률이 통째로 뒤집히느니 건너뛰는 게 낫다. */
export function toTradeInsert(input: {
  pos: OkxPosition;
  ctVal: number | null;
  bookId: string;
  userId: string;
  seq: number;
}): TradeInsert | null {
  const { pos, ctVal, bookId, userId, seq } = input;
  const side = sideOf(pos);
  if (side === null) return null;

  return {
    book_id: bookId,
    user_id: userId,
    seq,
    okx_pos_id: pos.posId,
    side,
    symbol: baseSymbol(pos.instId),
    entry_at: iso(pos.cTime),
    exit_at: iso(pos.uTime),
    result: resultOf(realizedOf(pos)),
    entry_price: pos.openAvgPx,
    exit_price: pos.closeAvgPx,
    notional: notionalOf(pos, ctVal),
    leverage: pos.lever,
    pnl: pos.pnl,
    fee: pos.fee,
    funding_fee: pos.fundingFee,
    realized_pnl: pos.realizedPnl,
    margin_mode: marginModeOf(pos.mgnMode),
  };
}

/**
 * 거래 하나를 가리키는 열쇠.
 *
 * `posId`만으로는 부족하다 — 종목·방향별 포지션 슬롯 id라서 같은 종목을 다시
 * 잡으면 그대로 재사용된다(실계좌 100건에 고유 posId 가 6개뿐이었다).
 * 청산 시각까지 붙여야 거래 하나가 특정된다.
 */
export function positionKey(posId: string, closedAtMs: number): string {
  return `${posId}|${closedAtMs}`;
}

/** 매수가 진입인지 청산인지는 포지션 방향이 정한다 — 숏은 매도가 진입이다. */
export function fillRole(fillSide: string, side: Side): "open" | "close" {
  return (fillSide === "buy") === (side === "long") ? "open" : "close";
}

/**
 * 체결이 어느 포지션에 속하는지 찾는다.
 *
 * 체결에는 `posId`가 없어서 종목과 시각으로 짝을 짓는다. 같은 종목을 여러 번
 * 잡았다 놓았으면 구간이 여럿이므로, 시각을 담는 구간 중 가장 늦게 열린 것을 고른다.
 * 경계에서 밀리는 것을 막으려 앞뒤 1초를 열어 둔다.
 */
const BOUNDARY_MS = 1_000;

export function matchPosition(fill: OkxFill, positions: readonly OkxPosition[]): OkxPosition | null {
  const ts = Number(fill.ts);
  let best: OkxPosition | null = null;

  for (const pos of positions) {
    if (pos.instId !== fill.instId) continue;
    const open = Number(pos.cTime);
    const close = Number(pos.uTime);
    if (ts < open - BOUNDARY_MS || ts > close + BOUNDARY_MS) continue;
    if (best === null || open > Number(best.cTime)) best = pos;
  }
  return best;
}

export interface FillInsert {
  trade_id: string;
  user_id: string;
  role: "open" | "close";
  filled_at: string;
  price: number;
  amount: number | null;
  fee: number | null;
  order_no: string;
  okx_bill_id: string;
}

/* ============ 입출금 ============ */

/** OKX가 '완료'로 쓰는 상태값. 진행 중·취소 건을 넣으면 곡선이 앞서 나간다. */
const DONE_STATE = "2";

export interface CashFlowInsert {
  book_id: string;
  user_id: string;
  kind: CashFlowKind;
  at: string;
  ccy: string;
  /** 부호 포함 — 들어오면 +, 나가면 − */
  amount: number;
  fee: number | null;
  note: string | null;
  okx_ref: string;
  source: "okx";
}

/**
 * 거래계좌 이체 — 잔고 변화(`balChg`)가 곧 부호 포함 금액이다.
 *
 * 자금 곡선을 움직이는 건 이 종류뿐이다. 방향을 따로 뒤집지 않는다 —
 * OKX가 이미 거래계좌 기준으로 부호를 매겨 준다(들어오면 +, 나가면 −).
 */
export function toTransferInsert(input: {
  bill: OkxAccountBill;
  bookId: string;
  userId: string;
}): CashFlowInsert | null {
  const { bill, bookId, userId } = input;
  if (bill.balChg === null || bill.balChg === 0) return null;

  return {
    book_id: bookId,
    user_id: userId,
    kind: "transfer",
    at: iso(bill.ts),
    ccy: bill.ccy,
    amount: bill.balChg,
    fee: null,
    note: bill.notes || null,
    okx_ref: bill.billId,
    source: "okx",
  };
}

/** 온체인 입금 — 자금계좌로 들어온 돈이라 항상 +다. */
export function toDepositInsert(input: {
  deposit: OkxDeposit;
  bookId: string;
  userId: string;
}): CashFlowInsert | null {
  const { deposit, bookId, userId } = input;
  if (deposit.state !== DONE_STATE || deposit.amt === null) return null;

  return {
    book_id: bookId,
    user_id: userId,
    kind: "deposit",
    at: iso(deposit.ts),
    ccy: deposit.ccy,
    amount: Math.abs(deposit.amt),
    fee: null,
    note: deposit.chain || null,
    okx_ref: deposit.depId,
    source: "okx",
  };
}

/** 온체인 출금 — 나간 돈이라 −로 뒤집는다. 망 수수료는 따로 남긴다. */
export function toWithdrawalInsert(input: {
  withdrawal: OkxWithdrawal;
  bookId: string;
  userId: string;
}): CashFlowInsert | null {
  const { withdrawal, bookId, userId } = input;
  if (withdrawal.state !== DONE_STATE || withdrawal.amt === null) return null;

  return {
    book_id: bookId,
    user_id: userId,
    kind: "withdrawal",
    at: iso(withdrawal.ts),
    ccy: withdrawal.ccy,
    amount: -Math.abs(withdrawal.amt),
    fee: withdrawal.fee === null ? null : -Math.abs(withdrawal.fee),
    note: withdrawal.chain || null,
    okx_ref: withdrawal.wdId,
    source: "okx",
  };
}

/** 가격이 없는 체결은 차트에 찍을 수 없으므로 버린다. */
export function toFillInsert(input: {
  fill: OkxFill;
  ctVal: number | null;
  tradeId: string;
  userId: string;
  side: Side;
}): FillInsert | null {
  const { fill, ctVal, tradeId, userId, side } = input;
  if (fill.fillPx === null) return null;

  const amount =
    fill.fillSz !== null && ctVal !== null ? fill.fillPx * fill.fillSz * ctVal : null;

  return {
    trade_id: tradeId,
    user_id: userId,
    role: fillRole(fill.side, side),
    filled_at: iso(fill.ts),
    price: fill.fillPx,
    amount,
    fee: fill.fee,
    order_no: fill.ordId,
    okx_bill_id: fill.billId,
  };
}
