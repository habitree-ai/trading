/**
 * OKX 공개 시세 API — 인증이 필요 없다.
 *
 * 거래 당시의 캔들을 가져와 진입·청산 시점을 차트로 되짚기 위해 쓴다.
 * 브라우저에서 직접 부르지 않고 서버 라우트로 프록시한다(CORS 회피 + 캐시).
 */

const BASE = "https://www.okx.com/api/v5";

/** OKX가 쓰는 봉 단위. 화면에 노출하는 것만 추린다. */
export const BARS = ["1m", "5m", "15m", "30m", "1H", "4H", "1D"] as const;
export type Bar = (typeof BARS)[number];

export const BAR_MS: Record<Bar, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1H": 60 * 60_000,
  "4H": 4 * 60 * 60_000,
  "1D": 24 * 60 * 60_000,
};

export interface Candle {
  /** 봉 시작 시각(ms). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** `BTC` → `BTC-USDT-SWAP`. 시트에는 기초자산만 저장하므로 여기서 무기한 계약으로 편다. */
export function toInstId(symbol: string, quote = "USDT"): string {
  const base = symbol.trim().toUpperCase();
  if (/-(SWAP|USDT|USDC)/.test(base)) return base; // 이미 완전한 instId
  return `${base}-${quote}-SWAP`;
}

/**
 * 거래 구간에 맞는 봉 단위를 고른다.
 *
 * 몇 분짜리 스캘핑을 일봉으로 보면 점 하나가 되고, 며칠짜리 스윙을 1분봉으로 보면
 * 수천 개가 된다. 구간이 40~120개 봉에 담기는 단위를 고른다.
 */
export function pickBar(durationMs: number, targetCount = 60): Bar {
  let best: Bar = BARS[0];
  let bestGap = Infinity;

  for (const bar of BARS) {
    const count = durationMs / BAR_MS[bar];
    const gap = Math.abs(count - targetCount);
    // 동점이면 앞쪽(더 촘촘한 봉)을 남긴다.
    if (gap < bestGap) {
      bestGap = gap;
      best = bar;
    }
  }
  return best;
}

interface OkxResponse {
  code: string;
  msg: string;
  data: string[][];
}

/**
 * `[from, to]` 구간의 캔들을 가져온다.
 *
 * OKX는 한 번에 100개까지만 주고 최신순으로 돌려주므로, 구간을 채울 때까지
 * `after`를 옮겨 가며 뒤로 훑는다. 무한 루프를 막기 위해 페이지 수를 제한한다.
 */
export async function fetchCandles(
  instId: string,
  bar: Bar,
  from: number,
  to: number,
  maxPages = 4,
): Promise<Candle[]> {
  const out = new Map<number, Candle>();
  let cursor = to;

  for (let page = 0; page < maxPages; page += 1) {
    const url = `${BASE}/market/history-candles?instId=${encodeURIComponent(
      instId,
    )}&bar=${bar}&after=${cursor}&limit=100`;

    const res = await fetch(url, {
      // 지나간 캔들은 변하지 않는다 — 하루 캐시.
      next: { revalidate: 86_400 },
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`OKX 응답 오류 ${res.status}`);

    const json = (await res.json()) as OkxResponse;
    if (json.code !== "0") throw new Error(`OKX 오류: ${json.msg || json.code}`);
    if (json.data.length === 0) break;

    let oldest = cursor;
    for (const row of json.data) {
      const t = Number(row[0]);
      oldest = Math.min(oldest, t);
      if (t >= from && t <= to) {
        out.set(t, { t, o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]) });
      }
    }

    if (oldest <= from) break;
    cursor = oldest;
  }

  return [...out.values()].sort((a, b) => a.t - b.t);
}

/**
 * 차트에 보여줄 구간을 정한다 — 거래 전후로 여유를 둬야 맥락이 보인다.
 *
 * 진입/청산만 딱 잘라 보여주면 "그때 시장이 어땠는지"를 알 수 없다.
 */
export function windowFor(
  entryMs: number,
  exitMs: number | null,
  bar: Bar,
  padBars = 24,
): { from: number; to: number } {
  const end = exitMs ?? entryMs;
  const pad = BAR_MS[bar] * padBars;
  return { from: entryMs - pad, to: end + pad };
}
