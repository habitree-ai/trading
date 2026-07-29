/**
 * OKX 개인 API — 읽기 전용 키로 계좌·거래 내역을 가져온다.
 *
 * 공개 시세용 `@/lib/okx`와 파일을 나눈 이유: 이쪽은 서명 키를 다루므로
 * 클라이언트 번들에 딸려 들어가면 안 된다. 서버 코드에서만 import 할 것.
 *
 * 서명 = Base64( HMAC-SHA256( secret, timestamp + method + requestPath + body ) )
 */

import { createHmac } from "node:crypto";

const BASE = "https://www.okx.com";

/** OKX가 3개월치만 돌려준다 — 그보다 오래된 구간은 요청해도 빈 배열이다. */
export const MAX_HISTORY_MS = 90 * 24 * 60 * 60 * 1000;

export interface OkxCredentials {
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

/** 환경변수에서 키를 읽는다 — 셋 중 하나라도 비면 미설정으로 본다. */
export function readCredentials(): OkxCredentials | null {
  const apiKey = process.env.OKX_API_KEY ?? "";
  const secretKey = process.env.OKX_API_SECRET ?? "";
  const passphrase = process.env.OKX_API_PASSPHRASE ?? "";
  if (!apiKey || !secretKey || !passphrase) return null;
  return { apiKey, secretKey, passphrase };
}

/** 값이 있는 항목만 실어 `?a=1&b=2`를 만든다. 서명은 이 문자열까지 포함해야 맞는다. */
export function buildQuery(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

export function sign(
  secretKey: string,
  timestamp: string,
  method: string,
  requestPath: string,
  body = "",
): string {
  return createHmac("sha256", secretKey)
    .update(`${timestamp}${method}${requestPath}${body}`)
    .digest("base64");
}

export class OkxApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "OkxApiError";
  }
}

interface Envelope {
  code: string;
  msg: string;
  data: unknown[];
}

/** 레이트리밋(HTTP 429 / OKX 50011)과 일시적 5xx는 잠깐 쉬었다 다시 부른다. */
const RETRYABLE_CODES = new Set(["50011", "50013"]);
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(requestPath: string, headers: Record<string, string>): Promise<unknown[]> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${BASE}${requestPath}`, {
      headers: { accept: "application/json", ...headers },
      cache: "no-store",
    });

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new OkxApiError(`OKX 응답 오류 ${res.status}`, String(res.status));

    const json = (await res.json()) as Envelope;
    if (json.code === "0") return json.data;

    if (RETRYABLE_CODES.has(json.code) && attempt < MAX_RETRIES) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    throw new OkxApiError(`OKX 오류 ${json.code}: ${json.msg || "(메시지 없음)"}`, json.code);
  }
}

export async function okxPrivateGet(
  path: string,
  params: Record<string, string | number | undefined>,
  creds: OkxCredentials,
): Promise<unknown[]> {
  const requestPath = `${path}${buildQuery(params)}`;
  const timestamp = new Date().toISOString();

  return request(requestPath, {
    "OK-ACCESS-KEY": creds.apiKey,
    "OK-ACCESS-SIGN": sign(creds.secretKey, timestamp, "GET", requestPath),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": creds.passphrase,
  });
}

export function okxPublicGet(
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<unknown[]> {
  return request(`${path}${buildQuery(params)}`, {});
}
