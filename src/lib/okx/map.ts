/**
 * OKX 응답 → 도메인 모델 변환. 순수 함수만 둔다(네트워크·DB 없음).
 *
 * OKX 포지션 1건이 일지의 거래 1건, 체결 1건이 `trade_fills` 1행에 대응한다.
 */

import type { CashFlowKind, Side, TradeResult } from "@/lib/domain";
import type {
  OkxAccountBill,
  OkxAlgoOrder,
  OkxDeposit,
  OkxFill,
  OkxOpenPosition,
  OkxOrder,
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

export interface TradeInsert extends StopTarget {
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

/** `positions-history`에서 포지션이 남는 청산 — 부분청산과 부분 강제청산. */
const PARTIAL_CLOSE_TYPES = new Set(["1", "4"]);

/**
 * 이 이력 행이 거래 하나로 셀 수 있는 청산인가.
 *
 * 부분청산은 포지션을 남긴 채로도 이력에 행을 만든다. 그 행을 거래로 세면 같은 돈이
 * 두 번 잡힌다 — 남은 포지션이 최종 청산될 때 오는 `realizedPnl`이 부분청산분까지
 * 합친 값이기 때문이다(실계좌: 부분청산 +13.08을 따로 세는 바람에 그 몫이 최종청산
 * +27.49 안에서 한 번 더 잡혀 자금이 41.82 부풀었다).
 *
 * 부분청산분은 포지션이 열려 있는 동안 `openNetOf`가 미실현으로 들고 있다가, 최종
 * 청산되는 날 그 거래의 실현손익으로 한 번만 들어온다.
 *
 * 모르는 값은 통과시킨다 — 새 코드가 생겼다고 거래를 잃는 편이 더 나쁘다.
 */
export function isFullyClosed(pos: OkxPosition): boolean {
  return pos.type === undefined || !PARTIAL_CLOSE_TYPES.has(pos.type);
}

/** 방향을 못 정하면 null — 승패·손익률이 통째로 뒤집히느니 건너뛰는 게 낫다. */
export function toTradeInsert(input: {
  pos: OkxPosition;
  ctVal: number | null;
  bookId: string;
  userId: string;
  seq: number;
  /** 거래소에 걸려 있던 손절·익절. 못 찾았으면 비워 둔 채로 들어온다 */
  stopTarget?: StopTarget;
}): TradeInsert | null {
  const { pos, ctVal, bookId, userId, seq, stopTarget } = input;
  const side = sideOf(pos);
  if (side === null) return null;

  return {
    ...(stopTarget ?? NO_STOP_TARGET),
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

/* ============ 미청산 포지션 ============ */

/**
 * 아직 들고 있는 포지션의 방향.
 *
 * 넷 모드 계좌는 `posSide`가 `net`으로 온다. 그때는 보유 계약 수의 부호가 방향이다 —
 * 닫힌 포지션(`sideOf`)처럼 손익으로 되짚을 필요가 없다.
 */
export function openSideOf(pos: OkxOpenPosition): Side | null {
  if (pos.posSide === "long" || pos.posSide === "short") return pos.posSide;
  if (pos.pos === null || pos.pos === 0) return null;
  return pos.pos > 0 ? "long" : "short";
}

/**
 * 미청산 포지션이 지금까지 **확정한** 손익 — 부분청산 손익·수수료·펀딩비.
 *
 * 미실현(`upl`)과 갈라야 하는 이유: 이 몫은 이미 계좌의 현금이라 그대로 이체·출금에
 * 쓸 수 있다. 둘을 합쳐 '미실현'으로 담아 두면 장부에 없는 돈이 되고, 그 돈을 옮기는
 * 순간 계산 자금이 음수로 내려간다(2026-08-21 실계좌: 현금 178.09인데 화면은 −53.04).
 *
 * 시세를 따라 흔들리지 않는다 — 움직이는 건 `upl` 뿐이다.
 */
export function openRealizedOf(pos: OkxOpenPosition): number | null {
  if (pos.realizedPnl !== null) return pos.realizedPnl;
  if (pos.pnl === undefined && pos.fee === undefined && pos.fundingFee === undefined) return null;
  return (pos.pnl ?? 0) + (pos.fee ?? 0) + (pos.fundingFee ?? 0);
}

export interface OpenTradeInsert extends StopTarget {
  book_id: string;
  user_id: string;
  seq: number;
  okx_pos_id: string;
  side: Side;
  symbol: string;
  entry_at: string;
  result: TradeResult;
  entry_price: number | null;
  notional: number | null;
  leverage: number | null;
  margin_mode: "cross" | "isolated" | null;
  /** 순수 평가손익 — 시세를 따라 흔들리는 몫만 */
  unrealized_pnl: number | null;
  /** 아래 넷은 부분청산으로 **이미 확정된** 몫이다 — 시세와 무관하게 고정이다 */
  pnl: number | null;
  fee: number | null;
  funding_fee: number | null;
  realized_pnl: number | null;
}

/**
 * 아직 들고 있는 포지션을 목록의 한 줄로.
 *
 * 손익 칸(`pnl`·`fee`·`realized_pnl`)은 비워 둔다. 아직 확정된 게 없어서다 —
 * 채워 두면 누적 손익과 승률이 시세를 따라 흔들린다. 평가손익은 따로 둔 칸에 담고,
 * 청산되는 순간 `toCloseUpdate`가 그 칸을 지우고 확정값을 넣는다.
 */
export function toOpenTradeInsert(input: {
  pos: OkxOpenPosition;
  ctVal: number | null;
  bookId: string;
  userId: string;
  seq: number;
  /** 지금 걸려 있는 손절·익절 */
  stopTarget?: StopTarget;
}): OpenTradeInsert | null {
  const { pos, ctVal, bookId, userId, seq, stopTarget } = input;
  const side = openSideOf(pos);
  if (side === null) return null;

  const notional =
    pos.avgPx === null || pos.pos === null || ctVal === null
      ? null
      : pos.avgPx * Math.abs(pos.pos) * ctVal;

  return {
    ...(stopTarget ?? NO_STOP_TARGET),
    book_id: bookId,
    user_id: userId,
    seq,
    okx_pos_id: pos.posId,
    side,
    symbol: baseSymbol(pos.instId),
    entry_at: iso(pos.cTime),
    result: "open",
    entry_price: pos.avgPx,
    notional,
    leverage: pos.lever,
    margin_mode: marginModeOf(pos.mgnMode),
    unrealized_pnl: pos.upl,
    pnl: pos.pnl ?? null,
    fee: pos.fee ?? null,
    funding_fee: pos.fundingFee ?? null,
    realized_pnl: openRealizedOf(pos),
  };
}

/**
 * 손절·익절을 덮어쓸지 정한다 — **못 찾았으면 칸을 통째로 뺀다.**
 *
 * 한 번 확인한 사실을 나중의 추정 실패로 지우지 않기 위해서다. 들고 있는 동안에는
 * `closeOrderAlgo`로 정확히 읽히던 값이, 닫히고 나면 겹치는 포지션 때문에 추정을
 * 포기해 null이 될 수 있다. 그때 그대로 덮어쓰면 알고 있던 손절가가 사라진다.
 */
function stopTargetUpdate(row: StopTarget): Partial<StopTarget> {
  if (row.okx_stop_price === null && row.okx_tp_price === null) return {};
  return {
    okx_stop_price: row.okx_stop_price,
    okx_tp_price: row.okx_tp_price,
    okx_sl_source: row.okx_sl_source,
  };
}

/** 이미 있는 미청산 행에 덮어쓸 칸만 — 북·사용자·순번과 손으로 적은 칸은 건드리지 않는다. */
export function toOpenUpdate(row: OpenTradeInsert) {
  return {
    ...stopTargetUpdate(row),
    side: row.side,
    symbol: row.symbol,
    entry_at: row.entry_at,
    entry_price: row.entry_price,
    notional: row.notional,
    leverage: row.leverage,
    margin_mode: row.margin_mode,
    unrealized_pnl: row.unrealized_pnl,
    pnl: row.pnl,
    fee: row.fee,
    funding_fee: row.funding_fee,
    realized_pnl: row.realized_pnl,
  };
}

/**
 * 열려 있던 행을 닫을 때 덮어쓸 칸만.
 *
 * 새 행을 넣지 않고 이 행을 고치는 게 핵심이다 — 들고 있는 동안 적어 둔 근거·복기·
 * 원칙 판단·차트 메모가 모두 이 행의 id에 매달려 있다. 새로 넣으면 그 기록이
 * 열린 채로 남은 행에 붙어 끊긴다.
 */
export function toCloseUpdate(row: TradeInsert) {
  return {
    ...stopTargetUpdate(row),
    side: row.side,
    symbol: row.symbol,
    entry_at: row.entry_at,
    exit_at: row.exit_at,
    result: row.result,
    entry_price: row.entry_price,
    exit_price: row.exit_price,
    notional: row.notional,
    leverage: row.leverage,
    pnl: row.pnl,
    fee: row.fee,
    funding_fee: row.funding_fee,
    realized_pnl: row.realized_pnl,
    margin_mode: row.margin_mode,
    // 확정됐으니 평가손익은 지운다 — 남겨 두면 같은 금액이 두 칸에서 잡힌다.
    unrealized_pnl: null,
  };
}

/* ── 손절·익절 ───────────────────────────────────────────────────────────── */

/** 값을 어느 경로로 얻었는지. `algo`만 추정이고 나머지 둘은 식별자가 일치한 사실이다. */
export type StopTargetSource = "attached" | "position" | "algo";

/** 거래 행에 실을 손절·익절 한 쌍. 못 찾았으면 셋 다 null 이다. */
export interface StopTarget {
  okx_stop_price: number | null;
  okx_tp_price: number | null;
  okx_sl_source: StopTargetSource | null;
}

export const NO_STOP_TARGET: StopTarget = {
  okx_stop_price: null,
  okx_tp_price: null,
  okx_sl_source: null,
};

/** 트리거가를 담은 것이면 무엇이든 — 부착 주문·청산 예약·알고 주문이 같은 모양이다. */
interface TriggerPair {
  slTriggerPx: number | null;
  tpTriggerPx: number | null;
}

/**
 * 포지션이 살아 있던 구간 — 알고 주문을 되짚을 때 짝을 좁히는 데 쓴다.
 *
 * `to`가 null이면 아직 들고 있다는 뜻이라 끝이 열려 있다.
 */
export interface PositionSpan {
  posId: string;
  instId: string;
  posSide: string;
  from: number;
  to: number | null;
}

export function spanOfClosed(pos: OkxPosition): PositionSpan {
  return {
    posId: pos.posId,
    instId: pos.instId,
    // 롱숏 분리 계좌에서 둘은 같은 값이다. `posSide`가 빠진 응답만 `direction`으로 받는다.
    posSide: pos.posSide || pos.direction,
    from: Number(pos.cTime),
    to: Number(pos.uTime),
  };
}

export function spanOfOpen(pos: OkxOpenPosition): PositionSpan {
  return {
    posId: pos.posId,
    instId: pos.instId,
    posSide: pos.posSide,
    from: Number(pos.cTime),
    to: null,
  };
}

/**
 * 예약을 건 시각이 포지션 구간에서 얼마나 벗어나도 같은 포지션의 것으로 볼지.
 *
 * 진입과 예약 등록 사이에는 늘 틈이 있다 — 실계좌에서 중앙값 15초, 90%가 49초였다.
 * 그 틈이 포지션 구간 밖으로 삐져나오는 경우를 담기 위한 여유다.
 */
export const ALGO_WINDOW_MS = 60_000;

/** 두 구간이 한 순간이라도 겹치는가. 끝이 열려 있으면(`to === null`) 지금도 이어진다. */
function overlaps(a: PositionSpan, b: PositionSpan): boolean {
  return a.from <= (b.to ?? Number.POSITIVE_INFINITY) && b.from <= (a.to ?? Number.POSITIVE_INFINITY);
}

/** 트리거가가 하나라도 있는 쌍만 값으로 친다 — 둘 다 비었으면 예약이 아니다. */
function hasTrigger(t: TriggerPair): boolean {
  return t.slTriggerPx !== null || t.tpTriggerPx !== null;
}

/**
 * 손절과 익절을 **따로** 고른다 — 각각 마지막에 등록된 값이다.
 *
 * 한 레코드만 보면 안 되는 이유: 손절과 익절을 따로 걸면 예약이 두 건으로 나뉜다.
 * 최신 한 건만 취하면 먼저 건 쪽이 통째로 사라진다. 입력은 시각 오름차순이어야 한다.
 */
function pickLatest(pairs: readonly TriggerPair[], source: StopTargetSource): StopTarget | null {
  let stop: number | null = null;
  let target: number | null = null;
  for (const p of pairs) {
    if (p.slTriggerPx !== null) stop = p.slTriggerPx;
    if (p.tpTriggerPx !== null) target = p.tpTriggerPx;
  }
  if (stop === null && target === null) return null;
  return { okx_stop_price: stop, okx_tp_price: target, okx_sl_source: source };
}

/**
 * 진입 주문에 부착돼 있던 손절·익절.
 *
 * `ordId`가 일치하므로 추정이 아니다. 시스템 봇처럼 브래킷을 원자 부착하는 경로는
 * 여기서 정확히 잡힌다. 구식 부착은 주문 최상위에 실리므로 그쪽도 본다.
 */
function fromAttached(
  entryOrdIds: readonly string[],
  orders: ReadonlyMap<string, OkxOrder>,
): StopTarget | null {
  const pairs: TriggerPair[] = [];
  for (const ordId of entryOrdIds) {
    const order = orders.get(ordId);
    if (!order) continue;
    pairs.push(...order.attachAlgoOrds.filter(hasTrigger));
    if (hasTrigger(order)) pairs.push(order);
  }
  return pickLatest(pairs, "attached");
}

/**
 * 알고 주문 이력에서 되짚는다 — **추정이다.**
 *
 * 응답에 `posId`가 없어 종목·방향·시각으로만 짝을 찾는다. 같은 종목·같은 방향
 * 포지션이 시간상 겹치는 구간에서는 어느 쪽 예약인지 가릴 수 없으므로 **비워 둔다.**
 * 잘못된 손절가를 보여 주는 것이 아무것도 안 보여 주는 것보다 나쁘다.
 */
function fromAlgo(
  span: PositionSpan,
  algos: readonly OkxAlgoOrder[],
  siblings: readonly PositionSpan[],
): StopTarget | null {
  const ambiguous = siblings.some(
    (s) =>
      !(s.posId === span.posId && s.from === span.from) &&
      s.instId === span.instId &&
      s.posSide === span.posSide &&
      overlaps(s, span),
  );
  if (ambiguous) return null;

  const from = span.from - ALGO_WINDOW_MS;
  const to = (span.to ?? Number.POSITIVE_INFINITY) + ALGO_WINDOW_MS;

  const inWindow = algos
    .filter((a) => a.instId === span.instId && a.posSide === span.posSide && hasTrigger(a))
    .filter((a) => Number(a.cTime) >= from && Number(a.cTime) <= to)
    .sort((x, y) => Number(x.cTime) - Number(y.cTime));

  return pickLatest(inWindow, "algo");
}

/**
 * 거래소에 걸려 있던 손절·익절을 찾는다.
 *
 * 세 경로를 정확한 순서로 시도한다 — 식별자가 일치하는 것(`attached`, `position`)이
 * 먼저고, 시각으로 되짚는 추정(`algo`)이 마지막이다. 아무것도 못 찾으면 비워 둔다.
 */
export function stopTargetOf(input: {
  span: PositionSpan;
  /** 이 포지션을 연 체결들의 주문번호 */
  entryOrdIds: readonly string[];
  orders: ReadonlyMap<string, OkxOrder>;
  algos: readonly OkxAlgoOrder[];
  /** 이번에 함께 다루는 포지션 전부 — 구간이 겹치면 추정을 포기한다 */
  siblings: readonly PositionSpan[];
  /** 아직 들고 있는 포지션이면 지금 걸려 있는 청산 예약 */
  closeOrderAlgo?: readonly TriggerPair[];
}): StopTarget {
  const { span, entryOrdIds, orders, algos, siblings, closeOrderAlgo } = input;

  return (
    fromAttached(entryOrdIds, orders) ??
    pickLatest((closeOrderAlgo ?? []).filter(hasTrigger), "position") ??
    fromAlgo(span, algos, siblings) ??
    NO_STOP_TARGET
  );
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

/**
 * 아직 안 닫힌 포지션의 체결 — 부분청산이 여기로 들어온다.
 *
 * 닫힌 포지션과 달리 끝 시각이 없어 `[개시, 지금]`으로 본다. posId 는 종목·방향별
 * 슬롯이라 재사용되므로(실계좌 100건에 6개뿐이었다) 개시 시각 이후만 인정한다 —
 * 같은 posId 로 어제 닫힌 거래의 체결이 오늘 열린 포지션에 붙지 않게.
 *
 * 롱·숏이 같은 종목에 함께 열려 있을 수 있어 `posSide` 가 오면 그것까지 맞춘다.
 */
export function matchOpenPosition(
  fill: OkxFill,
  positions: readonly OkxOpenPosition[],
): OkxOpenPosition | null {
  const ts = Number(fill.ts);
  let best: OkxOpenPosition | null = null;

  for (const pos of positions) {
    if (pos.instId !== fill.instId) continue;
    if (ts < Number(pos.cTime) - BOUNDARY_MS) continue;
    if (fill.posSide && pos.posSide !== "net" && fill.posSide !== pos.posSide) continue;
    if (best === null || Number(pos.cTime) > Number(best.cTime)) best = pos;
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
