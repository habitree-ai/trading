/**
 * 카카오 "나에게 보내기" — 서버 전용.
 *
 * 토큰은 `kakao_tokens`(RLS 정책 없음 = service_role 전용)에 산다. 최초 발급은
 * `npm run kakao-auth`(브라우저 동의 1회), 이후에는 여기서 만료 임박 시 자동 갱신한다.
 * 리프레시 토큰도 만료 1개월 이내가 되면 카카오가 새것을 내려준다 — 스캔이 매시
 * 돌므로 손댈 일 없이 이어진다. 스캔이 오래 죽어 있으면(2개월+) 재발급이 필요하다.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

const TOKEN_URL = "https://kauth.kakao.com/oauth/token";
const MEMO_URL = "https://kapi.kakao.com/v2/api/talk/memo/default/send";
/** 만료 이 분 전이면 미리 갱신한다 — 발송 도중 만료를 피한다. */
const REFRESH_AHEAD_MS = 10 * 60_000;
/** 카카오 텍스트 템플릿 본문 한도. */
const TEXT_LIMIT = 200;

type Service = SupabaseClient<Database>;

export interface KakaoSendResult {
  ok: boolean;
  /** 실패 사유 — 호출자가 notify_status 에 기록한다. */
  detail?: string;
}

async function refreshIfNeeded(supabase: Service, userId: string): Promise<{ token: string } | { error: string }> {
  const { data: row, error } = await supabase
    .from("kakao_tokens")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { error: `토큰 조회 실패: ${error.message}` };
  if (!row) return { error: "no-token — npm run kakao-auth 로 최초 발급이 필요합니다" };

  if (Date.parse(row.expires_at) - Date.now() > REFRESH_AHEAD_MS) {
    return { token: row.access_token };
  }

  const restKey = process.env.KAKAO_REST_API_KEY;
  if (!restKey) return { error: "KAKAO_REST_API_KEY 가 없습니다" };

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: restKey,
    refresh_token: row.refresh_token,
  });
  // 앱의 클라이언트 시크릿이 "활성화"면 이게 빠진 토큰 요청은 전부 거절된다.
  if (process.env.KAKAO_CLIENT_SECRET) body.set("client_secret", process.env.KAKAO_CLIENT_SECRET);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return { error: `토큰 갱신 실패 HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };

  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
  };
  const update: Database["public"]["Tables"]["kakao_tokens"]["Update"] = {
    access_token: json.access_token,
    expires_at: new Date(Date.now() + json.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  // 리프레시 토큰은 만료가 가까울 때만 새로 온다 — 온 경우에만 바꾼다.
  if (json.refresh_token) {
    update.refresh_token = json.refresh_token;
    if (json.refresh_token_expires_in) {
      update.refresh_expires_at = new Date(Date.now() + json.refresh_token_expires_in * 1000).toISOString();
    }
  }
  const { error: saveError } = await supabase.from("kakao_tokens").update(update).eq("user_id", userId);
  if (saveError) return { error: `갱신 토큰 저장 실패: ${saveError.message}` };
  return { token: json.access_token };
}

/** 나와의 채팅으로 텍스트 + 링크 버튼 1개를 보낸다. */
export async function sendKakaoToMe(
  supabase: Service,
  userId: string,
  text: string,
  linkUrl: string,
): Promise<KakaoSendResult> {
  const got = await refreshIfNeeded(supabase, userId);
  if ("error" in got) return { ok: false, detail: got.error };

  const template = {
    object_type: "text",
    text: text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text,
    link: { web_url: linkUrl, mobile_web_url: linkUrl },
    button_title: "신호 보기",
  };
  const res = await fetch(MEMO_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${got.token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ template_object: JSON.stringify(template) }),
  });
  if (!res.ok) return { ok: false, detail: `카카오 발송 실패 HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
  return { ok: true };
}

/** 발송 실패 백업 — 봇의 notify.mjs 와 같은 조용한 최선-노력 웹훅. 실패는 삼킨다. */
export async function sendDiscordFallback(text: string): Promise<boolean> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, 1900) }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
