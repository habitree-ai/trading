"use server";

import { revalidatePath } from "next/cache";

import {
  isAnnotationColor,
  isAnnotationKind,
  normalizePoints,
  parsePoints,
} from "@/lib/annotations";
import { requireUser } from "@/lib/queries";

export interface AnnotationResult {
  error?: string;
}

/** 라벨은 없어도 된다(도형 자체가 메모다) — 빈 문자열은 null로 눕힌다. */
function parseText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 차트 메모를 남긴다.
 *
 * 종류·색·좌표는 화면이 보낸 값을 그대로 믿지 않고 여기서 다시 본다. 서버 액션은
 * 폼을 거치지 않고도 불릴 수 있고, DB의 check 제약에 걸리면 사용자에게는 뜻을 알 수
 * 없는 Postgres 메시지만 남는다.
 */
export async function createAnnotation(input: {
  tradeId: string;
  kind: string;
  points: unknown;
  text: string | null;
  color: string;
}): Promise<AnnotationResult> {
  const { tradeId, kind, color } = input;
  if (!tradeId) return { error: "거래를 찾을 수 없습니다." };
  if (!isAnnotationKind(kind)) return { error: "알 수 없는 메모 종류입니다." };
  if (!isAnnotationColor(color)) return { error: "알 수 없는 색입니다." };

  const points = parsePoints(input.points, kind);
  if (points === null) return { error: "차트 좌표를 읽지 못했습니다. 다시 그려 주세요." };

  const text = parseText(input.text);
  if (kind === "text" && text === null) return { error: "메모 내용을 입력해 주세요." };

  const { supabase, user } = await requireUser();
  // jsonb 칸은 인덱스 시그니처가 있는 타입만 받는다 — 이름 붙은 인터페이스는 못 넣는다.
  const stored = normalizePoints(points).map((point) => ({ t: point.t, p: point.p }));

  const { error } = await supabase.from("trade_annotations").insert({
    trade_id: tradeId,
    user_id: user.id,
    kind,
    points: stored,
    text,
    color,
  });

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return {};
}

/** 라벨만 고친다 — 자리를 옮기려면 지우고 다시 그리는 편이 헷갈리지 않는다. */
export async function updateAnnotationText(
  id: string,
  text: string,
): Promise<AnnotationResult> {
  if (!id) return { error: "메모를 찾을 수 없습니다." };

  const { supabase } = await requireUser();
  const { data: found, error: findError } = await supabase
    .from("trade_annotations")
    .select("kind")
    .eq("id", id)
    .maybeSingle();
  if (findError) return { error: findError.message };
  if (!found) return { error: "메모를 찾을 수 없습니다." };

  const next = parseText(text);
  if (found.kind === "text" && next === null) return { error: "메모 내용을 입력해 주세요." };

  const { error } = await supabase
    .from("trade_annotations")
    .update({ text: next })
    .eq("id", id);
  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return {};
}

export async function deleteAnnotation(id: string): Promise<AnnotationResult> {
  if (!id) return { error: "메모를 찾을 수 없습니다." };

  const { supabase } = await requireUser();
  const { error } = await supabase.from("trade_annotations").delete().eq("id", id);
  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return {};
}
