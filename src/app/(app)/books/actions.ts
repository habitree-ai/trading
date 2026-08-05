"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { ACTIVE_BOOK_COOKIE, requireUser } from "@/lib/queries";

export interface BookFormState {
  error?: string;
}

/** 쿠키에 활성 북을 기록한다 — 1년이면 사실상 영구. */
export async function switchBook(bookId: string) {
  (await cookies()).set(ACTIVE_BOOK_COOKIE, bookId, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  revalidatePath("/", "layout");
}

function parseNumber(value: FormDataEntryValue | null): number | null {
  const raw = String(value ?? "").trim().replace(/,/g, "");
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function createBook(
  _prev: BookFormState,
  formData: FormData,
): Promise<BookFormState> {
  const { supabase, user } = await requireUser();

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "북 이름을 입력해 주세요." };

  const initialCapital = parseNumber(formData.get("initial_capital"));
  if (initialCapital === null || initialCapital <= 0) {
    return { error: "초기자금은 0보다 큰 숫자여야 합니다." };
  }

  const startDate = String(formData.get("start_date") ?? "").trim();

  const { data, error } = await supabase
    .from("books")
    .insert({
      user_id: user.id,
      name,
      exchange: String(formData.get("exchange") ?? "").trim() || null,
      base_currency: String(formData.get("base_currency") ?? "USDT").trim() || "USDT",
      initial_capital: initialCapital,
      ...(startDate ? { start_date: startDate } : {}),
      memo: String(formData.get("memo") ?? "").trim() || null,
    })
    .select("id")
    .single();

  if (error) return { error: error.message };

  await switchBook(data.id);
  revalidatePath("/", "layout");
  return {};
}

export async function closeBook(bookId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("books").update({ status: "closed" }).eq("id", bookId);
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
}

export async function reopenBook(bookId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("books").update({ status: "active" }).eq("id", bookId);
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
}

export async function deleteBook(bookId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("books").delete().eq("id", bookId);
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
}
