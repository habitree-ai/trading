/**
 * 리서치 수집 계층의 타입 — 소스별 파서와 오케스트레이터가 주고받는 모양.
 *
 * 화면·DB가 쓰는 모양은 `@/lib/domain`의 ResearchSnapshot이고, 여기 있는 것은
 * 그 행을 만들기까지의 중간 형태다.
 */

import type { ResearchHeadline } from "@/lib/domain";

/** CoinGecko에서 얻는 값 묶음. */
export interface MarketMetrics {
  price_usd: number | null;
  market_cap_usd: number | null;
  volume_24h_usd: number | null;
}

/** alternative.me 공포탐욕지수 — 0(극단적 공포) ~ 100(극단적 탐욕). */
export interface FearGreed {
  value: number;
  label: string;
}

/** OKX 무기한 파생 지표. */
export interface DerivMetrics {
  funding_rate: number | null;
  open_interest: number | null;
  open_interest_usd: number | null;
}

export const SOURCE_KEYS = ["coingecko", "fng", "okx", "news"] as const;
export type SourceKey = (typeof SOURCE_KEYS)[number];

/** 소스별 성공/실패 — `"ok"` 또는 `"error: ..."`. */
export type SourceStatus = Record<SourceKey, string>;

/** research_snapshots insert 페이로드 — id/user_id/collected_at은 DB가 채운다. */
export interface SnapshotInsert {
  symbol: string;
  price_usd: number | null;
  market_cap_usd: number | null;
  volume_24h_usd: number | null;
  dominance_pct: number | null;
  fear_greed: number | null;
  fear_greed_label: string | null;
  funding_rate: number | null;
  open_interest: number | null;
  open_interest_usd: number | null;
  headlines: ResearchHeadline[];
  sources: SourceStatus;
}
