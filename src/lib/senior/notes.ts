/**
 * 노트 읽기 — 공개 select 정책이 있어 세션 없이도 일반 서버 클라이언트로 읽힌다.
 * 쓰기는 `src/app/blog/actions.ts` 에 있고 관리자 관문을 거친다.
 */
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

export type SeniorNote = Database["public"]["Tables"]["senior_notes"]["Row"];
export type SeniorNoteStatus = Database["public"]["Enums"]["senior_note_status"];

/** 최근에 고친 순 — 목록은 "내가 마지막으로 만진 것"이 위에 있어야 이어서 쓸 수 있다. */
export async function listSeniorNotes(): Promise<SeniorNote[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("senior_notes")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 없거나 id 꼴이 아니면 null — 주소를 손으로 바꿔 넣어도 500 이 아니라 404 가 되게. */
export async function getSeniorNote(id: string): Promise<SeniorNote | null> {
  if (!UUID.test(id)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.from("senior_notes").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}
