/**
 * CoinGecko 무료 API — 키 없이 쓴다.
 *
 * 가격·시총·거래량은 `/coins/markets`, 도미넌스(시총 점유율)는 `/global`에서 온다.
 * 무키 한도는 IP당 분당 수 회라, 수동 수집 + 일일 크론 정도의 빈도만 감당한다.
 * 한도에 걸리면 이 소스만 실패로 남고 나머지 수집은 계속된다.
 */

import type { MarketMetrics } from "@/lib/research/types";

const BASE = "https://api.coingecko.com/api/v3";

/**
 * 심볼 → CoinGecko 코인 id. CoinGecko는 티커가 아니라 자기 id로 묻는다.
 *
 * 여기 없는 심볼은 시장 데이터 없이 넘어간다 — 필요해지면 한 줄 추가가 전부다.
 */
const COIN_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XRP: "ripple",
  DOGE: "dogecoin",
};

export function toCoinGeckoId(symbol: string): string | null {
  return COIN_IDS[symbol.trim().toUpperCase()] ?? null;
}

/** 숫자가 아니면 null — 외부 응답은 형태를 믿지 않는다. */
function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `/coins/markets?vs_currency=usd&ids={id}` 응답 → 가격·시총·거래량. */
export function parseMarkets(json: unknown): MarketMetrics {
  const row = Array.isArray(json) ? (json[0] as Record<string, unknown> | undefined) : undefined;
  return {
    price_usd: asNumber(row?.current_price),
    market_cap_usd: asNumber(row?.market_cap),
    volume_24h_usd: asNumber(row?.total_volume),
  };
}

/** `/global` 응답 → 해당 심볼의 글로벌 시총 점유율(%). */
export function parseGlobal(json: unknown, symbol: string): number | null {
  if (typeof json !== "object" || json === null) return null;
  const data = (json as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return null;
  const share = (data as Record<string, unknown>).market_cap_percentage;
  if (typeof share !== "object" || share === null) return null;
  return asNumber((share as Record<string, unknown>)[symbol.trim().toLowerCase()]);
}

/**
 * 스냅샷은 "지금 값"이라 캐시하지 않고, 소스 하나가 매달리면 수집 전체가
 * 끌려가므로 10초에서 끊는다.
 */
function init(): RequestInit {
  const headers: Record<string, string> = { accept: "application/json" };
  // 무키로도 되지만, 데모 키가 있으면 한도가 넉넉해진다.
  const key = process.env.COINGECKO_API_KEY;
  if (key) headers["x-cg-demo-api-key"] = key;
  return { cache: "no-store", headers, signal: AbortSignal.timeout(10_000) };
}

export async function fetchMarket(symbol: string): Promise<MarketMetrics> {
  const id = toCoinGeckoId(symbol);
  if (!id) throw new Error(`CoinGecko id 매핑에 없는 심볼입니다: ${symbol}`);

  const res = await fetch(`${BASE}/coins/markets?vs_currency=usd&ids=${id}`, init());
  if (!res.ok) throw new Error(`CoinGecko 응답 오류 ${res.status}`);
  return parseMarkets(await res.json());
}

export async function fetchDominance(symbol: string): Promise<number | null> {
  const res = await fetch(`${BASE}/global`, init());
  if (!res.ok) throw new Error(`CoinGecko 응답 오류 ${res.status}`);
  return parseGlobal(await res.json(), symbol);
}
