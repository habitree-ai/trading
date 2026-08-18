import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { resolveLabPath } from "@/lib/lab";
import { createClient } from "@/lib/supabase/server";

/**
 * 자료실 뷰어 — 로컬에 생성된 리포트 HTML을 그대로 흘려 보낸다.
 *
 * 리포트는 8MB를 넘기도 해서 전부 메모리에 읽지 않고 스트림으로 넘긴다.
 * 여는 파일은 `resolveLabPath` 가 카탈로그에서 찾은 것뿐이다 — 쿼리로 임의 경로를
 * 지정할 방법이 없다.
 *
 * 리포트는 인라인 스크립트로 자기 차트를 그린다(외부 CDN은 쓰지 않는다). 그래서
 * 스크립트는 살려 두되 `sandbox allow-scripts` 로 같은 출처 자격을 뺏는다 —
 * 실행은 되지만 앱의 쿠키·저장소에는 닿지 못하는 상태다. `allow-same-origin` 을
 * 함께 주면 그 격리가 통째로 풀리므로 절대 더하지 않는다.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });

  const key = new URL(request.url).searchParams.get("key");
  if (!key) return NextResponse.json({ error: "key가 필요합니다." }, { status: 400 });

  const path = resolveLabPath(key);
  if (!path) {
    return NextResponse.json(
      { error: "이 머신에 없는 자료입니다 — 생성 스크립트를 먼저 돌려 주세요." },
      { status: 404 },
    );
  }

  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, max-age=60",
      "content-security-policy": "sandbox allow-scripts",
    },
  });
}
