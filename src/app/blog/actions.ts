"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireBlogAdmin } from "@/lib/senior/admin";
import type { SeniorNoteStatus } from "@/lib/senior/notes";

export interface SeniorNoteFormState {
  error?: string;
}

/** 글 번호는 네이버 URL 끝의 숫자다 — 그 꼴이 아니면 "글 미지정"으로 본다. */
function parsePostId(value: FormDataEntryValue | null): string | null {
  const raw = String(value ?? "").trim();
  return /^\d+$/.test(raw) ? raw : null;
}

function parseText(value: FormDataEntryValue | null): string {
  return String(value ?? "").trim();
}

function parseStatus(value: FormDataEntryValue | null): SeniorNoteStatus {
  return value === "done" ? "done" : "draft";
}

/** 폼 → 행. 대상 글은 연결 목록에서 뺀다 — 자기 자신을 연결하는 건 뜻이 없다. */
function parseNote(formData: FormData) {
  const post_id = parsePostId(formData.get("post_id"));
  const links = [
    ...new Set(formData.getAll("links").map(parsePostId).filter((id): id is string => id !== null)),
  ].filter((id) => id !== post_id);
  const tags = [
    ...new Set(
      String(formData.get("tags") ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== ""),
    ),
  ];
  return {
    post_id,
    quote: parseText(formData.get("quote")),
    think: parseText(formData.get("think")),
    apply: parseText(formData.get("apply")),
    differ: parseText(formData.get("differ")),
    ask: parseText(formData.get("ask")),
    links,
    tags,
    status: parseStatus(formData.get("status")),
  };
}

/** 관리자 관문 — 실패 사유를 화면에 돌려줄 수 있게 메시지로 바꾼다. */
async function admin(): Promise<
  { ok: true; value: Awaited<ReturnType<typeof requireBlogAdmin>> } | { ok: false; error: string }
> {
  try {
    return { ok: true, value: await requireBlogAdmin() };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "관리자만 고칠 수 있습니다." };
  }
}

export async function createSeniorNote(
  _prev: SeniorNoteFormState,
  formData: FormData,
): Promise<SeniorNoteFormState> {
  const gate = await admin();
  if (!gate.ok) return { error: gate.error };
  const { supabase, user } = gate.value;

  const { data, error } = await supabase
    .from("senior_notes")
    .insert({ ...parseNote(formData), user_id: user.id })
    .select("id")
    .single();
  if (error) return { error: error.message };

  revalidatePath("/blog", "layout");
  redirect(`/blog/notes/${data.id}`);
}

export async function updateSeniorNote(
  _prev: SeniorNoteFormState,
  formData: FormData,
): Promise<SeniorNoteFormState> {
  const id = String(formData.get("note_id") ?? "");
  if (!id) return { error: "노트를 찾을 수 없습니다." };

  const gate = await admin();
  if (!gate.ok) return { error: gate.error };

  const { error } = await gate.value.supabase.from("senior_notes").update(parseNote(formData)).eq("id", id);
  if (error) return { error: error.message };

  revalidatePath("/blog", "layout");
  redirect(`/blog/notes/${id}`);
}

export async function deleteSeniorNote(id: string): Promise<void> {
  const { supabase } = await requireBlogAdmin();
  const { error } = await supabase.from("senior_notes").delete().eq("id", id);
  if (error) throw new Error(error.message);

  revalidatePath("/blog", "layout");
  redirect("/blog");
}
