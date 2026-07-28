"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Supabase는 OAuth 실패를 **URL 프래그먼트**로 돌려준다.
 *   `/auth/callback#error=server_error&error_description=...`
 * 프래그먼트는 서버로 전송되지 않아 그대로 두면 화면에 아무 흔적이 남지 않는다.
 * 브라우저에서 읽어 질의 문자열로 옮겨 서버가 사유를 렌더링할 수 있게 한다.
 */
export function OAuthErrorRelay() {
  const router = useRouter();

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;

    const params = new URLSearchParams(hash);
    const description = params.get("error_description");
    if (!params.get("error") && !description) return;

    const next = new URLSearchParams({ error: "oauth" });
    if (description) next.set("detail", description);
    router.replace(`/login?${next.toString()}`);
  }, [router]);

  return null;
}
