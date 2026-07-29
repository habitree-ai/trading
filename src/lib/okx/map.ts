/**
 * OKX 응답 → 도메인 모델 변환. 순수 함수만 둔다(네트워크·DB 없음).
 *
 * OKX 포지션 1건이 일지의 거래 1건, 체결 1건이 `trade_fills` 1행에 대응한다.
 */

import type { Side, TradeResult } from "@/lib/domain";
import type { OkxFill, OkxPosition } from "@/lib/okx/schema";

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

/** 손익 부호로 승패를 정한다 — 수기 입력 경로(`inferResult`)와 같은 기준. */
export function resultOf(pnl: number | null): TradeResult {
  if (pnl === null) return "open";
  if (pnl > 0) return "win";
  if (pnl < 0) return "loss";
  return "be";
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
    result: resultOf(pos.pnl),
    entry_price: pos.openAvgPx,
    exit_price: pos.closeAvgPx,
    notional: notionalOf(pos, ctVal),
    leverage: pos.lever,
    pnl: pos.pnl,
    fee: pos.fee,
    funding_fee: pos.fundingFee,
    margin_mode: marginModeOf(pos.mgnMode),
  };
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
