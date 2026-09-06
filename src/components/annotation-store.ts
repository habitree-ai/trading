import {
  createAnnotation,
  deleteAnnotation,
  restoreAnnotation,
  setAnnotationLocked,
  updateAnnotationPoints,
  updateAnnotationStyle,
  updateAnnotationText,
  type AnnotationOwner,
  type AnnotationResult,
  type CreateResult,
} from "@/app/(app)/trades/annotation-actions";
import { normalizePoints } from "@/lib/annotations";
import type {
  AnnotationColor,
  AnnotationKind,
  AnnotationLineStyle,
  ChartPoint,
  TradeAnnotation,
  TradeFill,
} from "@/lib/domain";

/**
 * 차트 메모의 저장 경로 — 차트는 "어디에 저장되는지"를 모른다.
 *
 * 복기 차트는 처음부터 거래 한 건에 붙어 있었다(REQ-0048 이전). 일반 기록의 종목 차트가
 * 생기면서 소유자가 둘이 됐고, 아직 저장하지 않은 기록의 차트는 소유자 자체가 없다.
 * 그리기·끌기·되돌리기 코드를 소유자마다 복사하는 대신, 저장 경로만 여기로 뽑는다.
 */
export interface AnnotationDetail {
  fills: TradeFill[];
  annotations: TradeAnnotation[];
}

export interface AnnotationDraftInput {
  kind: AnnotationKind;
  points: ChartPoint[];
  text: string | null;
  color: AnnotationColor;
}

export interface AnnotationStyleInput {
  color?: AnnotationColor;
  lineWidth?: number | null;
  lineStyle?: AnnotationLineStyle | null;
}

export interface AnnotationStore {
  /** 차트 한 장의 재료 — 체결과 메모. 실패하면 사람이 읽을 메시지로 던진다. */
  load(): Promise<AnnotationDetail>;
  create(input: AnnotationDraftInput): Promise<CreateResult>;
  updatePoints(id: string, points: ChartPoint[]): Promise<AnnotationResult>;
  updateText(id: string, text: string): Promise<AnnotationResult>;
  updateStyle(id: string, style: AnnotationStyleInput): Promise<AnnotationResult>;
  setLocked(id: string, locked: boolean): Promise<AnnotationResult>;
  remove(id: string): Promise<AnnotationResult>;
  restore(annotation: TradeAnnotation): Promise<AnnotationResult>;
}

async function loadDetail(url: string): Promise<AnnotationDetail> {
  const res = await fetch(url, { cache: "no-store" });
  const body: unknown = await res.json();
  if (!res.ok) {
    throw new Error(
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : "차트 자료를 가져오지 못했습니다.",
    );
  }
  return body as AnnotationDetail;
}

/** DB 에 사는 메모 — 거래 또는 일반 기록이 소유자다. 서버 액션이 그대로 저장 경로다. */
function serverStore(owner: AnnotationOwner, detailUrl: string): AnnotationStore {
  return {
    load: () => loadDetail(detailUrl),
    create: (input) => createAnnotation({ owner, ...input }),
    updatePoints: (id, points) => updateAnnotationPoints(id, points),
    updateText: (id, text) => updateAnnotationText(id, text),
    updateStyle: (id, style) => updateAnnotationStyle(id, style),
    setLocked: (id, locked) => setAnnotationLocked(id, locked),
    remove: (id) => deleteAnnotation(id),
    restore: (annotation) => restoreAnnotation(annotation),
  };
}

export function tradeAnnotationStore(tradeId: string): AnnotationStore {
  return serverStore({ tradeId }, `/api/trades/${tradeId}/detail`);
}

export function noteAnnotationStore(noteId: string): AnnotationStore {
  return serverStore({ noteId }, `/api/journal/${noteId}/detail`);
}

/** 저장 전 기록의 차트가 들고 있는 메모 — 폼이 이 목록을 실어 보낸다. */
export interface DraftAnnotationStore extends AnnotationStore {
  annotations(): TradeAnnotation[];
}

/**
 * 아직 저장하지 않은 기록의 메모 — 브라우저 메모리에만 산다.
 *
 * 일반 기록은 저장 버튼을 누르기 전에는 id 가 없어 DB 에 메모를 붙일 곳이 없다. 그렇다고
 * 차트를 저장 뒤에만 열게 하면 "차트를 보며 적는다"가 안 된다. 여기 쌓아 두었다가 기록과
 * 함께 한 번에 저장한다(`serializeDraftAnnotations`). 새로고침하면 사라진다 — 초안이다.
 */
export function draftAnnotationStore(
  onChange?: (annotations: TradeAnnotation[]) => void,
  initial: readonly TradeAnnotation[] = [],
): DraftAnnotationStore {
  let list: TradeAnnotation[] = [...initial];
  const commit = (next: TradeAnnotation[]) => {
    list = next;
    onChange?.(list);
  };
  const ok = async (): Promise<AnnotationResult> => ({});
  const missing = async (): Promise<AnnotationResult> => ({ error: "메모를 찾을 수 없습니다." });
  const patch = (id: string, change: Partial<TradeAnnotation>) => {
    if (!list.some((a) => a.id === id)) return missing();
    const at = new Date().toISOString();
    commit(list.map((a) => (a.id === id ? { ...a, ...change, updated_at: at } : a)));
    return ok();
  };

  return {
    annotations: () => list,
    load: async () => ({ fills: [], annotations: list }),
    create: async ({ kind, points, text, color }) => {
      const trimmed = text?.trim() ?? "";
      if (kind === "text" && trimmed === "") return { error: "메모 내용을 입력해 주세요." };
      const at = new Date().toISOString();
      const annotation: TradeAnnotation = {
        id: crypto.randomUUID(),
        trade_id: null,
        note_id: null,
        user_id: "",
        kind,
        points: normalizePoints(kind, points),
        text: trimmed === "" ? null : trimmed,
        color,
        locked: false,
        created_at: at,
        updated_at: at,
      };
      commit([...list, annotation]);
      return { id: annotation.id };
    },
    updatePoints: async (id, points) => {
      const target = list.find((a) => a.id === id);
      if (!target) return missing();
      return patch(id, { points: normalizePoints(target.kind, points) });
    },
    updateText: async (id, text) => {
      const target = list.find((a) => a.id === id);
      if (!target) return missing();
      const trimmed = text.trim();
      if (target.kind === "text" && trimmed === "") return { error: "메모 내용을 입력해 주세요." };
      return patch(id, { text: trimmed === "" ? null : trimmed });
    },
    updateStyle: async (id, style) =>
      patch(id, {
        ...(style.color !== undefined ? { color: style.color } : {}),
        ...(style.lineWidth !== undefined ? { line_width: style.lineWidth ?? undefined } : {}),
        ...(style.lineStyle !== undefined ? { line_style: style.lineStyle ?? undefined } : {}),
      }),
    setLocked: async (id, locked) => patch(id, { locked }),
    remove: async (id) => {
      if (!list.some((a) => a.id === id)) return missing();
      commit(list.filter((a) => a.id !== id));
      return ok();
    },
    restore: async (annotation) => {
      commit([...list, annotation].sort((a, b) => a.created_at.localeCompare(b.created_at)));
      return ok();
    },
  };
}

/** 폼의 숨은 칸에 싣는 모양 — 서버가 `parseDraftAnnotations` 로 다시 검증한다. */
export function serializeDraftAnnotations(annotations: readonly TradeAnnotation[]): string {
  return JSON.stringify(
    annotations.map((a) => ({
      kind: a.kind,
      points: a.points.map((p) => ({ t: p.t, p: p.p })),
      text: a.text,
      color: a.color,
      locked: a.locked,
      line_width: a.line_width ?? null,
      line_style: a.line_style ?? null,
    })),
  );
}
