/**
 * 노트의 두 칸 — 선배님의 글과 내 생각. 한 노트를 두 시선으로 나란히 읽는다.
 *
 * 한때 다섯 칸(적용·다른 점·남는 질문까지)이었으나, 내가 직접 쓰지 않은 문장이 그 칸들을
 * 채우면서 노트가 내 것이 아니게 됐다. 화면에 남기는 건 원문과 내 반응 둘뿐이다.
 * 나머지 세 칸은 DB 열로만 남아 있고 어디에도 보이지 않는다.
 *
 * 서버·클라이언트 양쪽이 쓰는 순수 상수라 DB 클라이언트를 물고 있는 `notes.ts` 와
 * 떼어 둔다(그쪽은 `next/headers` 를 쓰므로 클라이언트 컴포넌트가 import 할 수 없다).
 */

export type SeniorNoteField = "quote" | "think" | "apply" | "differ" | "ask";

export interface SeniorNoteFieldMeta {
  key: SeniorNoteField;
  label: string;
  hint: string;
  placeholder: string;
  rows: number;
  /** 칸이 비었을 때 그 자리에 놓는 말 — 한쪽이 비어도 두 화면 모양은 유지된다. */
  empty: string;
}

export const SENIOR_NOTE_FIELDS: SeniorNoteFieldMeta[] = [
  {
    key: "quote",
    label: "선배님의 글",
    hint: "네이버 원문을 그대로 옮겨 둡니다. 왼쪽 화면에 이 글이 놓입니다.",
    placeholder: "원문에서 옮겨 붙이세요.",
    rows: 16,
    empty: "아직 원문을 옮겨두지 않았습니다.",
  },
  {
    key: "think",
    label: "내 생각",
    hint: "동의하든 아니든 내 언어로. 요약이 아니라 반응을 적습니다. 오른쪽 화면에 놓입니다.",
    placeholder: "이 글이 왜 걸렸는가.\n내 경험 중 어디에 닿는가.",
    rows: 16,
    empty: "아직 내 생각을 적지 않았습니다.",
  },
];

export const SENIOR_NOTE_STATUS_LABEL = {
  draft: "초안",
  done: "정리됨",
} as const;
