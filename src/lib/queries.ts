import { cookies } from "next/headers";

import { toAnnotation, type AnnotationRow } from "@/lib/annotations";
import { isAllowedEmail } from "@/lib/auth/allowlist";
import type {
  BalanceSnapshot,
  Book,
  CashFlow,
  ExchangeAccount,
  Goal,
  Principle,
  SyncRun,
  Trade,
  TradeAnnotation,
  TradeFill,
  TradePrincipleCheck,
} from "@/lib/domain";
import { createClient } from "@/lib/supabase/server";

/** 어떤 북을 보고 있는지는 쿠키로 기억한다 — URL을 오염시키지 않기 위해. */
export const ACTIVE_BOOK_COOKIE = "active_book";

export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("인증이 필요합니다.");
  // 미들웨어가 이미 막지만 여기서도 확인한다 — 서버 액션은 미들웨어를 거치지 않는
  // 경로로도 불릴 수 있고, 데이터에 닿기 직전이 마지막 방어선이다.
  if (!isAllowedEmail(user.email)) throw new Error("이 앱을 쓸 수 있는 계정이 아닙니다.");
  return { supabase, user };
}

/**
 * 내 거래소 계정 — 사용자당 거래소별 하나다.
 *
 * 키 원문은 이 경로로 절대 나오지 않는다. Vault 가 들고 있고 복호화는
 * 서버(service_role) 전용 함수뿐이다.
 */
export async function getExchangeAccount(): Promise<ExchangeAccount | null> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("exchange_accounts")
    .select("id, user_id, exchange, label, created_at, updated_at")
    .eq("exchange", "okx")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ExchangeAccount | null) ?? null;
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
 * 거래 1건에 남긴 차트 메모 — 오래된 것부터.
 *
 * 형태가 깨진 행은 그 건만 버린다. 좌표 하나 때문에 차트에서 메모가 통째로 사라지면
 * 무엇을 잃었는지조차 알 수 없다.
 */
export async function listAnnotations(tradeId: string): Promise<TradeAnnotation[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("trade_annotations")
    .select("*")
    .eq("trade_id", tradeId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  return (data as AnnotationRow[])
    .map(toAnnotation)
    .filter((a): a is TradeAnnotation => a !== null);
}

/** 북 안의 모든 차트 메모 — 거래 id로 묶어 돌려준다(목록에서 거래마다 다시 묻지 않도록). */
export async function listAnnotationsByTrade(
  bookId: string,
): Promise<Record<string, TradeAnnotation[]>> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("trade_annotations")
    .select("*, trades!inner(book_id)")
    .eq("trades.book_id", bookId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const grouped: Record<string, TradeAnnotation[]> = {};
  for (const row of data as AnnotationRow[]) {
    const annotation = toAnnotation(row);
    if (annotation === null) continue;
    (grouped[annotation.trade_id] ??= []).push(annotation);
  }
  return grouped;
}

/** 북에 잡힌 입금·출금·이체 — 오래된 것부터. 자금 곡선이 시간순으로 이어 붙인다. */
export async function listCashFlows(bookId: string): Promise<CashFlow[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("cash_flows")
    .select("*")
    .eq("book_id", bookId)
    .order("at", { ascending: true });
  if (error) throw new Error(error.message);
  return data as CashFlow[];
}

/**
 * 거래소에서 마지막으로 읽어 온 계좌 잔고.
 *
 * 계산 자금과 대조하는 데 쓴다 — 둘이 벌어지면 어딘가 놓친 거래나 입출금이 있다.
 */
export async function getLatestBalance(bookId: string): Promise<BalanceSnapshot | null> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("balance_snapshots")
    .select("*")
    .eq("book_id", bookId)
    .order("at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return (data[0] as BalanceSnapshot | undefined) ?? null;
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

/**
 * 북의 매매 원칙 — 묶음·순서대로.
 *
 * `activeOnly`는 거래 화면용이다. 접어 둔 원칙까지 체크 목록에 내밀면 지금 지키지도
 * 않는 규칙을 매번 판단하게 된다. 원칙 탭은 접힌 것도 보여야 하므로 전부 받는다.
 */
export async function listPrinciples(
  bookId: string,
  activeOnly = false,
): Promise<Principle[]> {
  const { supabase } = await requireUser();
  let query = supabase.from("principles").select("*").eq("book_id", bookId);
  if (activeOnly) query = query.eq("active", true);

  const { data, error } = await query
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data as Principle[];
}

/** 거래 1건에 남은 원칙 판단. */
export async function listPrincipleChecks(tradeId: string): Promise<TradePrincipleCheck[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("trade_principle_checks")
    .select("*")
    .eq("trade_id", tradeId);
  if (error) throw new Error(error.message);
  return data as TradePrincipleCheck[];
}

/**
 * 북 전체의 원칙 판단 — 복기에서 "어떤 원칙을 어겼을 때 얼마를 잃었나"를 집계한다.
 *
 * 원칙을 거쳐 북을 좁힌다. 거래로 좁히면 거래 목록을 먼저 받아 id를 넘겨야 하는데,
 * 그 목록이 길어지면 쿼리스트링이 통째로 커진다.
 */
export async function listPrincipleChecksByBook(
  bookId: string,
): Promise<TradePrincipleCheck[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("trade_principle_checks")
    .select("*, principles!inner(book_id)")
    .eq("principles.book_id", bookId);
  if (error) throw new Error(error.message);

  return (data as (TradePrincipleCheck & { principles?: unknown })[]).map((row) => {
    // 조인용으로 딸려 온 `principles` 키는 버리고 판단 행만 남긴다.
    const check = { ...row };
    delete check.principles;
    return check as TradePrincipleCheck;
  });
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
