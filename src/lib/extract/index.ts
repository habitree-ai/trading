import { okxAdapter } from "@/lib/extract/okx";
import type { ExchangeAdapter, ExtractResult } from "@/lib/extract/types";

/** 등록된 거래소 어댑터. 새 거래소는 여기에 추가한다. */
export const ADAPTERS: ExchangeAdapter[] = [okxAdapter];

/** 신뢰도가 이 아래면 AI 비전으로 다시 시도한다. */
export const AI_FALLBACK_THRESHOLD = 0.75;

/**
 * OCR 텍스트를 어댑터에 태운다.
 *
 * 어떤 어댑터도 자기 화면이라고 하지 않으면 null — 호출부가 AI 폴백으로 넘긴다.
 */
export function extractFromText(text: string): ExtractResult | null {
  const scored = ADAPTERS.map((a) => ({ adapter: a, score: a.detect(text) })).sort(
    (x, y) => y.score - x.score,
  );

  const best = scored[0];
  if (!best || best.score < 0.5) return null;

  return { ...best.adapter.parse(text), engine: "ocr" };
}

export type { ExtractResult, ExtractedFields } from "@/lib/extract/types";
