import { cookies } from "next/headers";

import type { Book, Goal, SyncRun, Trade, TradeFill } from "@/lib/domain";
import { createClient } from "@/lib/supabase/server";

/** 어떤 북을 보고 있는지는 쿠키로 기억한다 — URL을 오염시키지 않기 위해. */
export const ACTIVE_BOOK_COOKIE = "active_book";

export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("인증이 필요합니다.");
  return { supabase, user };
}

export async function listBooks(): Promise<Book[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("books")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data;
}

/** 활성 북 — 쿠키에 지정된 북, 없으면 가장 최근 북. 북이 하나도 없으면 null. */
export async function getActiveBook(books?: Book[]): Promise<Book | null> {
  const all = books ?? (await listBooks());
  if (all.length === 0) return null;

  const preferred = (await cookies()).get(ACTIVE_BOOK_COOKIE)?.value;
  return all.find((b) => b.id === preferred) ?? all[0];
}

export async function listTrades(bookId: string): Promise<Trade[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("trades")
    .select("*")
    .eq("book_id", bookId)
    .order("entry_at", { ascending: true })
    .order("seq", { ascending: true });
  if (error) throw new Error(error.message);
  return data;
}

export async function getTrade(id: string): Promise<Trade | null> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from("trades").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** 북 안의 모든 체결 — 거래 id로 묶어 돌려준다(목록에서 거래마다 다시 묻지 않도록). */
export async function listFillsByTrade(bookId: string): Promise<Record<string, TradeFill[]>> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("trade_fills")
    .select("*, trades!inner(book_id)")
    .eq("trades.book_id", bookId)
    .order("filled_at", { ascending: true });
  if (error) throw new Error(error.message);

  const grouped: Record<string, TradeFill[]> = {};
  for (const row of data) {
    // 조인용으로 딸려 온 `trades` 키는 버리고 체결 행만 남긴다.
    const fill = { ...(row as TradeFill & { trades?: unknown }) };
    delete fill.trades;
    (grouped[fill.trade_id] ??= []).push(fill);
  }
  return grouped;
}

export async function listFills(tradeId: string): Promise<TradeFill[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("trade_fills")
    .select("*")
    .eq("trade_id", tradeId)
    .order("filled_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data;
}

/**
 * 마지막으로 성공한 동기화.
 *
 * OKX는 3개월치만 준다 — 얼마나 밀렸는지 눈에 보여야 유실을 알아챌 수 있다.
 */
export async function getLastSync(bookId: string): Promise<SyncRun | null> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("sync_runs")
    .select("*")
    .eq("book_id", bookId)
    .is("error", null)
    .not("finished_at", "is", null)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return (data[0] as SyncRun | undefined) ?? null;
}

export async function listGoals(bookId: string): Promise<Goal[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from("goals").select("*").eq("book_id", bookId);
  if (error) throw new Error(error.message);
  return data;
}

/** 북 내 다음 순번 — 시트의 `순번`을 이어받는다. */
export async function nextSeq(bookId: string): Promise<number> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("trades")
    .select("seq")
    .eq("book_id", bookId)
    .order("seq", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return (data[0]?.seq ?? 0) + 1;
}
