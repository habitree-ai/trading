/**
 * 노트의 다섯 칸 — 로컬 `내생각.html` 의 칸·안내 문구를 그대로 가져왔다.
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
}

export const SENIOR_NOTE_FIELDS: SeniorNoteFieldMeta[] = [
  {
    key: "quote",
    label: "인용 — 걸린 대목",
    hint: "원문에서 마음에 걸린 문장을 그대로 옮겨 둡니다. 발췌입니다 — 글 전체를 옮기는 자리가 아닙니다. 나중에 다시 열었을 때 여기서 다시 출발하게 됩니다.",
    placeholder: "원문에서 옮겨 붙이세요.",
    rows: 6,
  },
  {
    key: "think",
    label: "내 생각",
    hint: "동의하든 아니든 내 언어로. 요약이 아니라 반응을 적습니다.",
    placeholder: "이 대목이 왜 걸렸는가.\n내 경험 중 어디에 닿는가.\n저자가 말하지 않은 것은 무엇인가.",
    rows: 11,
  },
  {
    key: "apply",
    label: "나에게 적용하면",
    hint: "내 계좌·내 상황에서 무엇을 바꿀 것인가. 숫자로 적을 수 있으면 숫자로.",
    placeholder: "바꿀 것 하나.\n그 판단의 기준선(숫자).\n언제 점검할 것인가.",
    rows: 6,
  },
  {
    key: "differ",
    label: "다른 점 · 동의하지 않는 부분",
    hint: "그대로 따라 하면 안 되는 이유를 먼저 적어둡니다. 이 칸이 비어 있으면 대개 아직 소화가 안 된 것입니다.",
    placeholder: "내 조건이 저자와 다른 지점.\n저자의 전제 중 나에게 성립하지 않는 것.",
    rows: 6,
  },
  {
    key: "ask",
    label: "남는 질문",
    hint: "답을 못 찾은 것. 다음에 확인할 것.",
    placeholder: "아직 모르겠는 것.",
    rows: 5,
  },
];

export const SENIOR_NOTE_STATUS_LABEL = {
  draft: "초안",
  done: "정리됨",
} as const;
