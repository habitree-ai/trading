"use server";

import { revalidatePath } from "next/cache";

import {
  isAnnotationColor,
  isAnnotationKind,
  isAnnotationLineStyle,
  normalizePoints,
  parsePoints,
} from "@/lib/annotations";
import { isPositionKind, type AnnotationColor, type AnnotationKind, type AnnotationLineStyle, type ChartPoint } from "@/lib/domain";
import { positionProblemOf } from "@/lib/position-tool";
import { requireUser } from "@/lib/queries";

export interface JournalFormState {
  error?: string;
  /** 저장이 끝났다는 신호 — 값이 바뀔 때마다 폼이 비워진다 */
  savedAt?: number;
  message?: string;
}

function parseText(value: FormDataEntryValue | null): string | null {
  const raw = String(value ?? "").trim();
  return raw === "" ? null : raw;
}

/**
 * 포지션 기록 — 고른 거래에 근거·복기·감정을 적는다.
 *
 * 기록은 거래 행에 산다. 따로 표를 두면 복기 분석(감정·셋업별 성과)이 이쪽을 못 본다.
 * 숫자 칸은 건드리지 않는다 — 동기화가 채운 값이고, 이 화면은 판단을 적는 자리다.
 * 폼이 기존 값을 채워 보여 주므로 빈 칸으로 보낸 것은 지우겠다는 뜻이다.
 */
export async function savePositionRecord(
  _prev: JournalFormState,
  formData: FormData,
): Promise<JournalFormState> {
  const tradeId = String(formData.get("trade_id") ?? "");
  if (!tradeId) return { error: "포지션을 골라 주세요." };

  const rationale = parseText(formData.get("rationale"));
  const review = parseText(formData.get("review"));
  const emotion = parseText(formData.get("emotion"));
  if (rationale === null && review === null && emotion === null) {
    return { error: "근거·복기·감정 중 하나는 적어 주세요." };
  }

  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from("trades")
    .update({ rationale, review, emotion })
    .eq("id", tradeId)
    .select("seq, symbol")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "포지션을 찾을 수 없습니다." };

  revalidatePath("/", "layout");
  return { savedAt: Date.now(), message: `#${data.seq} ${data.symbol} 기록을 저장했습니다.` };
}

interface DraftAnnotation {
  kind: AnnotationKind;
  points: { t: number; p: number }[];
  text: string | null;
  color: AnnotationColor;
  locked: boolean;
  line_width: number | null;
  line_style: AnnotationLineStyle | null;
}

/**
 * 저장 전 차트에 그린 메모 — 폼이 JSON 으로 실어 보낸다.
 *
 * 클라이언트에서 온 값이라 `createAnnotation` 과 같은 기준으로 하나씩 다시 본다. 한 건이라도
 * 어긋나면 기록 전체를 거절한다 — 조용히 버리면 그린 사람은 저장된 줄 안다.
 */
function parseDraftAnnotations(
  raw: FormDataEntryValue | null,
): { items: DraftAnnotation[] } | { error: string } {
  const text = String(raw ?? "").trim();
  if (!text) return { items: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "차트 메모를 읽지 못했습니다." };
  }
  if (!Array.isArray(parsed)) return { error: "차트 메모를 읽지 못했습니다." };

  const items: DraftAnnotation[] = [];
  for (const [i, item] of parsed.entries()) {
    if (typeof item !== "object" || item === null) return { error: `차트 메모 ${i + 1}을 읽지 못했습니다.` };
    const a = item as Record<string, unknown>;

    if (!isAnnotationKind(a.kind)) return { error: `차트 메모 ${i + 1}의 종류를 알 수 없습니다.` };
    if (!isAnnotationColor(a.color)) return { error: `차트 메모 ${i + 1}의 색을 알 수 없습니다.` };
    const points: ChartPoint[] | null = parsePoints(a.points, a.kind);
    if (points === null) return { error: `차트 메모 ${i + 1}의 좌표를 읽지 못했습니다.` };

    const label = typeof a.text === "string" ? a.text.trim() : "";
    if (a.kind === "text" && label === "") return { error: `차트 메모 ${i + 1}의 내용이 비어 있습니다.` };

    if (isPositionKind(a.kind)) {
      const problem = positionProblemOf(a.kind, points);
      if (problem !== null) return { error: problem };
    }

    const width = a.line_width;
    if (width !== null && width !== undefined && (!Number.isInteger(width) || (width as number) < 1 || (width as number) > 4)) {
      return { error: "선 굵기는 1~4px 입니다." };
    }
    const style = a.line_style;
    if (style !== null && style !== undefined && !isAnnotationLineStyle(style)) {
      return { error: "알 수 없는 선 종류입니다." };
    }

    items.push({
      kind: a.kind,
      points: normalizePoints(a.kind, points).map((p) => ({ t: p.t, p: p.p })),
      text: label === "" ? null : label,
      color: a.color,
      locked: a.locked === true,
      line_width: typeof width === "number" ? width : null,
      line_style: isAnnotationLineStyle(style) ? style : null,
    });
  }
  return { items };
}

/**
 * 일반 기록 — 종목(선택)·내용·감정, 그리고 저장 전 차트에 그린 메모를 한 번에 저장한다.
 *
 * 메모 저장이 실패하면 기록은 이미 들어간 뒤다 — 그 사실을 숨기지 않고 그대로 알린다.
 * 지우고 다시 하면 되는 일이지, 절반만 된 것을 성공으로 보이게 할 일은 아니다.
 */
export async function createJournalNote(
  _prev: JournalFormState,
  formData: FormData,
): Promise<JournalFormState> {
  const bookId = String(formData.get("book_id") ?? "");
  if (!bookId) return { error: "북을 먼저 만들어 주세요." };

  const body = parseText(formData.get("body"));
  if (body === null) return { error: "기록 내용을 적어 주세요." };
  const symbol = parseText(formData.get("symbol"))?.toUpperCase() ?? null;
  const emotion = parseText(formData.get("emotion"));

  const drafts = parseDraftAnnotations(formData.get("annotations"));
  if ("error" in drafts) return { error: drafts.error };

  const { supabase, user } = await requireUser();
  const { data, error } = await supabase
    .from("journal_notes")
    .insert({ book_id: bookId, user_id: user.id, symbol, body, emotion })
    .select("id")
    .single();
  if (error) return { error: error.message };

  if (drafts.items.length > 0) {
    const { error: memoError } = await supabase.from("trade_annotations").insert(
      drafts.items.map((d) => ({
        note_id: data.id,
        user_id: user.id,
        kind: d.kind,
        points: d.points,
        text: d.text,
        color: d.color,
        locked: d.locked,
        line_width: d.line_width,
        line_style: d.line_style,
      })),
    );
    if (memoError) {
      revalidatePath("/", "layout");
      return { error: `기록은 저장됐지만 차트 메모를 저장하지 못했습니다: ${memoError.message}` };
    }
  }

  revalidatePath("/", "layout");
  const memos = drafts.items.length > 0 ? ` · 차트 메모 ${drafts.items.length}개` : "";
  return { savedAt: Date.now(), message: `기록을 저장했습니다${memos}.` };
}

export async function deleteJournalNote(id: string): Promise<{ error?: string }> {
  if (!id) return { error: "기록을 찾을 수 없습니다." };
  const { supabase } = await requireUser();
  // 차트 메모는 FK cascade 로 함께 지워진다(0027).
  const { error } = await supabase.from("journal_notes").delete().eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/", "layout");
  return {};
}
