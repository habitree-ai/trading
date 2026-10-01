"use server";

import { revalidatePath } from "next/cache";

import { flatState } from "@/lib/flat";
import { getActiveBook, getLatestFlat, listTrades, requireUser } from "@/lib/queries";

export interface FlatStartState {
  error?: string;
}

/**
 * 무포지션 시작 — 중립 기어를 넣는다. 누른 시각만 남기고, 끝은 거래가 정한다(`lib/flat`).
 *
 * 화면이 버튼을 감추는 것을 믿지 않고 여기서 상태를 다시 본다. 포지션을 든 채로는 시작할 수 없고,
 * 이미 들고 있는 무포지션 위에 또 시작하지 않는다 — 다시 누르면 쌓인 유지 시간이 0 으로 돌아간다.
 */
export async function startFlat(): Promise<FlatStartState> {
  const { supabase, user } = await requireUser();

  const book = await getActiveBook();
  if (!book) return { error: "북을 먼저 만들어 주세요." };

  const [trades, latest] = await Promise.all([listTrades(book.id), getLatestFlat(book.id)]);
  const state = flatState(latest, trades);
  if (state.kind === "holding") {
    return { error: "포지션을 들고 있습니다 — 무포지션은 청산 뒤에 시작합니다." };
  }
  if (state.kind === "flat") return { error: "이미 무포지션을 들고 있습니다." };

  // 시각은 DB 가 찍는다(`default now()`) — 브라우저 시계를 받지 않는다.
  const { error } = await supabase.from("flat_sessions").insert({ book_id: book.id, user_id: user.id });
  if (error) return { error: error.message };

  revalidatePath("/flat");
  return {};
}
