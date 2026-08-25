/**
 * OKX 동기화 — 거래소 내역을 읽어 일지에 쌓는다.
 *
 * 두 번 돌려도 결과가 같아야 한다(멱등). 그래서 넣기 전에 이미 있는
 * `okx_pos_id`/`okx_bill_id`를 먼저 빼고, 남은 것만 넣는다.
 *
 * OKX는 3개월치만 돌려준다 — `sync_runs.cursor_at`에 어디까지 훑었는지 남겨
 * 다음 실행이 그 지점부터 이어 가게 한다.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  fetchAccountTransfers,
  fetchAlgoOrders,
  fetchContractValues,
  fetchDeposits,
  fetchFillsHistory,
  fetchOpenPositions,
  fetchOrders,
  fetchPositionsHistory,
  fetchTotalEquity,
  fetchWithdrawals,
  openPositionPnl,
} from "@/lib/okx/history";
import {
  ALGO_WINDOW_MS,
  fillRole,
  isFullyClosed,
  matchOpenPosition,
  matchPosition,
  openSideOf,
  positionKey,
  sideOf,
  spanOfClosed,
  spanOfOpen,
  stopTargetOf,
  toCloseUpdate,
  toDepositInsert,
  toFillInsert,
  toOpenTradeInsert,
  toOpenUpdate,
  toTradeInsert,
  toTransferInsert,
  toWithdrawalInsert,
  type CashFlowInsert,
  type PositionSpan,
} from "@/lib/okx/map";
import { MAX_HISTORY_MS, type OkxCredentials } from "@/lib/okx/private";
import type { OkxAlgoOrder, OkxFill, OkxOpenPosition, OkxOrder } from "@/lib/okx/schema";
import type { Database } from "@/lib/supabase/database.types";

type Db = SupabaseClient<Database>;

export interface SyncResult {
  tradesAdded: number;
  /** 들고 있던 줄을 청산으로 덮어쓴 건수 — 적어 둔 기록은 그대로 남는다 */
  tradesClosed: number;
  /** 목록에 올라간 미청산 포지션 수 */
  openCount: number;
  fillsAdded: number;
  /** 입금·출금·이체 */
  flowsAdded: number;
  /** 이번에 훑은 구간 */
  since: string;
  until: string;
}

/**
 * 어디서부터 이어 받을지 정한다.
 *
 * 마지막으로 성공한 실행의 커서가 출발점이고, 없으면 북 시작일이다.
 * 어느 쪽이든 3개월보다 오래된 구간은 API가 주지 않으므로 거기서 자른다.
 */
async function resolveSince(supabase: Db, bookId: string, startDate: string): Promise<number> {
  const { data } = await supabase
    .from("sync_runs")
    .select("cursor_at")
    .eq("book_id", bookId)
    .is("error", null)
    .not("cursor_at", "is", null)
    .order("started_at", { ascending: false })
    .limit(1);

  const last = data?.[0]?.cursor_at;
  const wanted = last ? Date.parse(last) : Date.parse(`${startDate}T00:00:00Z`);
  const floor = Date.now() - MAX_HISTORY_MS;
  return Math.max(Number.isFinite(wanted) ? wanted : floor, floor);
}

/**
 * 입출금을 훑을 구간 — 커서를 보지 않고 매번 3개월 전체를 다시 본다.
 *
 * 거래와 달리 커서를 따라가면 안 된다. 커서는 이 기능이 생기기 전부터 앞으로만
 * 밀려 왔기 때문에, 그 지점부터 훑으면 과거 입출금이 영영 들어오지 못한다.
 * 건수가 적고 `okx_ref`로 중복을 걸러 내므로 매번 다시 훑어도 값이 싸다.
 */
function flowWindow(startDate: string): number {
  const floor = Date.now() - MAX_HISTORY_MS;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  return Math.max(Number.isFinite(start) ? start : floor, floor);
}

/**
 * 체결을 훑을 구간 — 들고 있는 포지션이 열린 시점까지 거슬러 올라간다.
 *
 * 커서만 따라가면 아직 안 닫힌 포지션의 체결은 영영 못 들어온다. 그 체결들은 열려
 * 있는 동안 붙일 데가 없어 건너뛰어졌고, 커서는 그새 앞으로 밀렸기 때문이다.
 * 부분청산이 그 자리에 있다 — 금액은 실현손익으로 들어와 있는데 근거가 비는 셈이다.
 *
 * 중복은 `okx_bill_id`로 걸러지므로 같은 구간을 다시 훑어도 값이 싸다.
 */
function fillWindow(sinceMs: number, open: readonly OkxOpenPosition[]): number {
  const floor = Date.now() - MAX_HISTORY_MS;
  const oldest = open.reduce((a, p) => Math.min(a, Number(p.cTime)), Number.POSITIVE_INFINITY);
  return Math.max(Math.min(sinceMs, Number.isFinite(oldest) ? oldest : sinceMs), floor);
}

/**
 * 손절·익절을 훑을 구간 — 이번에 다루는 포지션이 열린 시점까지 거슬러 올라간다.
 *
 * 커서(`sinceMs`)를 그대로 쓰면 안 된다. 그건 **청산** 시각 기준이라, 오래 들고 있다
 * 어제 닫은 포지션의 손절은 훨씬 이전에 걸려 있어 구간 밖으로 떨어진다.
 * 예약이 진입보다 조금 이를 수 있어 `ALGO_WINDOW_MS`만큼 더 여유를 둔다.
 */
function stopWindow(
  positions: readonly { cTime: string }[],
  open: readonly { cTime: string }[],
): number {
  const floor = Date.now() - MAX_HISTORY_MS;
  const oldest = [...positions, ...open].reduce(
    (a, p) => Math.min(a, Number(p.cTime)),
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(oldest)) return floor;
  return Math.max(oldest - ALGO_WINDOW_MS, floor);
}

/**
 * 포지션을 **연** 체결의 주문번호를 포지션별로 모은다.
 *
 * 진입 주문에 부착된 브래킷을 되찾는 열쇠다. 청산 체결의 주문번호로는 안 된다 —
 * 거기엔 부착 예약이 실리지 않는다. 닫힌 포지션은 `positionKey`로, 들고 있는
 * 포지션은 `posId`로 갈린다(`syncFills`와 같은 규칙).
 */
function entryOrdIds(
  fills: readonly OkxFill[],
  positions: readonly Awaited<ReturnType<typeof fetchPositionsHistory>>[number][],
  open: readonly OkxOpenPosition[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();

  for (const fill of fills) {
    const closedPos = matchPosition(fill, positions);
    const openPos = closedPos ? null : matchOpenPosition(fill, open);

    const side = closedPos ? sideOf(closedPos) : openPos ? openSideOf(openPos) : null;
    if (side === null || fillRole(fill.side, side) !== "open") continue;

    const key = closedPos
      ? positionKey(closedPos.posId, Number(closedPos.uTime))
      : openPos!.posId;
    const list = out.get(key);
    if (list) list.push(fill.ordId);
    else out.set(key, [fill.ordId]);
  }

  return out;
}

/** 손절·익절을 되짚는 데 필요한 재료 한 묶음. */
interface StopSources {
  algos: readonly OkxAlgoOrder[];
  orders: ReadonlyMap<string, OkxOrder>;
  entryOrdIds: ReadonlyMap<string, string[]>;
  /** 이번에 다루는 포지션 전부 — 구간이 겹치면 추정을 포기한다 */
  siblings: readonly PositionSpan[];
}

const NO_STOP_SOURCES: StopSources = {
  algos: [],
  orders: new Map(),
  entryOrdIds: new Map(),
  siblings: [],
};

async function nextSeq(supabase: Db, bookId: string): Promise<number> {
  const { data } = await supabase
    .from("trades")
    .select("seq")
    .eq("book_id", bookId)
    .order("seq", { ascending: false })
    .limit(1);
  return (data?.[0]?.seq ?? 0) + 1;
}

export async function syncOkx(input: {
  supabase: Db;
  userId: string;
  bookId: string;
  startDate: string;
  /** 어느 거래소 계정으로 받는지 — 키는 호출부가 Vault 에서 꺼내 넘긴다. */
  exchangeAccountId: string;
  creds: OkxCredentials;
}): Promise<SyncResult> {
  const { supabase, userId, bookId, startDate, exchangeAccountId, creds } = input;

  const sinceMs = await resolveSince(supabase, bookId, startDate);
  const startedAt = Date.now();

  const { data: run } = await supabase
    .from("sync_runs")
    .insert({ user_id: userId, book_id: bookId, exchange_account_id: exchangeAccountId })
    .select("id")
    .single();

  try {
    const result = await runSync(supabase, creds, userId, bookId, sinceMs, startedAt, startDate);

    if (run) {
      await supabase
        .from("sync_runs")
        .update({
          finished_at: new Date().toISOString(),
          cursor_at: result.until,
          // 청산으로 덮어쓴 것도 이번에 들어온 거래다 — 0건으로 남으면 이력이 거짓말을 한다.
          trades_added: result.tradesAdded + result.tradesClosed,
          fills_added: result.fillsAdded,
          flows_added: result.flowsAdded,
        })
        .eq("id", run.id);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (run) {
      await supabase
        .from("sync_runs")
        .update({ finished_at: new Date().toISOString(), error: message })
        .eq("id", run.id);
    }
    throw error;
  }
}

async function runSync(
  supabase: Db,
  creds: OkxCredentials,
  userId: string,
  bookId: string,
  sinceMs: number,
  startedAt: number,
  startDate: string,
): Promise<SyncResult> {
  const [ctVals, history, open] = await Promise.all([
    fetchContractValues(),
    fetchPositionsHistory(creds, sinceMs),
    fetchOpenPositions(creds),
  ]);

  // 부분청산은 포지션이 남는데도 이력에 행을 만든다 — 거래로 세면 그 몫이 최종청산의
  // 실현손익 안에서 한 번 더 잡힌다. 열려 있는 동안은 미청산 행의 평가손익이 들고 있다.
  const positions = history.filter(isFullyClosed);

  const since = new Date(sinceMs).toISOString();
  const until = new Date(startedAt).toISOString();

  // 입출금은 거래가 없어도 잔고를 움직인다 — 포지션 유무와 무관하게 훑는다.
  const flowsAdded = await syncCashFlows(supabase, creds, userId, bookId, flowWindow(startDate));

  // 닫힌 포지션이 없어도 들고 있는 포지션의 부분청산 체결은 들어와야 한다.
  const hasPositions = positions.length > 0 || open.length > 0;

  /*
   * 체결을 여기서 받는 이유는 거래 쪽도 이걸 봐야 하기 때문이다 — 진입 체결의
   * 주문번호가 있어야 진입 주문에 부착된 손절·익절을 되찾는다. 두 번 부르지 않는다.
   */
  const fills = hasPositions
    ? await fetchFillsHistory(creds, fillWindow(sinceMs, open))
    : [];

  const stops = hasPositions
    ? await collectStops(creds, positions, open, fills)
    : NO_STOP_SOURCES;

  const counts = await syncTrades(supabase, userId, bookId, positions, open, ctVals, stops);
  const fillsAdded = hasPositions
    ? await syncFills(supabase, userId, positions, open, ctVals, fills)
    : 0;

  await snapshotBalance(supabase, creds, userId, bookId, open);

  return { ...counts, fillsAdded, flowsAdded, since, until };
}

/**
 * 거래소에 걸려 있던 손절·익절을 되짚을 재료를 모은다.
 *
 * 알고 주문 이력과 주문 이력을 함께 부른다 — 앞의 것은 나중에 따로 건 예약을,
 * 뒤의 것은 진입 주문에 부착된 브래킷을 담는다. 어느 쪽도 `posId`를 주지 않아
 * 짝짓기는 `map.ts`가 한다.
 */
async function collectStops(
  creds: OkxCredentials,
  positions: Awaited<ReturnType<typeof fetchPositionsHistory>>,
  open: readonly OkxOpenPosition[],
  fills: readonly OkxFill[],
): Promise<StopSources> {
  const since = stopWindow(positions, open);
  const [algos, orders] = await Promise.all([
    fetchAlgoOrders(creds, since),
    fetchOrders(creds, since),
  ]);

  return {
    algos,
    orders: new Map(orders.map((o) => [o.ordId, o])),
    entryOrdIds: entryOrdIds(fills, positions, open),
    siblings: [...positions.map(spanOfClosed), ...open.map(spanOfOpen)],
  };
}

/**
 * 닫힌 포지션과 들고 있는 포지션을 한 번에 맞춰 넣는다.
 *
 * 들고 있는 포지션도 목록에 올린다 — 진입 근거는 들어갈 때 적어야 뜻이 있고, 청산되고
 * 나서 되짚어 적으면 이미 결과를 아는 채로 쓴 글이 된다.
 *
 * 청산되면 **그 줄을 덮어쓴다**. 새 줄을 넣으면 들고 있는 동안 적어 둔 근거·복기·
 * 원칙 판단·차트 메모가 열린 채 남은 줄에 매달려 끊긴다.
 */
async function syncTrades(
  supabase: Db,
  userId: string,
  bookId: string,
  positions: Awaited<ReturnType<typeof fetchPositionsHistory>>,
  open: readonly OkxOpenPosition[],
  ctVals: Map<string, number | null>,
  stops: StopSources,
): Promise<{ tradesAdded: number; tradesClosed: number; openCount: number }> {
  const posIds = [...new Set([...positions, ...open].map((p) => p.posId))];
  if (posIds.length === 0) return { tradesAdded: 0, tradesClosed: 0, openCount: 0 };

  /*
   * 이 북의 것만 본다.
   *
   * `okx_pos_id`는 거래소 계정 안에서만 유일하다. 북으로 좁히지 않으면 같은 계정을
   * 붙인 다른 북의 줄을 열려 있는 줄로 착각해 덮어쓴다.
   */
  const { data: known } = await supabase
    .from("trades")
    .select("id, okx_pos_id, exit_at")
    .eq("book_id", bookId)
    .in("okx_pos_id", posIds);

  const closed = new Set(
    (known ?? [])
      .filter((t) => t.okx_pos_id !== null && t.exit_at !== null)
      .map((t) => positionKey(t.okx_pos_id!, Date.parse(t.exit_at!))),
  );

  // 아직 안 닫힌 줄 — posId 하나에 하나뿐이라 이것으로 특정된다.
  const holding = new Map(
    (known ?? [])
      .filter((t) => t.okx_pos_id !== null && t.exit_at === null)
      .map((t) => [t.okx_pos_id!, t.id]),
  );

  let seq = await nextSeq(supabase, bookId);
  let tradesClosed = 0;
  const inserts = [];

  // 오래된 것부터 순번을 매긴다 — 시트의 `순번`은 시간순이다.
  // 응답 안에서도 같은 거래가 두 번 올 수 있으므로 여기서 함께 걸러 낸다.
  for (const pos of [...positions].sort((a, b) => Number(a.cTime) - Number(b.cTime))) {
    const key = positionKey(pos.posId, Number(pos.uTime));
    if (closed.has(key)) continue;
    closed.add(key);

    const ctVal = ctVals.get(pos.instId) ?? null;
    const stopTarget = stopTargetOf({
      span: spanOfClosed(pos),
      entryOrdIds: stops.entryOrdIds.get(key) ?? [],
      orders: stops.orders,
      algos: stops.algos,
      siblings: stops.siblings,
    });
    const row = toTradeInsert({ pos, ctVal, bookId, userId, seq, stopTarget });
    if (row === null) continue;

    const holdingId = holding.get(pos.posId);
    if (holdingId === undefined) {
      seq += 1;
      inserts.push(row);
      continue;
    }

    holding.delete(pos.posId);
    const { error } = await supabase
      .from("trades")
      .update(toCloseUpdate(row))
      .eq("id", holdingId);
    if (error) throw new Error(`거래 청산 반영 실패: ${error.message}`);
    tradesClosed += 1;
  }

  // 아직 들고 있는 포지션 — 있던 줄은 값만 새로 고치고, 없으면 자리를 만든다.
  let openCount = 0;
  for (const pos of [...open].sort((a, b) => Number(a.cTime) - Number(b.cTime))) {
    const ctVal = ctVals.get(pos.instId) ?? null;
    const stopTarget = stopTargetOf({
      span: spanOfOpen(pos),
      entryOrdIds: stops.entryOrdIds.get(pos.posId) ?? [],
      orders: stops.orders,
      algos: stops.algos,
      siblings: stops.siblings,
      closeOrderAlgo: pos.closeOrderAlgo,
    });
    const row = toOpenTradeInsert({ pos, ctVal, bookId, userId, seq, stopTarget });
    if (row === null) continue;
    openCount += 1;

    const holdingId = holding.get(pos.posId);
    if (holdingId === undefined) {
      seq += 1;
      inserts.push(row);
      continue;
    }

    holding.delete(pos.posId);
    const { error } = await supabase
      .from("trades")
      .update(toOpenUpdate(row))
      .eq("id", holdingId);
    if (error) throw new Error(`보유 포지션 갱신 실패: ${error.message}`);
  }

  if (inserts.length > 0) {
    const { error } = await supabase.from("trades").insert(inserts);
    if (error) throw new Error(`거래 저장 실패: ${error.message}`);
  }

  return { tradesAdded: inserts.length, tradesClosed, openCount };
}

/**
 * 입금·출금·이체를 받아 쌓는다.
 *
 * 세 갈래를 한 표에 모으되 종류를 나눠 둔다 — 거래계좌 잔액을 움직이는 건 이체뿐이라
 * 자금 곡선은 이체만 보고, 입금·출금은 실제 현금이 얼마나 드나들었는지에만 쓴다.
 */
async function syncCashFlows(
  supabase: Db,
  creds: OkxCredentials,
  userId: string,
  bookId: string,
  sinceMs: number,
): Promise<number> {
  const [transfers, deposits, withdrawals] = await Promise.all([
    fetchAccountTransfers(creds, sinceMs),
    fetchDeposits(creds, sinceMs),
    fetchWithdrawals(creds, sinceMs),
  ]);

  const rows: CashFlowInsert[] = [
    ...transfers.map((bill) => toTransferInsert({ bill, bookId, userId })),
    ...deposits.map((deposit) => toDepositInsert({ deposit, bookId, userId })),
    ...withdrawals.map((withdrawal) => toWithdrawalInsert({ withdrawal, bookId, userId })),
  ].filter((row): row is CashFlowInsert => row !== null);

  if (rows.length === 0) return 0;

  // 이미 들어와 있는 건은 빼고 넣는다 — 같은 구간을 다시 훑어도 잔고가 겹치지 않게.
  const { data: existing } = await supabase
    .from("cash_flows")
    .select("kind, okx_ref")
    .eq("book_id", bookId)
    .in("okx_ref", rows.map((r) => r.okx_ref));

  const seen = new Set((existing ?? []).map((f) => `${f.kind}|${f.okx_ref}`));
  const fresh = rows.filter((r) => !seen.has(`${r.kind}|${r.okx_ref}`));
  if (fresh.length === 0) return 0;

  const { error } = await supabase.from("cash_flows").insert(fresh);
  if (error) throw new Error(`입출금 저장 실패: ${error.message}`);
  return fresh.length;
}

/**
 * 체결을 거래 행에 붙인다 — 닫힌 거래와 **아직 들고 있는 거래** 양쪽에.
 *
 * 열린 포지션의 체결까지 넣는 이유는 부분청산 때문이다. 부분청산은 포지션을 닫지
 * 않으므로 거래 행이 생기지 않는데, 그 체결마저 버리면 "언제 얼마를 덜어냈나"가
 * 어디에도 남지 않는다 — 금액은 그 행의 실현손익에 들어와 있는데 근거가 없는 셈이다.
 */
async function syncFills(
  supabase: Db,
  userId: string,
  positions: Awaited<ReturnType<typeof fetchPositionsHistory>>,
  openPositions: readonly OkxOpenPosition[],
  ctVals: Map<string, number | null>,
  fills: readonly OkxFill[],
): Promise<number> {
  if (fills.length === 0) return 0;

  // 거래를 방금 넣었으므로 여기서 다시 읽어야 id를 알 수 있다.
  const { data: trades } = await supabase
    .from("trades")
    .select("id, okx_pos_id, exit_at, side")
    .in("okx_pos_id", [
      ...new Set([...positions.map((p) => p.posId), ...openPositions.map((p) => p.posId)]),
    ]);

  const tradeByPos = new Map(
    (trades ?? [])
      .filter((t) => t.okx_pos_id !== null && t.exit_at !== null)
      .map((t) => [positionKey(t.okx_pos_id!, Date.parse(t.exit_at!)), t]),
  );

  // 들고 있는 거래는 청산 시각이 없어 posId 하나로 특정된다.
  const openTradeByPos = new Map(
    (trades ?? [])
      .filter((t) => t.okx_pos_id !== null && t.exit_at === null)
      .map((t) => [t.okx_pos_id!, t]),
  );

  const { data: existing } = await supabase
    .from("trade_fills")
    .select("okx_bill_id")
    .in("okx_bill_id", fills.map((f) => f.billId));

  const seen = new Set((existing ?? []).map((f) => f.okx_bill_id));

  const rows = [];
  for (const fill of fills) {
    if (seen.has(fill.billId)) continue;

    // 닫힌 포지션이 먼저다 — 구간이 정해져 있어 짝이 더 좁게 잡힌다.
    const closedPos = matchPosition(fill, positions);
    const openPos = closedPos ? null : matchOpenPosition(fill, openPositions);

    const trade = closedPos
      ? tradeByPos.get(positionKey(closedPos.posId, Number(closedPos.uTime)))
      : openPos
        ? openTradeByPos.get(openPos.posId)
        : undefined;
    const side = closedPos ? sideOf(closedPos) : openPos ? openSideOf(openPos) : null;
    if (!trade || !side) continue;

    const row = toFillInsert({
      fill,
      ctVal: ctVals.get(fill.instId) ?? null,
      tradeId: trade.id,
      userId,
      side,
    });
    if (row) rows.push(row);
  }

  if (rows.length === 0) return 0;

  const { error } = await supabase.from("trade_fills").insert(rows);
  if (error) throw new Error(`체결 저장 실패: ${error.message}`);
  return rows.length;
}

/**
 * 계좌 자산을 찍어 둔다 — 같은 시각의 스냅샷이 이미 있으면 넘어간다.
 *
 * 미청산 포지션의 손익을 함께 남긴다. 잔고에는 들어 있고 거래 목록에는 아직 없는
 * 금액이라, 이걸 모르면 포지션을 들고 있는 내내 계산 자금이 어긋나 보인다.
 */
async function snapshotBalance(
  supabase: Db,
  creds: OkxCredentials,
  userId: string,
  bookId: string,
  positions: readonly OkxOpenPosition[],
): Promise<void> {
  const balance = await fetchTotalEquity(creds);
  if (!balance) return;

  const open = openPositionPnl(positions);

  const { data: dup } = await supabase
    .from("balance_snapshots")
    .select("id")
    .eq("book_id", bookId)
    .eq("at", balance.at)
    .limit(1);

  if (dup && dup.length > 0) return;

  await supabase.from("balance_snapshots").insert({
    book_id: bookId,
    user_id: userId,
    at: balance.at,
    equity: balance.equity,
    // 순수 평가손익만 — 부분청산으로 확정된 몫은 거래 행의 실현손익으로 들어간다.
    unrealized_pnl: open.unrealized,
    source: "okx",
  });
}
