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
  fetchContractValues,
  fetchFillsHistory,
  fetchPositionsHistory,
  fetchTotalEquity,
} from "@/lib/okx/history";
import { matchPosition, positionKey, sideOf, toFillInsert, toTradeInsert } from "@/lib/okx/map";
import { MAX_HISTORY_MS, readCredentials, type OkxCredentials } from "@/lib/okx/private";
import type { Database } from "@/lib/supabase/database.types";

type Db = SupabaseClient<Database>;

export interface SyncResult {
  tradesAdded: number;
  fillsAdded: number;
  /** 이번에 훑은 구간 */
  since: string;
  until: string;
}

export class OkxNotConfiguredError extends Error {
  constructor() {
    super("OKX API 키가 설정되지 않았습니다. OKX_API_KEY/SECRET/PASSPHRASE를 확인해 주세요.");
    this.name = "OkxNotConfiguredError";
  }
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
}): Promise<SyncResult> {
  const { supabase, userId, bookId, startDate } = input;

  const creds = readCredentials();
  if (!creds) throw new OkxNotConfiguredError();

  const sinceMs = await resolveSince(supabase, bookId, startDate);
  const startedAt = Date.now();

  const { data: run } = await supabase
    .from("sync_runs")
    .insert({ user_id: userId, book_id: bookId })
    .select("id")
    .single();

  try {
    const result = await runSync(supabase, creds, userId, bookId, sinceMs, startedAt);

    if (run) {
      await supabase
        .from("sync_runs")
        .update({
          finished_at: new Date().toISOString(),
          cursor_at: result.until,
          trades_added: result.tradesAdded,
          fills_added: result.fillsAdded,
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
): Promise<SyncResult> {
  const [ctVals, positions] = await Promise.all([
    fetchContractValues(),
    fetchPositionsHistory(creds, sinceMs),
  ]);

  const since = new Date(sinceMs).toISOString();
  const until = new Date(startedAt).toISOString();

  if (positions.length === 0) {
    await snapshotBalance(supabase, creds, userId, bookId);
    return { tradesAdded: 0, fillsAdded: 0, since, until };
  }

  // 이미 들어와 있는 거래는 건너뛴다 — 같은 구간을 다시 훑어도 손익이 겹치지 않게.
  const posIds = [...new Set(positions.map((p) => p.posId))];
  const { data: known } = await supabase
    .from("trades")
    .select("id, okx_pos_id, exit_at, side")
    .in("okx_pos_id", posIds);

  const seen = new Set(
    (known ?? [])
      .filter((t) => t.okx_pos_id !== null && t.exit_at !== null)
      .map((t) => positionKey(t.okx_pos_id!, Date.parse(t.exit_at!))),
  );

  // 오래된 것부터 순번을 매긴다 — 시트의 `순번`은 시간순이다.
  // 응답 안에서도 같은 거래가 두 번 올 수 있으므로 여기서 함께 걸러 낸다.
  const fresh: typeof positions = [];
  for (const pos of [...positions].sort((a, b) => Number(a.cTime) - Number(b.cTime))) {
    const key = positionKey(pos.posId, Number(pos.uTime));
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(pos);
  }

  let seq = await nextSeq(supabase, bookId);
  const rows = fresh
    .map((pos) => toTradeInsert({ pos, ctVal: ctVals.get(pos.instId) ?? null, bookId, userId, seq: seq++ }))
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length > 0) {
    const { error } = await supabase.from("trades").insert(rows);
    if (error) throw new Error(`거래 저장 실패: ${error.message}`);
  }

  const fillsAdded = await syncFills(supabase, creds, userId, positions, ctVals, sinceMs);
  await snapshotBalance(supabase, creds, userId, bookId);

  return { tradesAdded: rows.length, fillsAdded, since, until };
}

async function syncFills(
  supabase: Db,
  creds: OkxCredentials,
  userId: string,
  positions: Awaited<ReturnType<typeof fetchPositionsHistory>>,
  ctVals: Map<string, number | null>,
  sinceMs: number,
): Promise<number> {
  const fills = await fetchFillsHistory(creds, sinceMs);
  if (fills.length === 0) return 0;

  // 거래를 방금 넣었으므로 여기서 다시 읽어야 id를 알 수 있다.
  const { data: trades } = await supabase
    .from("trades")
    .select("id, okx_pos_id, exit_at, side")
    .in("okx_pos_id", [...new Set(positions.map((p) => p.posId))]);

  const tradeByPos = new Map(
    (trades ?? [])
      .filter((t) => t.okx_pos_id !== null && t.exit_at !== null)
      .map((t) => [positionKey(t.okx_pos_id!, Date.parse(t.exit_at!)), t]),
  );

  const { data: existing } = await supabase
    .from("trade_fills")
    .select("okx_bill_id")
    .in("okx_bill_id", fills.map((f) => f.billId));

  const seen = new Set((existing ?? []).map((f) => f.okx_bill_id));

  const rows = [];
  for (const fill of fills) {
    if (seen.has(fill.billId)) continue;

    const pos = matchPosition(fill, positions);
    if (!pos) continue; // 아직 안 닫힌 포지션의 체결 — 닫히는 날 같이 들어온다.

    const trade = tradeByPos.get(positionKey(pos.posId, Number(pos.uTime)));
    const side = sideOf(pos);
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

/** 계좌 자산을 찍어 둔다 — 같은 시각의 스냅샷이 이미 있으면 넘어간다. */
async function snapshotBalance(
  supabase: Db,
  creds: OkxCredentials,
  userId: string,
  bookId: string,
): Promise<void> {
  const balance = await fetchTotalEquity(creds);
  if (!balance) return;

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
    source: "okx",
  });
}
