/**
 * 브라우저 내장 음성인식이 뱉은 문장을 다루는 규칙.
 *
 * 인식 자체는 브라우저가 한다. 우리가 정할 것은 하나뿐이다 —
 * **이미 적어 둔 글을 건드리지 않고 어떻게 이어 붙이느냐.**
 * 말이 글을 덮어쓰면 복구할 방법이 없기 때문에 규칙을 화면에서 떼어 두고 시험한다.
 */

/** 인식 언어. 화면 문구도 한국어이므로 고정한다. */
export const SPEECH_LANG = "ko-KR";

/**
 * 인식 조각을 한 덩어리로 잇는다.
 *
 * 브라우저는 말을 문장 단위로 끊어 여러 번 돌려준다. 조각 사이는 공백 하나로 두고,
 * 조각이 이미 공백을 달고 오는 경우가 있어 양끝을 정리한 뒤 붙인다.
 */
export function mergeSpoken(prev: string, chunk: string): string {
  const head = prev.trim();
  const tail = chunk.trim();
  if (!tail) return head;
  if (!head) return tail;
  return `${head} ${tail}`;
}

/**
 * 원래 있던 글 뒤에 이번에 말한 것을 잇는다.
 *
 * 줄을 바꿔 붙인다 — 손으로 적던 문장과 말한 문장이 한 줄에 섞이면 나중에 어디까지가
 * 무엇이었는지 알 수 없다. 말한 것이 없으면 원래 글을 그대로 돌려준다.
 */
export function joinTranscript(base: string, spoken: string): string {
  const said = spoken.trim();
  if (!said) return base;
  const kept = base.replace(/\s+$/, "");
  if (!kept) return said;
  return `${kept}\n${said}`;
}

/**
 * 인식 오류 코드를 사람 말로 바꾼다.
 *
 * 코드를 그대로 보여주면 무엇을 해야 할지 알 수 없다. 사용자가 할 수 있는 일을 적는다.
 */
export function speechErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "마이크 권한이 막혀 있습니다. 주소창 왼쪽 자물쇠에서 허용해 주세요.";
    case "audio-capture":
      return "마이크를 찾지 못했습니다. 연결을 확인해 주세요.";
    case "network":
      return "인식 서버에 닿지 못했습니다. 잠시 뒤 다시 눌러 주세요.";
    case "language-not-supported":
      return "이 브라우저가 한국어 인식을 지원하지 않습니다.";
    case "aborted":
      return "인식이 중단됐습니다.";
    default:
      return "음성 인식에 실패했습니다. 직접 입력해 주세요.";
  }
}
