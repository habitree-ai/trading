import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import type { Database } from '@/lib/supabase/database.types';

/** 요청마다 새 인스턴스가 필요하다 — 쿠키 저장소가 요청 스코프이기 때문. */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // 서버 컴포넌트에서는 쿠키를 쓸 수 없다 — 미들웨어가 갱신을 담당한다.
          }
        },
      },
    },
  );
}
