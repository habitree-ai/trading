/**
 * 벤치마크 — "그냥 들고만 있었어도 이만큼 됐다"를 곁에 둔다.
 *
 * 자금 곡선이 올랐다는 것만으로는 잘한 건지 알 수 없다. 시장 전체가 두 배가 된 구간에서
 * 30% 벌었다면 그건 진 것이다. 그래서 같은 기간의 BTC 가격을 우축에 겹쳐 그린다.
 *
 * 서버 전용 — OKX 공개 캔들을 직접 부른다(`/api/candles`는 브라우저용 프록시라 여기선
 * 거칠 이유가 없다). 시세는 하루 캐시되므로 대시보드를 여러 번 열어도 한 번만 나간다.
 */

import { fetchCandles, toInstId, type Candle } from "@/lib/okx";

/** 벤치마크로 쓸 종목 — 암호화폐 계좌의 기준은 BTC다. */
const BENCHMARK_SYMBOL = "BTC";

/**
 * 구간 앞뒤로 하루씩 여유를 둔다.
 *
 * 일봉은 UTC 자정에 열린다. 첫 거래가 KST 오전이면 그 거래가 속한 일봉은 전날 것이라,
 * 딱 맞춰 자르면 첫 점이 비어 곡선이 한 칸 늦게 시작한다.
 */
const PAD_MS = 24 * 60 * 60 * 1000;

/**
 * 거래 시각마다 그 시점의 BTC 종가를 찾아 준다.
 *
 * 자금 곡선의 가로축은 시간이 아니라 거래 순서다. 그래서 벤치마크도 시계열 그대로가 아니라
 * **각 거래 시점의 값**으로 찍어야 두 선이 같은 자리를 가리킨다.
 */
export interface BenchmarkLookup {
  symbol: string;
  /** 그 시각이 속한 일봉의 종가. 구간 밖이면 null */
  at: (iso: string) => number | null;
}

/**
 * 실패해도 null을 돌려준다 — 벤치마크는 곁들이는 정보다.
 *
 * 거래소가 흔들리거나 종목이 바뀌었다고 대시보드 전체가 깨지면 안 된다.
 * 없으면 그 선만 빠지고 나머지는 그대로 그려진다.
 */
export async function loadBenchmark(
  fromIso: string,
  toIso: string,
): Promise<BenchmarkLookup | null> {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;

  let candles: Candle[];
  try {
    candles = await fetchCandles(toInstId(BENCHMARK_SYMBOL), "1D", from - PAD_MS, to + PAD_MS);
  } catch {
    return null;
  }
  if (candles.length === 0) return null;

  return { symbol: BENCHMARK_SYMBOL, at: (iso) => closeAt(candles, Date.parse(iso)) };
}

/**
 * 그 시각 이하의 가장 최근 일봉 종가 — 이분 탐색.
 *
 * 캔들은 시각 오름차순이다. 거래 하나마다 전체를 훑으면 거래가 수백 건일 때 헛일이 쌓인다.
 */
function closeAt(candles: readonly Candle[], ms: number): number | null {
  if (!Number.isFinite(ms) || ms < candles[0].t) return null;

  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (candles[mid].t <= ms) lo = mid;
    else hi = mid - 1;
  }
  return candles[lo].c;
}
