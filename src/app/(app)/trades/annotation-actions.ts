"use server";

import {
  isAnnotationColor,
  isAnnotationKind,
  isAnnotationLineStyle,
  normalizePoints,
  parsePoints,
} from "@/lib/annotations";
import { isPositionKind, type TradeAnnotation } from "@/lib/domain";
import { positionProblemOf } from "@/lib/position-tool";
import { requireUser } from "@/lib/queries";

export interface AnnotationResult {
  error?: string;
}

export interface CreateResult extends AnnotationResult {
  /** 방금 만든 메모의 id — 되돌리기가 이걸로 되짚는다 */
  id?: string;
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
}): Promise<CreateResult> {
  const { tradeId, kind, color } = input;
  if (!tradeId) return { error: "거래를 찾을 수 없습니다." };
  if (!isAnnotationKind(kind)) return { error: "알 수 없는 메모 종류입니다." };
  if (!isAnnotationColor(color)) return { error: "알 수 없는 색입니다." };

  const points = parsePoints(input.points, kind);
  if (points === null) return { error: "차트 좌표를 읽지 못했습니다. 다시 그려 주세요." };

  const text = parseText(input.text);
  if (kind === "text" && text === null) return { error: "메모 내용을 입력해 주세요." };

  // 손익 툴은 배치가 방향과 맞아야 한다 — 뒤집힌 채로 저장되면 손익비가 거짓말을 한다.
  if (isPositionKind(kind)) {
    const problem = positionProblemOf(kind, points);
    if (problem !== null) return { error: problem };
  }

  const { supabase, user } = await requireUser();
  // jsonb 칸은 인덱스 시그니처가 있는 타입만 받는다 — 이름 붙은 인터페이스는 못 넣는다.
  const stored = normalizePoints(kind, points).map((point) => ({ t: point.t, p: point.p }));

  const { data, error } = await supabase
    .from("trade_annotations")
    .insert({
      trade_id: tradeId,
      user_id: user.id,
      kind,
      points: stored,
      text,
      color,
    })
    .select("id")
    .single();

  if (error) return { error: error.message };

  return { id: data.id };
}

/**
 * 지웠던 메모를 되살린다 — 되돌리기 전용.
 *
 * **id를 그대로 넣는다.** 새 id로 만들면 그 메모를 가리키던 다른 되돌리기 기록(옮김·
 * 라벨 고침)이 통째로 허공을 짚는다. 지워진 뒤라 id가 비어 있으니 되쓸 수 있다.
 */
export async function restoreAnnotation(
  annotation: TradeAnnotation,
): Promise<AnnotationResult> {
  const { id, trade_id: tradeId, kind, points, text, color, locked } = annotation;
  if (!id || !tradeId) return { error: "되살릴 메모를 읽지 못했습니다." };
  if (parsePoints(points, kind) === null) return { error: "좌표를 읽지 못했습니다." };

  const { supabase, user } = await requireUser();
  const { error } = await supabase.from("trade_annotations").insert({
    id,
    trade_id: tradeId,
    user_id: user.id,
    kind,
    points: points.map((point) => ({ t: point.t, p: point.p })),
    text,
    color,
    locked,
  });

  if (error) return { error: error.message };

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

  return {};
}

/**
 * 끌어서 옮긴 자리를 저장한다.
 *
 * 종류는 클라이언트가 보낸 값을 믿지 않고 DB에서 다시 읽는다 — 점의 수와 배치 규칙이
 * 종류마다 다른데, 그 값이 바뀌어 들어오면 다른 종류의 검증을 통과해 버린다.
 */
export async function updateAnnotationPoints(
  id: string,
  points: unknown,
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

  const { kind } = found;
  const parsed = parsePoints(points, kind);
  if (parsed === null) return { error: "옮긴 자리를 읽지 못했습니다." };

  if (isPositionKind(kind)) {
    const problem = positionProblemOf(kind, parsed);
    if (problem !== null) return { error: problem };
  }

  const stored = normalizePoints(kind, parsed).map((point) => ({ t: point.t, p: point.p }));
  const { error } = await supabase
    .from("trade_annotations")
    .update({ points: stored })
    .eq("id", id);
  if (error) return { error: error.message };

  return {};
}

/**
 * 색·굵기·선 종류를 고친다 — 4분할 차트와 같은 스타일 편집을 복기 차트에도 얹는다.
 *
 * 넘어온 항목만 고친다. 굵기·선 종류는 null을 받아 "화면 기본값으로 되돌리기"도 된다.
 */
export async function updateAnnotationStyle(
  id: string,
  style: { color?: string; lineWidth?: number | null; lineStyle?: string | null },
): Promise<AnnotationResult> {
  if (!id) return { error: "메모를 찾을 수 없습니다." };

  const patch: { color?: string; line_width?: number | null; line_style?: string | null } = {};
  if (style.color !== undefined) {
    if (!isAnnotationColor(style.color)) return { error: "알 수 없는 색입니다." };
    patch.color = style.color;
  }
  if (style.lineWidth !== undefined) {
    if (
      style.lineWidth !== null &&
      (!Number.isInteger(style.lineWidth) || style.lineWidth < 1 || style.lineWidth > 4)
    ) {
      return { error: "선 굵기는 1~4px 입니다." };
    }
    patch.line_width = style.lineWidth;
  }
  if (style.lineStyle !== undefined) {
    if (style.lineStyle !== null && !isAnnotationLineStyle(style.lineStyle)) {
      return { error: "알 수 없는 선 종류입니다." };
    }
    patch.line_style = style.lineStyle;
  }
  if (Object.keys(patch).length === 0) return {};

  const { supabase } = await requireUser();
  const { error } = await supabase.from("trade_annotations").update(patch).eq("id", id);
  if (error) return { error: error.message };

  return {};
}

/**
 * 잠그거나 푼다.
 *
 * 잠긴 메모는 차트에서 집히지 않아 그 위에서도 밀기·확대가 그대로 된다. 자리를 다 잡은
 * 뒤 차트를 만지다 밀리는 걸 막는 게 전부라, 지우거나 라벨을 고치는 건 그대로 된다.
 */
export async function setAnnotationLocked(
  id: string,
  locked: boolean,
): Promise<AnnotationResult> {
  if (!id) return { error: "메모를 찾을 수 없습니다." };

  const { supabase } = await requireUser();
  const { error } = await supabase.from("trade_annotations").update({ locked }).eq("id", id);
  if (error) return { error: error.message };

  return {};
}

export async function deleteAnnotation(id: string): Promise<AnnotationResult> {
  if (!id) return { error: "메모를 찾을 수 없습니다." };

  const { supabase } = await requireUser();
  const { error } = await supabase.from("trade_annotations").delete().eq("id", id);
  if (error) return { error: error.message };

  return {};
}
