"use server";

import { revalidatePath } from "next/cache";

import { parseNotesUpdate } from "@/app/(app)/notes/fields";
import type { JournalFormState } from "@/app/(app)/trades/new/journal-actions";
import { requireUser } from "@/lib/queries";

const SECTION_LABEL: Record<string, string> = { basis: "근거", review: "복기" };

/**
 * 매매 노트의 카드 저장 — 근거 카드와 복기 카드가 각자 자기 칸만 고친다(`fields.ts`).
 *
 * 저장 경로가 거래 행이라 `/review` 통계·`/order` 근거 게이트·`/trades/[id]` 폼이 같은 값을 본다.
 */
export async function updateTradeNotes(
  _prev: JournalFormState,
  formData: FormData,
): Promise<JournalFormState> {
  const tradeId = String(formData.get("trade_id") ?? "");
  if (!tradeId) return { error: "거래를 찾을 수 없습니다." };
  const section = String(formData.get("section") ?? "");

  const { supabase, user } = await requireUser();
  const parsed = parseNotesUpdate(section, formData, user.id);
  if ("error" in parsed) return { error: parsed.error };

  const { data, error } = await supabase
    .from("trades")
    .update(parsed.update)
    .eq("id", tradeId)
    .select("seq, symbol")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "거래를 찾을 수 없습니다." };

  revalidatePath("/", "layout");
  return {
    savedAt: Date.now(),
    message: `#${data.seq} ${data.symbol} ${SECTION_LABEL[section]}을 저장했습니다.`,
  };
}
