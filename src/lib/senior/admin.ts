/**
 * 공개 페이지의 관리자 — 노트를 고칠 수 있는 계정.
 *
 * `ALLOWED_EMAILS` 와 파서는 같이 쓰지만 **빈 값의 뜻이 반대**다. 허용 목록은 비면
 * 전원 통과(로컬 편의)지만, 이 목록은 비면 아무도 편집하지 못한다 — 공개 페이지에서
 * "비면 전원"은 위험하다. 그래서 `isEmailAllowed` 를 그대로 쓰지 않는다.
 */
import { cache } from "react";

import { parseAllowedEmails } from "@/lib/auth/allowlist";
import { requireUser } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";

export function isBlogAdminEmail(email: string | undefined | null, admins: string[]): boolean {
  if (admins.length === 0 || !email) return false;
  return admins.includes(email.trim().toLowerCase());
}

export function isBlogAdmin(email: string | undefined | null): boolean {
  return isBlogAdminEmail(email, parseAllowedEmails(process.env.BLOG_ADMIN_EMAILS));
}

/**
 * 지금 보는 사람이 관리자인가 — 화면이 편집 UI 를 보일지 정할 때 쓴다.
 * 비로그인은 조용히 false. 던지지 않는다 — 공개 페이지는 누구에게나 열려야 한다.
 */
export const getBlogViewer = cache(async (): Promise<{ admin: boolean; email: string | null }> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const email = user?.email ?? null;
  return { admin: isBlogAdmin(email), email };
});

/**
 * 쓰기 액션의 관문 — 세션·허용 목록(`requireUser`)을 거친 뒤 관리자 목록까지 본다.
 * 화면이 버튼을 숨겼다고 믿지 않는다. 서버 액션은 미들웨어를 안 거칠 수 있다.
 */
export const requireBlogAdmin = cache(async () => {
  const { supabase, user } = await requireUser();
  if (!isBlogAdmin(user.email)) throw new Error("관리자만 고칠 수 있습니다.");
  return { supabase, user };
});
