/**
 * `/blog` 「내 생각」 한 줄 목록의 순서와 한 줄 — 화면과 떼어 시험하는 순수 함수.
 *
 * 순서의 기준은 내 생각 작성일(`think_at`, 트리거가 찍는 "처음 적은 시각")이다. 노트 목록
 * 조회(`listSeniorNotes`)는 최근 수정순 그대로 둔다 — 정리 문서의 노트 칸이 그 순서에 기댄다.
 */
import type { SeniorNote } from "@/lib/senior/notes";

/**
 * 내 생각 작성일 최신순. 아직 생각을 적지 않은 노트는 뒤로, 같은 조건끼리는 들어온 순서를
 * 지킨다(정렬은 안정적이다) — 들어온 순서가 최근 수정순이므로 뒤쪽 노트도 그 순으로 남는다.
 */
export function orderByThought<T extends Pick<SeniorNote, "think_at">>(notes: T[]): T[] {
  const at = (n: T) => (n.think_at ? Date.parse(n.think_at) : Number.NEGATIVE_INFINITY);
  // 둘 다 없으면 -∞ − -∞ = NaN — `|| 0` 이 "같다"로 바꾼다.
  return [...notes].sort((a, b) => at(b) - at(a) || 0);
}

/** 글의 첫 줄 — 비어 있지 않은 첫 줄을 다듬어 돌려준다. 없으면 빈 문자열. */
export function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== "") ?? ""
  );
}
