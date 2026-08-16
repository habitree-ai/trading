"use server";

import { revalidatePath } from "next/cache";

import { switchBook } from "@/app/(app)/books/actions";
import { requireUser, nextSeq } from "@/lib/queries";
import { SYSTEM_BOOK_NAME, readSystemState, readSystemTrades } from "@/lib/system-trading";

const EXIT_LABEL: Record<string, string> = {
  tp: "목표",
  sl: "손절",
  time: "시간",
  unknown: "미상",
  algo: "브래킷",
};

export interface SystemSyncState {
  error?: string;
  message?: string;
}

/**
 * 봇의 완결 거래를 시스템 북으로 가져온다.
 *
 * 진실 원천은 `system-trading/data/` 파일이고, 여기서는 아직 없는 거래만 붙인다 —
 * 중복 판정은 note 에 심은 `[sys:거래ID]` 표식으로 한다. 북이 없으면 만들고,
 * 처음 만든 그 순간에만 활성 북을 그쪽으로 돌린다(이후 동기화는 보던 북을 존중).
 */
export async function syncSystemBook(): Promise<SystemSyncState> {
  const { supabase, user } = await requireUser();

  const state = readSystemState("paper");
  if (!state) return { error: "봇 데이터가 없습니다 — 페이퍼 루프가 한 번은 돌아야 합니다." };
  const closed = readSystemTrades("paper").sort((a, b) => a.exitTs - b.exitTs || a.entryTs - b.entryTs);

  // 1) 북 확보.
  const { data: found, error: findError } = await supabase
    .from("books")
    .select("id")
    .eq("name", SYSTEM_BOOK_NAME)
    .maybeSingle();
  if (findError) return { error: findError.message };

  let bookId = found?.id ?? null;
  if (!bookId) {
    const startDate = new Date(state.createdAt + 9 * 3600_000).toISOString().slice(0, 10);
    const { data: created, error: createError } = await supabase
      .from("books")
      .insert({
        user_id: user.id,
        name: SYSTEM_BOOK_NAME,
        exchange: "OKX·시스템",
        base_currency: "USDT",
        initial_capital: 100,
        start_date: startDate,
        memo: "쿼드 공격형 자동매매 — system-trading/data 가 진실 원천, 이 북은 가져온 사본",
      })
      .select("id")
      .single();
    if (createError) return { error: createError.message };
    bookId = created.id;
    await switchBook(bookId);
  }

  if (closed.length === 0) {
    revalidatePath("/", "layout");
    return { message: "북은 준비됐습니다 — 아직 완결 거래가 없습니다(신호 대기 중)." };
  }

  // 2) 이미 가져온 거래 걸러내기 — note 의 [sys:거래ID] 표식.
  const { data: existing, error: noteError } = await supabase
    .from("trades")
    .select("note")
    .eq("book_id", bookId)
    .not("note", "is", null);
  if (noteError) return { error: noteError.message };
  const imported = new Set(
    (existing ?? [])
      .map((r) => /\[sys:([^\]]+)\]/.exec(r.note ?? "")?.[1])
      .filter((v): v is string => Boolean(v)),
  );

  const fresh = closed.filter((t) => !imported.has(t.tradeId));
  if (fresh.length === 0) {
    revalidatePath("/", "layout");
    return { message: `새 거래 없음 — 이미 ${imported.size}건이 들어와 있습니다.` };
  }

  // 3) 붙이기 — 잔고 체계는 봇 회계 그대로: 손익은 진입 시점 잔고 기준.
  let seq = await nextSeq(bookId);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  for (const t of fresh) {
    const eqAtEntry = t.eqAtEntry ?? null;
    const pnlUsd = t.pnlUsd ?? (eqAtEntry !== null ? r2((eqAtEntry * t.netPct) / 100) : null);
    // 왕복 0.1% × 레버리지가 순손익에 이미 빠져 있다 — 앱의 비용 칸에 맞춰 되살린다.
    const feeUsd = eqAtEntry !== null ? r2((eqAtEntry * 0.1 * t.lev) / 100) : null;
    const { error } = await supabase.from("trades").insert({
      book_id: bookId,
      user_id: user.id,
      seq,
      side: t.side,
      symbol: "BTC",
      entry_at: new Date(t.entryTs).toISOString(),
      exit_at: new Date(t.exitTs).toISOString(),
      result: pnlUsd === null || pnlUsd === 0 ? "be" : pnlUsd > 0 ? "win" : "loss",
      equity_before: eqAtEntry,
      equity_after: t.equityAfter ?? null,
      pnl: pnlUsd !== null && feeUsd !== null ? r2(pnlUsd + feeUsd) : null,
      fee: feeUsd !== null ? -feeUsd : null,
      realized_pnl: pnlUsd,
      entry_price: t.entryPrice,
      exit_price: t.exitPrice,
      notional: eqAtEntry !== null ? r2(eqAtEntry * t.lev) : null,
      leverage: r2(t.lev),
      margin_mode: "isolated" as const,
      setup: t.name,
      note: `[sys:${t.tradeId}] ${EXIT_LABEL[t.exitType] ?? t.exitType} 청산 · 자동 기록`,
    });
    if (error) return { error: `${seq}번째 거래에서 실패: ${error.message}` };
    seq += 1;
  }

  revalidatePath("/", "layout");
  return { message: `${fresh.length}건 가져옴 — 시스템 북 누적 ${imported.size + fresh.length}건.` };
}
