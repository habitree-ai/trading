import { cookies } from "next/headers";
import { cache } from "react";

import { toAnnotation, type AnnotationRow } from "@/lib/annotations";
import { isAllowedEmail } from "@/lib/auth/allowlist";
import type {
  BalanceSnapshot,
  Book,
  CashFlow,
  ExchangeAccount,
  Goal,
  Principle,
  ResearchHeadline,
  ResearchNote,
  ResearchSnapshot,
  SyncRun,
  Trade,
  TradeAnnotation,
  TradeFill,
  TradePrincipleCheck,
} from "@/lib/domain";
import { createClient } from "@/lib/supabase/server";

/** 어떤 북을 보고 있는지는 쿠키로 기억한다 — URL을 오염시키지 않기 위해. */
export const ACTIVE_BOOK_COOKIE = "active_book";

/**
 * 로그인한 사용자 — 요청 한 번에 한 번만 확인한다.
 *
 * `auth.getUser()` 는 토큰을 Supabase 인증 서버에 물어보는 **네트워크 호출**이다.
 * 화면 하나가 표를 예닐곱 개 읽으면 그만큼 왕복이 쌓여, 실제로 대시보드 한 장에
 * 아홉 번까지 나갔다. React `cache` 로 묶어 렌더 한 번에 한 번으로 줄인다.
 * 요청 사이에는 공유되지 않으므로 세션이 끊긴 다음 요청은 그대로 막힌다.
 */
export const requireUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("인증이 필요합니다.");
  // 미들웨어가 이미 막지만 여기서도 확인한다 — 서버 액션은 미들웨어를 거치지 않는
  // 경로로도 불릴 수 있고, 데이터에 닿기 직전이 마지막 방어선이다.
  if (!isAllowedEmail(user.email)) throw new Error("이 앱을 쓸 수 있는 계정이 아닙니다.");
  return { supabase, user };
});

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

/** 이 북에서 전에 적었던 기준·근거·감정·복기 — 폼이 골라 넣을 선택지. */
export interface FieldSuggestions {
  setup: string[];
  rationale: string[];
  emotion: string[];
  review: string[];
}

/**
 * 자주 쓴 순, 같으면 최근 순.
 *
 * 따로 저장하는 표가 없다. 거래에 적어 저장하는 순간 다음 거래의 선택지가 된다 — 그래서
 * "자동 저장"이고, 지우고 싶으면 그 값을 쓴 거래를 고치면 된다. 복기 분석(review/page.tsx)이
 * 같은 문자열을 묶어 세므로, 새로 타이핑하는 대신 골라 넣는 편이 통계에도 좋다.
 */
export async function listFieldSuggestions(bookId: string): Promise<FieldSuggestions> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("trades")
    .select("setup, rationale, emotion, review")
    .eq("book_id", bookId)
    .order("updated_at", { ascending: false })
    .limit(300);
  if (error) throw new Error(error.message);

  const rank = (key: keyof FieldSuggestions): string[] => {
    const seen = new Map<string, { count: number; first: number }>();
    data.forEach((row, i) => {
      const value = (row[key] ?? "").trim();
      if (!value) return;
      const entry = seen.get(value);
      if (entry) entry.count += 1;
      else seen.set(value, { count: 1, first: i });
    });
    return [...seen.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
      .map(([value]) => value)
      .slice(0, 30);
  };

  return {
    setup: rank("setup"),
    rationale: rank("rationale"),
    emotion: rank("emotion"),
    review: rank("review"),
  };
}

/**
 * 여러 거래의 체결을 한 번에 — 거래 id 로 묶어 돌려준다.
 *
 * 목록·대시보드가 **들고 있는 거래**의 체결만 읽는 용도다. 부분청산이 얼마나 됐는지는
 * 체결에만 있어서, 이게 없으면 살아 있는 거래의 청산 단계가 청산가 한 점으로 뭉개진다.
 * 북 전량을 싣지 않는 결정(c68dc4b)은 그대로다 — 열린 거래는 손에 꼽는다.
 */
export async function listFillsByTrade(
  tradeIds: readonly string[],
): Promise<Record<string, TradeFill[]>> {
  if (tradeIds.length === 0) return {};
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("trade_fills")
    .select("*")
    .in("trade_id", [...tradeIds])
    .order("filled_at", { ascending: true });
  if (error) throw new Error(error.message);
  const out: Record<string, TradeFill[]> = {};
  for (const fill of data) (out[fill.trade_id] ??= []).push(fill);
  return out;
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
 * 북의 잔액 스냅샷 전부 — 시각순.
 *
 * 자금 곡선이 거래소 잔액 선을 그리는 데 쓴다. 시작일 전 것은 정의가 달라 여기서
 * 거르지 않고 곡선 쪽(`dailySnapshots`)이 한국 시간 날짜로 거른다.
 */
export async function listBalanceSnapshots(bookId: string): Promise<BalanceSnapshot[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("balance_snapshots")
    .select("*")
    .eq("book_id", bookId)
    .order("at", { ascending: true });
  if (error) throw new Error(error.message);
  return data as BalanceSnapshot[];
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
 * 목표를 한꺼번에 저장한다 — 표의 `unique (book_id, tier, period, metric)` 이 키라
 * 같은 칸은 덮어쓰고 없는 칸은 만든다. 계획 β/목표 α 는 늘 묶음으로 바뀐다.
 */
export async function upsertGoals(
  bookId: string,
  rows: readonly Pick<Goal, "tier" | "period" | "metric" | "target_value">[],
): Promise<void> {
  const { supabase, user } = await requireUser();
  const { error } = await supabase
    .from("goals")
    .upsert(
      rows.map((r) => ({ ...r, book_id: bookId, user_id: user.id })),
      { onConflict: "book_id,tier,period,metric" },
    );
  if (error) throw new Error(error.message);
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

/** DB의 jsonb 컬럼을 도메인 모양으로 되돌린다 — 쓰는 쪽이 collect뿐이라 형태를 신뢰한다. */
type ResearchSnapshotRow = Omit<ResearchSnapshot, "headlines" | "sources"> & {
  headlines: unknown;
  sources: unknown;
};

function toSnapshot(row: ResearchSnapshotRow): ResearchSnapshot {
  return {
    ...row,
    headlines: Array.isArray(row.headlines) ? (row.headlines as ResearchHeadline[]) : [],
    sources:
      typeof row.sources === "object" && row.sources !== null
        ? (row.sources as Record<string, string>)
        : {},
  };
}

/** 심볼의 최신 스냅샷 — 리서치 화면의 KPI가 이 한 장을 읽는다. */
export async function getLatestSnapshot(symbol: string): Promise<ResearchSnapshot | null> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("research_snapshots")
    .select("*")
    .eq("symbol", symbol)
    .order("collected_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);

  const row = data[0] as ResearchSnapshotRow | undefined;
  return row ? toSnapshot(row) : null;
}

/** 심볼의 스냅샷 이력 — 최신순. 추이를 훑는 용도라 최근 것만 받는다. */
export async function listSnapshots(symbol: string, limit = 30): Promise<ResearchSnapshot[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("research_snapshots")
    .select("*")
    .eq("symbol", symbol)
    .order("collected_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data as ResearchSnapshotRow[]).map(toSnapshot);
}

/** 심볼의 리서치 노트 — 중요한 것부터. 묶음 나누기는 화면이 한다. */
export async function listResearchNotes(symbol: string): Promise<ResearchNote[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("research_notes")
    .select("*")
    .eq("symbol", symbol)
    .order("importance", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data as ResearchNote[];
}

/** 리서치가 있는 심볼들 — 심볼 전환 칩이 쓴다. 아무것도 없어도 BTC는 보인다. */
export async function listResearchSymbols(): Promise<string[]> {
  const { supabase } = await requireUser();
  const [snaps, notes] = await Promise.all([
    supabase.from("research_snapshots").select("symbol"),
    supabase.from("research_notes").select("symbol"),
  ]);
  if (snaps.error) throw new Error(snaps.error.message);
  if (notes.error) throw new Error(notes.error.message);

  const symbols = new Set<string>(["BTC"]);
  for (const row of [...snaps.data, ...notes.data]) symbols.add(row.symbol);
  return [...symbols].sort();
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
