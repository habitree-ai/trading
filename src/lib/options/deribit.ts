/**
 * Deribit 공개 옵션 API — BTC 옵션 북 요약·DVOL·지수가. 인증이 필요 없다.
 *
 * OKX 쪽과 나란히 두고 `types.ts` 의 OptionRow 로 정규화한다. 단위를 여기서 맞춘다 —
 * Deribit 은 IV 를 퍼센트(36.62)로, DVOL 도 퍼센트 지수(34.15)로 주므로 100 으로 나눠
 * 소수로 돌린다. OI·거래량은 이미 BTC 개수라 그대로다.
 *
 * 응답은 JSON-RPC 봉투 `{jsonrpc, result}` 이고 오류는 `{error: {code, message}}` 다.
 * 봉투 검사는 파서 안에 둔다 — 순수 함수라 픽스처만으로 오류 경로를 테스트할 수 있고,
 * `fetch*` 는 HTTP 상태만 보고 나머지는 파서에 넘기면 된다. 실측으로는 잘못된 파라미터가
 * HTTP 400 으로 먼저 걸리므로 봉투 오류는 200 인데 내용이 오류인 드문 경우를 막는 안전망이다.
 */

import type { OptionRow, OptionType } from "@/lib/options/types";

const BASE = "https://www.deribit.com/api/v2/public";

/** 종목 코드의 월 표기 — 인덱스가 곧 `Date.UTC` 의 월(0 부터). */
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** 일자는 한 자리일 수 있다(`2OCT26`). 행사가는 실측상 정수지만 일반 숫자로 받는다. */
const INSTRUMENT_RE = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/;

/** 만기 정산 시각 — Deribit 은 08:00 UTC. OKX 와 같아서 날짜 키로 합쳐진다. */
const SETTLE_HOUR_UTC = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 값은 숫자로 오지만 null 이 섞인다(high/low/price_change 등) — 유한한 숫자만 받는다. */
function asFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** JSON-RPC 봉투를 벗긴다. 오류 봉투면 throw — 호출부가 소스 실패로 기록한다. */
function unwrap(json: unknown): unknown {
  if (!isRecord(json)) return undefined;
  const error = json.error;
  if (isRecord(error)) {
    const message = typeof error.message === "string" ? error.message : String(error.code);
    throw new Error(`Deribit 오류: ${message}`);
  }
  return json.result;
}

/** `BTC-25SEP26-80000-C` → 만기·행사가·종류. 형식이 다르거나 달력에 없는 날이면 null. */
export function parseDeribitInstrumentName(
  name: string,
): { expiry: string; expiryMs: number; strike: number; type: OptionType } | null {
  const match = INSTRUMENT_RE.exec(name);
  if (!match) return null;

  const day = Number(match[1]);
  const month = MONTHS.indexOf(match[2]);
  const year = 2000 + Number(match[3]);
  const strike = Number(match[4]);
  if (month < 0 || !Number.isFinite(strike)) return null;

  // `Date.UTC` 는 31SEP 같은 날을 다음 달로 넘겨 버린다 — 넘어갔으면 형식 오류로 본다.
  const expiryMs = Date.UTC(year, month, day, SETTLE_HOUR_UTC);
  if (new Date(expiryMs).getUTCDate() !== day) return null;

  const mm = String(month + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return { expiry: `${year}-${mm}-${dd}`, expiryMs, strike, type: match[5] as OptionType };
}

/**
 * `get_book_summary_by_currency` 응답 → OptionRow 목록.
 * OI 0 인 종목과 만기가 지난 종목은 뺀다 — 분석에 기여하지 않고 합계만 흐린다.
 */
export function parseBookSummary(json: unknown, nowMs: number): OptionRow[] {
  const result = unwrap(json);
  if (!Array.isArray(result)) return [];

  const rows: OptionRow[] = [];
  for (const item of result) {
    if (!isRecord(item) || typeof item.instrument_name !== "string") continue;
    const parsed = parseDeribitInstrumentName(item.instrument_name);
    if (!parsed) continue;

    const oi = asFinite(item.open_interest);
    if (oi === null || oi <= 0) continue;
    if (parsed.expiryMs <= nowMs) continue;

    // IV 는 퍼센트로 온다. 0 은 "값 없음"이지 0% 변동성이 아니다.
    const markIvPct = asFinite(item.mark_iv);
    const markIv = markIvPct !== null && markIvPct > 0 ? markIvPct / 100 : null;

    rows.push({
      venue: "deribit",
      instId: item.instrument_name,
      expiry: parsed.expiry,
      expiryMs: parsed.expiryMs,
      strike: parsed.strike,
      type: parsed.type,
      oi,
      vol24h: asFinite(item.volume),
      markIv,
      forward: asFinite(item.underlying_price),
    });
  }
  return rows;
}

/** `get_volatility_index_data` 응답 → 마지막 봉의 종가를 소수로(34.15 → 0.3415). */
export function parseDvol(json: unknown): number | null {
  const result = unwrap(json);
  if (!isRecord(result) || !Array.isArray(result.data)) return null;

  // 오래된 것부터 오므로 마지막 행이 최신. 행은 [ts, open, high, low, close].
  const last: unknown = result.data[result.data.length - 1];
  if (!Array.isArray(last)) return null;
  const close = asFinite(last[4]);
  return close === null ? null : close / 100;
}

/** `get_index_price` 응답 → BTC-USD 지수가. */
export function parseDeribitIndexPrice(json: unknown): number | null {
  const result = unwrap(json);
  return isRecord(result) ? asFinite(result.index_price) : null;
}

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    next: { revalidate: 60 },
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Deribit 응답 오류 ${res.status}`);
  return res.json();
}

/** BTC 옵션 전 종목의 북 요약 — OI 가 있고 만기가 남은 것만. */
export async function fetchDeribitOptions(nowMs: number = Date.now()): Promise<OptionRow[]> {
  const json = await get("/get_book_summary_by_currency?currency=BTC&kind=option");
  return parseBookSummary(json, nowMs);
}

/** DVOL 최근 종가(소수). 최근 24h 를 1h 봉으로 받아 마지막 봉을 쓴다. */
export async function fetchDvol(): Promise<number | null> {
  // 창 끝을 분 단위로 내린다 — ms 까지 붙이면 URL 이 매번 달라져 revalidate 캐시가 한 번도 안 맞는다.
  const end = Math.floor(Date.now() / 60_000) * 60_000;
  const start = end - 24 * 60 * 60 * 1000;
  const json = await get(
    `/get_volatility_index_data?currency=BTC&resolution=3600&start_timestamp=${start}&end_timestamp=${end}`,
  );
  return parseDvol(json);
}

/** BTC-USD 지수가(USD) — OKX 지수가 없을 때의 대체. */
export async function fetchDeribitIndexPrice(): Promise<number | null> {
  const json = await get("/get_index_price?index_name=btc_usd");
  return parseDeribitIndexPrice(json);
}
