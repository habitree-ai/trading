"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { ACTIVE_BOOK_COOKIE, requireUser } from "@/lib/queries";

export interface BookFormState {
  error?: string;
  message?: string;
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

/**
 * 초기 세팅 보정 — 초기자금과 시작일을 고친다.
 *
 * 화면의 `현재자금`은 `초기자금 + 실현손익 + 순이체 − 출금`이다. 초기자금을 "이체가
 * 끝난 뒤의 잔고"로 잡아 두면 그 이체가 동기화로 한 번 더 들어와 자금이 두 배로 뛴다.
 * 초기자금은 **시작일 0시의 거래계좌 잔액**이어야 하고, 그 뒤의 흐름은 동기화가 더한다.
 *
 * 시작일을 함께 두는 이유: 동기화가 훑는 구간의 시작점이라 초기자금이 가리키는
 * 시점 자체를 정한다. 둘을 따로 고치면 그 사이가 어긋난다.
 */
export async function calibrateBook(
  _prev: BookFormState,
  formData: FormData,
): Promise<BookFormState> {
  const bookId = String(formData.get("book_id") ?? "");
  if (!bookId) return { error: "북을 찾을 수 없습니다." };

  const initialCapital = parseNumber(formData.get("initial_capital"));
  if (initialCapital === null || initialCapital < 0) {
    return { error: "초기자금은 0 이상의 숫자여야 합니다." };
  }

  const startDate = String(formData.get("start_date") ?? "").trim();
  if (startDate !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return { error: "시작일 형식이 올바르지 않습니다." };
  }

  const { supabase } = await requireUser();
  const { error } = await supabase
    .from("books")
    .update({ initial_capital: initialCapital, ...(startDate ? { start_date: startDate } : {}) })
    .eq("id", bookId);

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { message: `초기자금을 ${initialCapital}로 맞췄습니다.` };
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
