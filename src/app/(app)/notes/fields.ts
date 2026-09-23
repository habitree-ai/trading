import {
  isBiasTimeframe,
  isEntryTimeframe,
  isOpenness,
  isTrend,
  type Trade,
} from "@/lib/domain";
import { parseImagePaths } from "@/lib/photos";

/**
 * 매매 노트의 카드별 저장 칸 — 서버 액션 밖의 순수 함수로 둬서 테스트한다.
 *
 * 카드마다 자기 칸만 싣는다. 한 번에 다 보내면 근거 카드를 저장할 때 화면에 없던 복기 칸이
 * 빈 값으로 들어가 지워진다. 숫자 칸(가격·수량·손절·목표)은 어느 카드에도 없다 — 동기화가
 * 채운 값이고 고치는 곳은 `/trades/[id]` 다.
 */
export type NotesSection = "basis" | "review";

type BasisUpdate = Pick<
  Trade,
  "trend" | "timeframe_bias" | "timeframe_entry" | "openness" | "setup" | "rationale"
>;
type ReviewUpdate = Pick<Trade, "review" | "emotion" | "note" | "image_paths">;

export type NotesUpdate = { update: BasisUpdate | ReviewUpdate } | { error: string };

/** 빈 칸은 null — 폼이 기존 값을 채워 보여 주므로 비워 보낸 것은 지우겠다는 뜻이다. */
function text(formData: FormData, name: string): string | null {
  const raw = String(formData.get(name) ?? "").trim();
  return raw === "" ? null : raw;
}

/** 목록 밖 값은 거부한다 — 그대로 보내면 DB CHECK 가 막아 영문 오류가 화면에 뜬다. */
function pick<T extends string>(
  formData: FormData,
  name: string,
  guard: (v: string) => v is T,
): T | null | undefined {
  const raw = text(formData, name);
  if (raw === null) return null;
  return guard(raw) ? raw : undefined;
}

export function parseNotesUpdate(
  section: string,
  formData: FormData,
  userId: string,
): NotesUpdate {
  if (section === "basis") {
    const trend = pick(formData, "trend", isTrend);
    const timeframe_bias = pick(formData, "timeframe_bias", isBiasTimeframe);
    const timeframe_entry = pick(formData, "timeframe_entry", isEntryTimeframe);
    const openness = pick(formData, "openness", isOpenness);
    if (
      trend === undefined ||
      timeframe_bias === undefined ||
      timeframe_entry === undefined ||
      openness === undefined
    ) {
      return { error: "고를 수 없는 값이 들어왔습니다. 새로고침 후 다시 골라 주세요." };
    }
    return {
      update: {
        trend,
        timeframe_bias,
        timeframe_entry,
        openness,
        setup: text(formData, "setup"),
        rationale: text(formData, "rationale"),
      },
    };
  }
  if (section === "review") {
    return {
      update: {
        review: text(formData, "review"),
        emotion: text(formData, "emotion"),
        note: text(formData, "note"),
        image_paths: parseImagePaths(formData, userId),
      },
    };
  }
  return { error: "저장할 구역을 알 수 없습니다." };
}
