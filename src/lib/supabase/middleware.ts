import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { isAllowedEmail } from '@/lib/auth/allowlist';

/**
 * 세션 검사를 건너뛰는 경로 접두사.
 *
 * `/api/cron`은 로그인 세션이 아니라 `Authorization: Bearer $CRON_SECRET`으로
 * 자기를 증명한다. 여기서 막으면 라우트에 닿지도 못하고 로그인 페이지로 튕긴다.
 *
 * `/blog`는 누구나 읽는 공개 페이지다. 쓰기는 서버 액션이 관리자 계정을 따로 확인한다.
 */
const PUBLIC_PREFIXES = ['/login', '/auth', '/api/cron', '/blog'];

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          supabaseResponse = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // 토큰 갱신 — createServerClient와 이 호출 사이에 다른 코드를 넣지 말 것.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  // 세션은 있지만 허용 목록에 없는 계정. 세션 정리는 `/auth/callback`이 하고,
  // 여기서는 모든 페이지를 막기만 한다 — 미들웨어에서 로그아웃하면 갱신된 쿠키를
  // 리다이렉트 응답으로 옮겨 실어야 해서 실패 지점이 늘어난다.
  const allowed = isAllowedEmail(user?.email);

  if (user && !allowed && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('error', 'forbidden');
    return NextResponse.redirect(url);
  }

  if (user && allowed && pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
