import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { cache } from 'react';

import type { Database } from '@/lib/supabase/database.types';

/**
 * 요청마다 새 인스턴스가 필요하다 — 쿠키 저장소가 요청 스코프이기 때문.
 *
 * 다만 **한 요청 안에서는 하나**여야 한다. 한 화면이 표를 예닐곱 개 읽는데 그때마다
 * 새로 만들면 쿠키를 다시 파싱하고 세션도 따로 들고, 이어지는 `auth.getUser()` 가
 * 매번 네트워크로 나간다. React `cache` 는 렌더 한 번 안에서 결과를 재사용한다.
 */
export const createClient = cache(async () => {
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
});
