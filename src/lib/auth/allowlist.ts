/**
 * 앱에 들어올 수 있는 계정.
 *
 * 구글 로그인은 "구글 계정이 있으면 누구나"가 기본이다. 이 앱은 한 사람의 매매 기록과
 * 거래소 API 키를 담으므로 그 기본값을 그대로 두면 안 된다. `ALLOWED_EMAILS` 에 적힌
 * 주소만 통과시킨다.
 *
 * 비워 두면 제한하지 않는다 — 로컬에서 아무 계정으로나 붙어 볼 수 있게 하기 위해서다.
 * 배포 환경에는 반드시 채울 것.
 */

/** `a@b.com, c@d.com` → `['a@b.com', 'c@d.com']`. 대소문자·공백은 무시한다. */
export function parseAllowedEmails(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
}

/** 목록이 비어 있으면 전부 통과. 비어 있지 않으면 목록에 있는 주소만. */
export function isEmailAllowed(
  email: string | undefined | null,
  allowed: string[],
): boolean {
  if (allowed.length === 0) return true;
  if (!email) return false;
  return allowed.includes(email.trim().toLowerCase());
}

export function isAllowedEmail(email: string | undefined | null): boolean {
  return isEmailAllowed(email, parseAllowedEmails(process.env.ALLOWED_EMAILS));
}
