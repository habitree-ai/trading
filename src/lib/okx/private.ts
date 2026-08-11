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

/** 지금 기준으로 내역을 받아 올 수 있는 가장 이른 시각(ms). */
export function historyFloorMs(): number {
  return Date.now() - MAX_HISTORY_MS;
}

export interface OkxCredentials {
  apiKey: string;
  secretKey: string;
  passphrase: string;
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
    /** 어느 엔드포인트에서 났는지 — 일부 경로만 막히면 키가 아니라 권한 문제다 */
    readonly path: string | null = null,
  ) {
    super(message);
    this.name = "OkxApiError";
  }
}

/**
 * 인증 실패 코드별 원인 — 손댈 곳을 그대로 적는다.
 *
 * OKX는 HTTP 401에도 본문에 실패 이유를 코드로 담아 준다. 상태 코드만 보고 던지면
 * `OKX 응답 오류 401` 한 줄만 남아, 키·시크릿·패스프레이즈·서버 시계·허용 IP 가운데
 * 무엇이 어긋났는지 화면에서도 `sync_runs.error`에서도 알 수 없다.
 */
const CAUSE: Record<string, string> = {
  "50100": "API 사용이 정지된 키입니다. OKX 계정에서 키 상태를 확인해 주세요.",
  "50101":
    "키가 만들어진 환경과 요청 환경이 다릅니다. 데모(모의) 거래용 키로는 실거래 내역을 받을 수 없습니다.",
  "50102":
    "요청 시각이 만료됐습니다. 서버 시계가 OKX보다 30초 이상 어긋났다는 뜻입니다.",
  "50103": "API 키 헤더가 비어 있습니다. 설정에서 키를 다시 등록해 주세요.",
  "50104": "패스프레이즈가 비어 있습니다. 설정에서 다시 등록해 주세요.",
  "50105": "패스프레이즈가 틀립니다. 키를 만들 때 정한 값 그대로 설정에서 다시 등록해 주세요.",
  "50106": "서명 헤더가 비어 있습니다.",
  "50107": "타임스탬프 헤더가 비어 있습니다.",
  "50110":
    "이 서버의 IP가 API 키의 허용 IP 목록에 없습니다. 배포 서버는 나갈 때 쓰는 IP가 고정이 아니므로, 키에 걸어 둔 IP 제한을 풀어야 합니다.",
  "50111": "API 키가 올바르지 않습니다. 설정에서 키를 다시 등록해 주세요.",
  "50112": "타임스탬프 형식이 올바르지 않습니다.",
  "50113": "서명이 맞지 않습니다. 시크릿이 틀렸을 가능성이 큽니다 — 설정에서 다시 등록해 주세요.",
  "50114": "이 키에는 해당 조회 권한이 없습니다. 읽기(Read) 권한으로 다시 발급해 주세요.",
};

/** 코드에 대응하는 원인 설명. 모르는 코드면 null. */
export function describeOkxCode(code: string): string | null {
  return CAUSE[code] ?? null;
}

/**
 * 사람이 읽을 오류 한 줄 — 코드·원문·원인·엔드포인트를 한 줄에 담는다.
 *
 * 엔드포인트를 함께 남기는 이유: 전부 막히면 키 자체가 문제지만 `/api/v5/asset/…`만
 * 막히면 자금 계좌 조회 권한이 빠진 것이라 손댈 곳이 다르다.
 */
function formatMessage(code: string, msg: string, path: string): string {
  const cause = describeOkxCode(code);
  const head = `OKX 오류 ${code}: ${msg || "(메시지 없음)"}`;
  return `${head}${cause ? ` — ${cause}` : ""} (${path.split("?")[0]})`;
}

interface Envelope {
  code: string;
  msg: string;
  data: unknown[];
}

/**
 * 본문을 봉투로 읽는다 — 상태 코드가 2xx가 아니어도 먼저 읽어야 한다.
 *
 * 거래소 앞단(WAF·게이트웨이)이 막으면 JSON이 아니라 HTML이 오므로 파싱이 깨질 수 있다.
 * 그때는 null을 돌려 상태 코드로 되돌아간다.
 */
async function readEnvelope(res: Response): Promise<Envelope | null> {
  try {
    const json = (await res.json()) as Partial<Envelope>;
    if (typeof json?.code !== "string") return null;
    return { code: json.code, msg: json.msg ?? "", data: json.data ?? [] };
  } catch {
    return null;
  }
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

    // 상태 코드보다 본문이 먼저다 — 401·400에도 실패 이유는 본문 코드에 들어 있다.
    const json = await readEnvelope(res);
    if (json === null) {
      if (res.ok) throw new OkxApiError("OKX 응답을 읽지 못했습니다.", String(res.status), requestPath);
      throw new OkxApiError(
        `OKX 응답 오류 ${res.status} — 거래소가 이유를 알려 주지 않았습니다. (${requestPath.split("?")[0]})`,
        String(res.status),
        requestPath,
      );
    }

    if (json.code === "0") return json.data;

    if (RETRYABLE_CODES.has(json.code) && attempt < MAX_RETRIES) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    throw new OkxApiError(formatMessage(json.code, json.msg, requestPath), json.code, requestPath);
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
