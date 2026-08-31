/**
 * 카카오 "나에게 보내기" 최초 토큰 발급 — 브라우저 동의 1회 (REQ-0023).
 *
 * 흐름: 로컬 콜백 서버(8787)를 띄우고 → 동의 URL을 출력(브라우저 자동 열기 시도) →
 * 사용자가 카카오 로그인·동의 → 콜백으로 받은 code 를 토큰으로 교환 →
 * Supabase `kakao_tokens` 에 저장(service_role). 이후 갱신은 스캔 라우트가 자동으로 한다.
 *
 * 선행 조건:
 *   · 카카오 개발자 앱(현물신호 알림, 1562570)에 Redirect URI
 *     `http://localhost:8787/callback` 이 등록되어 있어야 한다
 *   · 동의항목에서 "카카오톡 메시지 전송(talk_message)" 이 켜져 있어야 한다
 *
 * 사용: npm run kakao-auth   (.env.local 의 KAKAO_REST_API_KEY·SUPABASE 키 사용)
 */
import { createServer } from "node:http";
import { exec } from "node:child_process";

import { createClient } from "@supabase/supabase-js";

const PORT = 8787;
const REDIRECT = `http://localhost:${PORT}/callback`;

const restKey = process.env.KAKAO_REST_API_KEY;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const userId = process.env.SYSTEM_BOT_USER_ID;
for (const [name, v] of [
  ["KAKAO_REST_API_KEY", restKey],
  ["NEXT_PUBLIC_SUPABASE_URL", supabaseUrl],
  ["SUPABASE_SECRET_KEY", secretKey],
  ["SYSTEM_BOT_USER_ID", userId],
]) {
  if (!v) {
    console.error(`✗ ${name} 가 없다 — .env.local 을 확인하라`);
    process.exit(1);
  }
}

const authUrl =
  `https://kauth.kakao.com/oauth/authorize?client_id=${restKey}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=talk_message`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  const denied = url.searchParams.get("error");
  if (!code) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end(`동의가 거부되었거나 code 가 없다: ${denied ?? "?"}`);
    console.error(`✗ 동의 실패: ${denied ?? "code 없음"}`);
    process.exit(1);
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: restKey,
      redirect_uri: REDIRECT,
      code,
    });
    // 클라이언트 시크릿이 활성화된 앱은 이 값 없이는 토큰을 주지 않는다.
    if (process.env.KAKAO_CLIENT_SECRET) body.set("client_secret", process.env.KAKAO_CLIENT_SECRET);
    const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = await tokenRes.json();
    if (!tokenRes.ok || !json.access_token) {
      throw new Error(`토큰 교환 실패 HTTP ${tokenRes.status}: ${JSON.stringify(json).slice(0, 200)}`);
    }
    // 카카오는 token 응답에 scope 를 생략하기도 한다 — 여기서 막지 않고 테스트 발송이 최종 검증이다.
    console.log(`  scope: ${json.scope ?? "(응답에 없음)"}`);

    const supabase = createClient(supabaseUrl, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const now = Date.now();
    const { error } = await supabase.from("kakao_tokens").upsert({
      user_id: userId,
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: new Date(now + json.expires_in * 1000).toISOString(),
      refresh_expires_at: json.refresh_token_expires_in
        ? new Date(now + json.refresh_token_expires_in * 1000).toISOString()
        : null,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`토큰 저장 실패: ${error.message}`);

    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("발급 완료 — 이 창은 닫아도 된다. 터미널을 확인하라.");
    console.log("✓ 토큰 발급·저장 완료 — 스캔 라우트가 이후 자동 갱신한다");
    console.log(`  access 만료: ${new Date(now + json.expires_in * 1000).toISOString()}`);
    server.close(() => process.exit(0));
  } catch (cause) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(String(cause?.message ?? cause));
    console.error(`✗ ${cause?.message ?? cause}`);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log("브라우저에서 카카오 동의를 진행하라 (자동으로 열리지 않으면 URL 을 직접 열 것):\n");
  console.log(`  ${authUrl}\n`);
  // Windows 기본 브라우저로 연다 — 실패해도 URL 출력이 있으니 조용히 넘어간다.
  exec(`start "" "${authUrl}"`, () => {});
});
