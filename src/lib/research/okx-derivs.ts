/**
 * OKX 공개 파생 지표 — 펀딩비·미결제약정. 인증이 필요 없다.
 *
 * `@/lib/okx`는 복기용 캔들 전용이라 여기 섞지 않는다 — 심볼을 계약으로 펴는
 * `toInstId`만 빌려 쓴다. OKX에 무기한이 없는 심볼은 오류 응답이 오고, 그 경우
 * 이 소스만 실패로 남는다(스냅샷의 나머지는 정상).
 */

import { toInstId } from "@/lib/okx";
import type { DerivMetrics } from "@/lib/research/types";

const BASE = "https://www.okx.com/api/v5";

interface OkxEnvelope {
  code: string;
  msg: string;
  data: unknown;
}

/** OKX 응답의 첫 행 — 값이 전부 문자열로 온다. */
function firstRow(json: unknown): Record<string, unknown> | null {
  if (typeof json !== "object" || json === null) return null;
  const data = (json as Record<string, unknown>).data;
  if (!Array.isArray(data)) return null;
  return (data[0] as Record<string, unknown> | undefined) ?? null;
}

function asNumeric(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `/public/funding-rate` 응답 → 펀딩비(소수). */
export function parseFundingRate(json: unknown): number | null {
  return asNumeric(firstRow(json)?.fundingRate);
}

/** `/public/open-interest` 응답 → 계약 수·명목 USD. */
export function parseOpenInterest(
  json: unknown,
): Pick<DerivMetrics, "open_interest" | "open_interest_usd"> {
  const row = firstRow(json);
  return {
    open_interest: asNumeric(row?.oi),
    open_interest_usd: asNumeric(row?.oiUsd),
  };
}

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OKX 응답 오류 ${res.status}`);

  const json = (await res.json()) as OkxEnvelope;
  if (json.code !== "0") throw new Error(`OKX 오류: ${json.msg || json.code}`);
  return json;
}

export async function fetchDerivs(symbol: string): Promise<DerivMetrics> {
  const instId = encodeURIComponent(toInstId(symbol));
  const [funding, oi] = await Promise.all([
    get(`/public/funding-rate?instId=${instId}`),
    get(`/public/open-interest?instType=SWAP&instId=${instId}`),
  ]);

  return { funding_rate: parseFundingRate(funding), ...parseOpenInterest(oi) };
}
