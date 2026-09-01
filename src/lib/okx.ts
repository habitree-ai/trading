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
  /** 거래량(계약 수). 절대값이 아니라 평균 대비 몇 배인지를 읽는 용도다. */
  v: number;
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

/** OKX가 한 번에 돌려주는 최대 개수. */
const PAGE_SIZE = 100;

/**
 * 한 구간에 허용하는 최대 페이지 수 — 4000봉.
 *
 * 15분봉이면 41일치다. 한 달 넘게 들고 있던 거래도 진입 지점까지 닿는다.
 * 그보다 긴 보유를 15분봉으로 보는 건 어차피 픽셀당 봉이 여러 개라 읽히지 않는다.
 */
export const MAX_CANDLE_PAGES = 40;

/**
 * 한꺼번에 띄우는 요청 수.
 *
 * OKX 공개 시세는 IP당 20회/2초다. 그 절반으로 잡아 같은 화면의 다른 호출과
 * 부딪히지 않을 여유를 남긴다.
 */
const BATCH = 8;

/**
 * 받아야 할 페이지들의 `after` 커서를 미리 계산한다.
 *
 * 예전에는 응답을 보고 다음 커서를 정했다. 그러면 페이지 수만큼 왕복이 순서대로 쌓여,
 * 15분봉으로 2주짜리 거래를 보려면 15번을 차례로 기다려야 했다 — 그래서 상한을 12로
 * 묶어 뒀고, 긴 거래는 진입 지점에 닿지 못한 채 잘렸다.
 *
 * 봉 간격이 고정이라 커서는 계산으로 나온다. 미리 알면 한꺼번에 띄울 수 있다.
 * 거래가 없어 봉이 빠진 구간에서는 페이지가 겹치거나 덜 오는데, 받은 캔들을 시각으로
 * 묶어 담으므로 겹침은 저절로 지워지고 빈 곳은 그냥 비어 온다.
 */
export function candleCursors(
  bar: Bar,
  from: number,
  to: number,
  maxPages = MAX_CANDLE_PAGES,
): number[] {
  const span = BAR_MS[bar] * PAGE_SIZE;
  const needed = Math.ceil((to - from) / span);
  const pages = Math.min(Math.max(needed, 1), Math.max(maxPages, 1));
  return Array.from({ length: pages }, (_, i) => to - i * span);
}

async function fetchPage(instId: string, bar: Bar, after: number): Promise<string[][]> {
  const url = `${BASE}/market/history-candles?instId=${encodeURIComponent(
    instId,
  )}&bar=${bar}&after=${after}&limit=${PAGE_SIZE}`;

  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, {
      // 지나간 캔들은 변하지 않는다 — 하루 캐시.
      next: { revalidate: 86_400 },
      headers: { accept: "application/json" },
    });

    /*
     * 한도(IP당 20회/2초) 초과 — 4분할처럼 여러 창이 콜드 캐시에서 동시에 당기면
     * 나온다. 429 는 캐시에 남지 않으므로, 한도 창(2초)을 넘겨 다시 부르면 된다.
     * 두 번 물러서도 안 되면 그때는 진짜 문제다 — 오류로 올린다.
     */
    if (res.status === 429 && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 2_100 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`OKX 응답 오류 ${res.status}`);

    const json = (await res.json()) as OkxResponse;
    if (json.code !== "0") throw new Error(`OKX 오류: ${json.msg || json.code}`);
    return json.data;
  }
}

/** `[from, to]` 구간의 캔들을 가져온다. 페이지는 묶어서 동시에 받는다. */
export async function fetchCandles(
  instId: string,
  bar: Bar,
  from: number,
  to: number,
  maxPages = MAX_CANDLE_PAGES,
): Promise<Candle[]> {
  const cursors = candleCursors(bar, from, to, maxPages);
  const out = new Map<number, Candle>();

  for (let i = 0; i < cursors.length; i += BATCH) {
    const batch = await Promise.all(
      cursors.slice(i, i + BATCH).map((after) => fetchPage(instId, bar, after)),
    );

    for (const rows of batch) {
      for (const row of rows) {
        const t = Number(row[0]);
        if (t >= from && t <= to) {
          out.set(t, {
            t,
            o: Number(row[1]),
            h: Number(row[2]),
            l: Number(row[3]),
            c: Number(row[4]),
            v: Number(row[5]),
          });
        }
      }
    }
  }

  return [...out.values()].sort((a, b) => a.t - b.t);
}

/**
 * 차트에 보여줄 구간을 정한다 — 거래 전후로 여유를 둬야 맥락이 보인다.
 *
 * 진입/청산만 딱 잘라 보여주면 "그때 시장이 어땠는지"를 알 수 없다.
 *
 * 끝을 부르는 쪽이 정한다. 청산된 거래는 청산 시각이지만, 아직 들고 있는 거래는
 * **지금**이다 — 진입 시각으로 자르면 들어간 뒤 시세가 어디로 갔는지가 화면에서
 * 통째로 빠진다. 시계를 읽는 건 순수하지 않아 여기서 하지 않는다.
 */
export function windowFor(
  entryMs: number,
  endMs: number,
  bar: Bar,
  padBars = 24,
): { from: number; to: number } {
  const pad = BAR_MS[bar] * padBars;
  return { from: entryMs - pad, to: Math.max(entryMs, endMs) + pad };
}

/**
 * 봉 눈금에 맞춰 내림 — 아직 들고 있는 거래의 끝을 정할 때 쓴다.
 *
 * `지금`을 밀리초 그대로 쓰면 새로고침할 때마다 페이지 커서가 달라져 캐시가 통째로
 * 빗나간다. 봉 하나만큼 뭉뚱그리면 같은 봉 안에서는 같은 요청이 된다.
 */
export function floorToBar(ms: number, bar: Bar): number {
  return Math.floor(ms / BAR_MS[bar]) * BAR_MS[bar];
}

/**
 * 지금(ms) — 아직 들고 있는 거래의 차트를 어디까지 그릴지 정하는 데 쓴다.
 *
 * 렌더 중에 시계를 직접 읽으면 순수성 검사에 걸린다. 서버가 페이지를 그리는 시점에
 * 한 번 읽어 내려보내면 서버와 브라우저가 같은 값을 보게 되고(하이드레이션이 어긋나지
 * 않는다), 그 사이 흐른 시간은 앞뒤 여유 봉이 이미 넉넉히 덮는다.
 */
export function nowMs(): number {
  return Date.now();
}
