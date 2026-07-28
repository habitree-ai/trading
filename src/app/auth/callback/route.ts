import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

/** OAuth(구글) 로그인이 돌아오는 지점 — 인가 코드를 세션으로 바꾼다. */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) redirect(next.startsWith("/") ? next : "/dashboard");
  }

  redirect("/login?error=oauth");
}
