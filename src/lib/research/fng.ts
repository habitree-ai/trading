/**
 * alternative.me 공포탐욕지수 — 키 없이 쓴다.
 *
 * 시장 전체(사실상 BTC 중심) 심리 지수라 심볼별 값이 아니다. 화면은 이 사실을
 * 라벨로 밝힌다 — 같은 날 어떤 심볼로 수집해도 같은 값이 기록된다.
 */

import type { FearGreed } from "@/lib/research/types";

const URL = "https://api.alternative.me/fng/?limit=1&format=json";

/** `/fng/` 응답 → 지수. 값이 문자열("73")로 오므로 숫자로 편다. */
export function parseFng(json: unknown): FearGreed | null {
  if (typeof json !== "object" || json === null) return null;
  const data = (json as Record<string, unknown>).data;
  if (!Array.isArray(data)) return null;

  const row = data[0] as Record<string, unknown> | undefined;
  const value = Number(row?.value);
  if (!Number.isFinite(value)) return null;

  return {
    value,
    label: typeof row?.value_classification === "string" ? row.value_classification : "",
  };
}

export async function fetchFearGreed(): Promise<FearGreed> {
  const res = await fetch(URL, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`alternative.me 응답 오류 ${res.status}`);

  const parsed = parseFng(await res.json());
  if (!parsed) throw new Error("alternative.me 응답 형태가 다릅니다");
  return parsed;
}
