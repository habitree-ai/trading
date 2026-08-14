/**
 * 수집 오케스트레이터 — 4개 소스를 한꺼번에 부르고 하나의 스냅샷 행으로 조립한다.
 *
 * 소스 하나가 죽어도 나머지는 남긴다. 실패한 소스의 컬럼은 null이 되고 `sources`에
 * 사유가 적힌다 — 나중에 추이를 볼 때 "값이 없던 날"과 "0이던 날"이 갈려야 한다.
 * 전부 실패했을 때만 throw한다. 빈 스냅샷은 이력만 오염시킨다.
 */

import type { ResearchHeadline } from "@/lib/domain";
import { fetchDominance, fetchMarket } from "@/lib/research/coingecko";
import { fetchFearGreed } from "@/lib/research/fng";
import { fetchDerivs } from "@/lib/research/okx-derivs";
import { fetchHeadlines } from "@/lib/research/rss";
import {
  SOURCE_KEYS,
  type DerivMetrics,
  type FearGreed,
  type MarketMetrics,
  type SnapshotInsert,
  type SourceKey,
} from "@/lib/research/types";

/** 소스별 호출을 낱개로 받는다 — CoinGecko는 두 엔드포인트라 둘로 갈라 온다. */
export interface SettledSources {
  market: PromiseSettledResult<MarketMetrics>;
  dominance: PromiseSettledResult<number | null>;
  fng: PromiseSettledResult<FearGreed>;
  derivs: PromiseSettledResult<DerivMetrics>;
  news: PromiseSettledResult<ResearchHeadline[]>;
}

export interface CollectOutcome {
  row: SnapshotInsert;
  /** 실패한 소스 — 액션이 "일부 실패: okx, news" 메시지를 만드는 재료. */
  failed: SourceKey[];
}

function reason(result: PromiseRejectedResult): string {
  const cause = result.reason;
  return cause instanceof Error ? cause.message : String(cause);
}

/** allSettled 결과 → 스냅샷 행. 순수 함수라 실패 조합을 그대로 테스트할 수 있다. */
export function buildSnapshotRow(symbol: string, results: SettledSources): CollectOutcome {
  const { market, dominance, fng, derivs, news } = results;

  // CoinGecko는 두 호출 중 하나만 죽어도 실패로 적는다 — 살아남은 값은 그대로 싣는다.
  const coingeckoError =
    market.status === "rejected"
      ? reason(market)
      : dominance.status === "rejected"
        ? reason(dominance)
        : null;

  const sources = {
    coingecko: coingeckoError ? `error: ${coingeckoError}` : "ok",
    fng: fng.status === "rejected" ? `error: ${reason(fng)}` : "ok",
    okx: derivs.status === "rejected" ? `error: ${reason(derivs)}` : "ok",
    news: news.status === "rejected" ? `error: ${reason(news)}` : "ok",
  };

  const row: SnapshotInsert = {
    symbol,
    price_usd: market.status === "fulfilled" ? market.value.price_usd : null,
    market_cap_usd: market.status === "fulfilled" ? market.value.market_cap_usd : null,
    volume_24h_usd: market.status === "fulfilled" ? market.value.volume_24h_usd : null,
    dominance_pct: dominance.status === "fulfilled" ? dominance.value : null,
    fear_greed: fng.status === "fulfilled" ? fng.value.value : null,
    fear_greed_label: fng.status === "fulfilled" ? fng.value.label : null,
    funding_rate: derivs.status === "fulfilled" ? derivs.value.funding_rate : null,
    open_interest: derivs.status === "fulfilled" ? derivs.value.open_interest : null,
    open_interest_usd: derivs.status === "fulfilled" ? derivs.value.open_interest_usd : null,
    headlines: news.status === "fulfilled" ? news.value : [],
    sources,
  };

  return { row, failed: SOURCE_KEYS.filter((key) => sources[key] !== "ok") };
}

/** 4개 소스를 병렬로 수집한다. 전부 실패하면 throw — 저장할 것이 없다. */
export async function collectSnapshot(symbol: string): Promise<CollectOutcome> {
  const [market, dominance, fng, derivs, news] = await Promise.allSettled([
    fetchMarket(symbol),
    fetchDominance(symbol),
    fetchFearGreed(),
    fetchDerivs(symbol),
    fetchHeadlines(),
  ]);

  const outcome = buildSnapshotRow(symbol, { market, dominance, fng, derivs, news });
  if (outcome.failed.length === SOURCE_KEYS.length) {
    throw new Error(`모든 소스 수집에 실패했습니다: ${outcome.row.sources.coingecko}`);
  }
  return outcome;
}
