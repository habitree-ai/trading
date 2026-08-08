"use server";

import { revalidatePath } from "next/cache";

import type { PrincipleCategory } from "@/lib/domain";
import { PRINCIPLE_CATEGORIES } from "@/lib/domain";
import { requireUser } from "@/lib/queries";

export interface PrincipleFormState {
  error?: string;
  message?: string;
}

function parseCategory(value: FormDataEntryValue | null): PrincipleCategory {
  const raw = String(value ?? "");
  return (PRINCIPLE_CATEGORIES as string[]).includes(raw)
    ? (raw as PrincipleCategory)
    : "risk";
}

function parseDetail(value: FormDataEntryValue | null): string | null {
  const raw = String(value ?? "").trim();
  return raw === "" ? null : raw;
}

/**
 * 원칙을 새로 적는다.
 *
 * 순서는 같은 묶음의 맨 아래로 붙인다 — 새로 떠올린 규칙이 이미 지키던 것들을
 * 밀어내고 위로 오면, 목록의 위아래가 중요도를 뜻한다는 약속이 깨진다.
 */
export async function createPrinciple(
  _prev: PrincipleFormState,
  formData: FormData,
): Promise<PrincipleFormState> {
  const bookId = String(formData.get("book_id") ?? "");
  if (!bookId) return { error: "북을 먼저 만들어 주세요." };

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { error: "원칙 내용을 입력해 주세요." };

  const { supabase, user } = await requireUser();
  const category = parseCategory(formData.get("category"));

  const { data: last } = await supabase
    .from("principles")
    .select("sort_order")
    .eq("book_id", bookId)
    .eq("category", category)
    .order("sort_order", { ascending: false })
    .limit(1);

  const { error } = await supabase.from("principles").insert({
    book_id: bookId,
    user_id: user.id,
    category,
    title,
    detail: parseDetail(formData.get("detail")),
    sort_order: (last?.[0]?.sort_order ?? 0) + 1,
  });

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { message: "원칙을 추가했습니다." };
}

export async function updatePrinciple(
  _prev: PrincipleFormState,
  formData: FormData,
): Promise<PrincipleFormState> {
  const id = String(formData.get("principle_id") ?? "");
  if (!id) return { error: "원칙을 찾을 수 없습니다." };

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { error: "원칙 내용을 입력해 주세요." };

  const { supabase } = await requireUser();
  const { error } = await supabase
    .from("principles")
    .update({
      category: parseCategory(formData.get("category")),
      title,
      detail: parseDetail(formData.get("detail")),
    })
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { message: "고쳤습니다." };
}

/** 접거나 다시 편다 — 지우는 것과 다르다. 과거 거래에 남은 판단은 그대로 있다. */
export async function setPrincipleActive(id: string, active: boolean) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("principles").update({ active }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
}

export async function deletePrinciple(id: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("principles").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
}

/**
 * 같은 묶음 안에서 한 칸 옮긴다.
 *
 * 이웃과 `sort_order`만 맞바꾸면 값이 겹쳐 있을 때(전부 0인 초기 상태) 아무 일도
 * 일어나지 않는다. 그래서 옮긴 결과 순서대로 묶음 전체에 번호를 다시 매긴다.
 */
export async function movePrinciple(id: string, direction: "up" | "down") {
  const { supabase } = await requireUser();

  const { data: target, error: findError } = await supabase
    .from("principles")
    .select("book_id, category")
    .eq("id", id)
    .single();
  if (findError) throw new Error(findError.message);

  const { data: siblings, error } = await supabase
    .from("principles")
    .select("id")
    .eq("book_id", target.book_id)
    .eq("category", target.category)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const ids = (siblings ?? []).map((p) => p.id);
  const from = ids.indexOf(id);
  const to = direction === "up" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= ids.length) return;

  [ids[from], ids[to]] = [ids[to], ids[from]];

  await Promise.all(
    ids.map((pid, index) =>
      supabase.from("principles").update({ sort_order: index }).eq("id", pid),
    ),
  );

  revalidatePath("/", "layout");
}

/**
 * 거래 하나에 대해 원칙을 지켰는지 남긴다.
 *
 * `kept`가 null이면 판단을 지운다 — '어겼음'과 '아직 안 봄'은 다른 상태이고,
 * 잘못 누른 것을 되돌릴 자리가 없으면 위반 통계가 그대로 굳는다.
 */
export async function setPrincipleCheck(
  tradeId: string,
  principleId: string,
  kept: boolean | null,
) {
  const { supabase, user } = await requireUser();

  if (kept === null) {
    const { error } = await supabase
      .from("trade_principle_checks")
      .delete()
      .eq("trade_id", tradeId)
      .eq("principle_id", principleId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase
      .from("trade_principle_checks")
      .upsert(
        { trade_id: tradeId, principle_id: principleId, user_id: user.id, kept },
        { onConflict: "trade_id,principle_id" },
      );
    if (error) throw new Error(error.message);
  }

  revalidatePath("/", "layout");
}
