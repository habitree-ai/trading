import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { isAllowedEmail } from "@/lib/auth/allowlist";
import { createClient } from "@/lib/supabase/server";

/** OAuth(구글) 로그인이 돌아오는 지점 — 인가 코드를 세션으로 바꾼다. */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // 구글 계정만 있으면 누구나 여기까지 온다. 허용 목록 밖이면 세션을 되돌린다.
      // 라우트 핸들러라 쿠키를 쓸 수 있어, 세션을 실제로 지우는 건 이 지점뿐이다.
      if (!isAllowedEmail(data.user?.email)) {
        await supabase.auth.signOut();
        redirect("/login?error=forbidden");
      }
      redirect(next.startsWith("/") ? next : "/dashboard");
    }
  }

  redirect("/login?error=oauth");
}
