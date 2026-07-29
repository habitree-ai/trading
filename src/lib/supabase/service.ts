import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

/**
 * RLS를 우회하는 서버 전용 클라이언트.
 *
 * 크론처럼 로그인 세션이 없는 실행에서만 쓴다. 이 키가 새면 모든 사용자 데이터가
 * 열리므로 브라우저로 나가는 코드에서는 절대 import 하지 말 것.
 * 키가 없으면 null — 크론을 안 쓰는 배포에서는 설정하지 않아도 된다.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;

  return createSupabaseClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
