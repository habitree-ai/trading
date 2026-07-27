import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

/** Next 16의 `proxy` 규약 — 구 `middleware`를 대체한다. */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
