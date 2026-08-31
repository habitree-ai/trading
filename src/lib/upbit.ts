/**
 * 업비트 공개 시세 REST — 서버 전용.
 *
 * 인증이 없는 시세 그룹만 쓴다(마켓 목록·캔들). 한도는 IP당 10req/s — 동시 4 × 500ms
 * 페이싱으로 그 아래에 머문다. 수집 스크립트(scripts/backtest/spot-signal-fetch.mjs)와
 * 같은 규칙이지만, 앱은 미커밋 조사 폴더를 import 할 수 없어 얇게 다시 둔다.
 */

const BASE = "https://api.upbit.com/v1";

export interface UpbitMarket {
  market: string; // KRW-BTC
  korean: string;
  /** 거래유의 — 상장폐지 후보 등. 실시간 스캔에서 제외한다. */
  warning: boolean;
  /** 주의 플래그 목록(가격 급등락 등) — 켜져 있으면 스캔에서 제외한다. */
  caution: string[];
}

/** 확정봉 [ms, 시가, 고가, 저가, 종가, 거래량] + 1D는 KRW 거래대금. */
export interface UpbitCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** candle_acc_trade_price — 일봉에서만 채운다. */
  turnover?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 네트워크·429·5xx만 재시도한다. 그 외 4xx는 요청이 틀린 것이라 즉시 던진다. */
async function fetchJson(url: string, retries = 3, baseDelayMs = 1000): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
    } catch (cause) {
      if (attempt < retries) {
        await sleep(baseDelayMs * (attempt + 1));
        continue;
      }
      throw new Error(`업비트 요청 실패: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(baseDelayMs * 1.5 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`업비트 HTTP ${res.status}: ${url.slice(0, 120)}`);
    return res.json();
  }
}

interface RawMarket {
  market: string;
  korean_name: string;
  market_event?: { warning?: boolean; caution?: Record<string, boolean> };
}

/** KRW 마켓 전체 — 플래그 포함. 스테이블 제외는 규칙(spot-signals)의 일이라 여기서 하지 않는다. */
export async function fetchKrwMarkets(): Promise<UpbitMarket[]> {
  const all = (await fetchJson(`${BASE}/market/all?is_details=true`)) as RawMarket[];
  return all
    .filter((m) => m.market.startsWith("KRW-"))
    .map((m) => {
      const caution = m.market_event?.caution ?? {};
      return {
        market: m.market,
        korean: m.korean_name,
        warning: Boolean(m.market_event?.warning),
        caution: Object.keys(caution).filter((k) => caution[k]),
      };
    });
}

interface RawCandle {
  candle_date_time_utc: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  candle_acc_trade_volume: number;
  candle_acc_trade_price?: number;
}

function toCandles(data: RawCandle[], withTurnover: boolean): UpbitCandle[] {
  // 응답은 최신순 — 오래된 순으로 뒤집는다. `to` 이후를 요청하지 않으므로 진행 중 봉은 없다.
  const out: UpbitCandle[] = [];
  for (const r of data) {
    const row: UpbitCandle = {
      t: Date.parse(`${r.candle_date_time_utc}Z`),
      o: r.opening_price,
      h: r.high_price,
      l: r.low_price,
      c: r.trade_price,
      v: r.candle_acc_trade_volume,
    };
    if (withTurnover) row.turnover = r.candle_acc_trade_price;
    out.push(row);
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * 분봉(60·240) — `to`(exclusive, ms) 이전 `count`개를 오래된 순으로.
 * `to`를 현재 봉 시가 시각으로 주면 확정봉만 온다.
 */
export async function fetchMinuteCandles(
  market: string,
  unit: 60 | 240,
  count: number,
  to?: number,
): Promise<UpbitCandle[]> {
  const toParam = to ? `&to=${new Date(to).toISOString().slice(0, 19)}Z` : "";
  const data = (await fetchJson(
    `${BASE}/candles/minutes/${unit}?market=${market}&count=${count}${toParam}`,
  )) as RawCandle[];
  return toCandles(data, false);
}

/** 일봉 — KRW 거래대금 포함. 최신 봉(오늘)은 진행 중이므로 호출자가 판단해 제외한다. */
export async function fetchDayCandles(market: string, count: number): Promise<UpbitCandle[]> {
  const data = (await fetchJson(`${BASE}/candles/days?market=${market}&count=${count}`)) as RawCandle[];
  return toCandles(data, true);
}

/**
 * 한도 아래 병렬 실행 — `concurrency`개 묶음 사이에 `pauseMs` 쉰다.
 * 실패한 항목은 던지지 않고 null 로 돌려준다(한 종목 실패가 전체 스캔을 죽이면 안 된다).
 */
export async function pacedMap<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  { concurrency = 4, pauseMs = 500 }: { concurrency?: number; pauseMs?: number } = {},
): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const results = await Promise.allSettled(chunk.map((it) => worker(it)));
    results.forEach((r, j) => {
      out[i + j] = r.status === "fulfilled" ? r.value : null;
    });
    if (i + concurrency < items.length) await sleep(pauseMs);
  }
  return out;
}
