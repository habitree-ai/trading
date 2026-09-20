/**
 * OKX BTC 옵션 파서·수집기 — 공개 API 여덟 개를 `OptionRow`·이력·흐름으로 편다. 키가 필요 없다.
 *
 * 파서(순수 함수)와 fetch 를 한 파일에 둔 이유: 응답이 전부 문자열이고 빈 값은 `""` 로 오며
 * 필드가 빠질 수 있어 파서가 응답 모양을 다 알아야 하는데, fetch 는 그 파서를 부르는 얇은
 * 껍데기라 나누면 오히려 흩어진다. 테스트는 파서만 — 실측 응답을 줄인 픽스처로 돈다.
 *
 * `@/lib/research/okx-derivs` 와 base·오류 문구를 맞추되 캐시는 다르다. 그쪽은 스냅샷을
 * 저장하니 no-store, 여기는 화면이 직접 부르니 revalidate 60(캔들은 300) 으로 OKX 한도를 아낀다.
 *
 * 단위는 `types.ts` 가 정한 대로 — OI·거래량은 BTC 개수(`oiCcy`·`volCcy24h`), IV 는 소수,
 * 가격은 USD. 계약수(`oi`·`vol24h`)는 0.01 BTC 단위라 여기서 쓰지 않는다.
 */

import type { OkxHistoryPoint, OptionRow, OptionType, TakerBlockFlow } from "@/lib/options/types";

const BASE = "https://www.okx.com/api/v5";

interface OkxEnvelope {
  code: string;
  msg: string;
  data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 문자열 숫자 → 숫자. OKX 는 없는 값을 `""` 로 주므로(`last`, `buyApr`) 빈 문자열은 0 이 아니라 null 이다. */
function asNumeric(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 봉투의 `data` 배열 — 봉투가 아니거나 배열이 아니면 빈 배열. */
function dataArray(json: unknown): unknown[] {
  if (!isRecord(json)) return [];
  const data = json.data;
  return Array.isArray(data) ? data : [];
}

/** `data` 행을 `instId` 로 찾는 표 — 종목별 엔드포인트 세 개를 조인하는 재료. */
function byInstId(json: unknown): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const row of dataArray(json)) {
    if (isRecord(row) && typeof row.instId === "string") map.set(row.instId, row);
  }
  return map;
}

/** `[ts, a, b]` 문자열 행 → 숫자 셋. rubik 이력 두 엔드포인트가 이 모양이다. */
function numericTriple(row: unknown): [number, number, number] | null {
  if (!Array.isArray(row) || row.length < 3) return null;
  const ts = asNumeric(row[0]);
  const a = asNumeric(row[1]);
  const b = asNumeric(row[2]);
  if (ts === null || a === null || b === null) return null;
  return [ts, a, b];
}

/* ── 파서 ────────────────────────────────────────────────── */

/** `BTC-USD-260925-80000-C` — 기초자산-정산통화-YYMMDD-행사가-C|P. */
const INST_ID = /^[A-Z]+-[A-Z]+-(\d{2})(\d{2})(\d{2})-(\d+)-([CP])$/;

/**
 * OKX 종목 코드 → 만기·행사가·종류. 형식이 다르면 null.
 * 만기 시각은 08:00 UTC 정산 — Deribit 과 같은 시각이라 날짜 키로 합쳐진다.
 */
export function parseOkxInstId(
  instId: string,
): { expiry: string; expiryMs: number; strike: number; type: OptionType } | null {
  const match = INST_ID.exec(instId);
  if (!match) return null;

  const [, yy, mm, dd, strikeText, typeText] = match;
  const year = 2000 + Number(yy);
  const strike = Number(strikeText);
  if (strike <= 0) return null;

  return {
    expiry: `${year}-${mm}-${dd}`,
    expiryMs: Date.UTC(year, Number(mm) - 1, Number(dd), 8),
    strike,
    type: typeText === "C" ? "C" : "P",
  };
}

/**
 * open-interest · opt-summary · tickers 를 instId 로 조인해 `OptionRow` 로 편다.
 *
 * open-interest 가 기준이다 — 상장 종목 전부(만기 지난 것 포함)를 주고 대부분 OI 0 이라
 * `oiCcy ≤ 0` 과 만기 지난 행을 여기서 걸러야 아래 계산이 가벼워진다. summary·tickers 에
 * 없는 종목은 IV·선도·거래량만 null 로 두고 살린다 — OI 는 있으니 분포에는 들어가야 한다.
 */
export function parseOkxOptionRows(
  input: { oi: unknown; summary: unknown; tickers: unknown },
  nowMs: number,
): OptionRow[] {
  const summaries = byInstId(input.summary);
  const tickers = byInstId(input.tickers);
  const rows: OptionRow[] = [];

  for (const row of dataArray(input.oi)) {
    if (!isRecord(row) || typeof row.instId !== "string") continue;
    const oi = asNumeric(row.oiCcy);
    if (oi === null || oi <= 0) continue;
    const parsed = parseOkxInstId(row.instId);
    if (!parsed || parsed.expiryMs <= nowMs) continue;

    const summary = summaries.get(row.instId);
    const markVol = asNumeric(summary?.markVol);
    rows.push({
      venue: "okx",
      instId: row.instId,
      ...parsed,
      oi,
      vol24h: asNumeric(tickers.get(row.instId)?.volCcy24h),
      // IV 0 은 "값 없음" 이다 — 만기 직전 종목에 0 이 찍힌다.
      markIv: markVol !== null && markVol > 0 ? markVol : null,
      forward: asNumeric(summary?.fwdPx),
    });
  }
  return rows;
}

/**
 * rubik OI·거래량 이력과 풋콜비 이력을 ts 로 조인해 오래된 것부터 정렬한다.
 * 두 응답은 각각 최신이 먼저 오고 행 수가 같지만 창이 어긋날 수 있어, 한쪽에만 있는 ts 는 버린다.
 */
export function parseOkxHistory(oiVol: unknown, ratio: unknown): OkxHistoryPoint[] {
  const ratios = new Map<number, [number, number]>();
  for (const row of dataArray(ratio)) {
    const triple = numericTriple(row);
    if (triple) ratios.set(triple[0], [triple[1], triple[2]]);
  }

  const points: OkxHistoryPoint[] = [];
  for (const row of dataArray(oiVol)) {
    const triple = numericTriple(row);
    if (!triple) continue;
    const [t, oi, vol] = triple;
    const pcr = ratios.get(t);
    // OKX 의 oiRatio·volRatio 는 **콜/풋**이다(2026-09-20 실측: 만기별 콜·풋 OI 합의 콜/풋
    // 0.8381 = oiRatio 0.8381). 화면·타일은 풋/콜이라 여기서 뒤집는다. 0 이면 비율이 아니다.
    if (!pcr || !(pcr[0] > 0) || !(pcr[1] > 0)) continue;
    points.push({ t, oi, vol, pcrOi: 1 / pcr[0], pcrVol: 1 / pcr[1] });
  }
  return points.sort((a, b) => a.t - b.t);
}

/**
 * taker-block-volume → 일간 흐름. `ts` 는 봉의 **끝**(UTC+8 자정 = 16:00 UTC)이고 값은 그 앞
 * 하루치 확정값이다(실측: 1D 값 = 직전 8H 세 봉의 합, 30분 동안 다시 불러도 불변).
 * `data` 가 봉투 안에 **납작한 배열 하나**로 온다
 * (`["ts", callBuy, callSell, putBuy, putSell, callBlock, putBlock]`). 문서와 달리 2차원이
 * 아니지만 언제 바뀔지 모르니, 첫 원소가 배열이면 그 행을 쓴다.
 */
export function parseTakerBlock(json: unknown): TakerBlockFlow | null {
  const data = dataArray(json);
  const first: unknown = data[0];
  const row: unknown[] = Array.isArray(first) ? first : data;
  if (row.length < 7) return null;

  const values: number[] = [];
  for (const cell of row.slice(0, 7)) {
    const value = asNumeric(cell);
    if (value === null) return null;
    values.push(value);
  }
  const [ts, callBuy, callSell, putBuy, putSell, callBlock, putBlock] = values;
  return { ts, callBuy, callSell, putBuy, putSell, callBlock, putBlock };
}

/** `/market/index-tickers` 응답 → 지수가(USD). */
export function parseOkxIndexPrice(json: unknown): number | null {
  const first: unknown = dataArray(json)[0];
  return isRecord(first) ? asNumeric(first.idxPx) : null;
}

/**
 * `/market/candles` 응답 → 마감 봉 종가, 오래된 것부터.
 * 행은 `[ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]` 이고 최신이 먼저다. 진행 중인 봉
 * (confirm "0") 은 값이 계속 바뀌므로 실현변동성 재료에서 뺀다.
 */
export function parseDailyCloses(json: unknown): number[] {
  const closes: [number, number][] = [];
  for (const row of dataArray(json)) {
    if (!Array.isArray(row) || row[8] !== "1") continue;
    const ts = asNumeric(row[0]);
    const close = asNumeric(row[4]);
    if (ts !== null && close !== null) closes.push([ts, close]);
  }
  return closes.sort((a, b) => a[0] - b[0]).map(([, close]) => close);
}

/* ── 수집 ────────────────────────────────────────────────── */

async function get(path: string, revalidate = 60): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    next: { revalidate },
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OKX 응답 오류 ${res.status}`);

  const json = (await res.json()) as OkxEnvelope;
  if (json.code !== "0") throw new Error(`OKX 오류: ${json.msg || json.code}`);
  return json;
}

/**
 * 옵션 종목·흐름·이력을 한 번에. 여섯 호출을 Promise.all 로 묶어 하나라도 죽으면 전체가
 * 실패한다 — 종목 없이 이력만 있는 반쪽 결과는 화면이 다룰 게 없어서 단순하게 둔다.
 */
export async function fetchOkxOptions(
  nowMs = Date.now(),
): Promise<{ rows: OptionRow[]; flow: TakerBlockFlow | null; history: OkxHistoryPoint[] }> {
  const [oi, summary, tickers, oiVol, ratio, taker] = await Promise.all([
    get("/public/open-interest?instType=OPTION&instFamily=BTC-USD"),
    get("/public/opt-summary?instFamily=BTC-USD"),
    get("/market/tickers?instType=OPTION&instFamily=BTC-USD"),
    get("/rubik/stat/option/open-interest-volume?ccy=BTC&period=8H"),
    get("/rubik/stat/option/open-interest-volume-ratio?ccy=BTC&period=8H"),
    get("/rubik/stat/option/taker-block-volume?ccy=BTC&period=1D"),
  ]);

  const rows = parseOkxOptionRows({ oi, summary, tickers }, nowMs);
  // `code 0` 에 빈 data 로 오는 반쪽 응답 — 종목은 있는데 거래량·IV 가 전부 비면 합산에서
  // 0 으로 읽힌다. OKX 는 한 묶음이라(위 Promise.all) 소스 전체를 실패로 돌린다.
  if (rows.length > 0 && rows.every((row) => row.vol24h === null)) {
    throw new Error("OKX tickers 응답에 거래량이 없습니다");
  }
  if (rows.length > 0 && rows.every((row) => row.markIv === null)) {
    throw new Error("OKX opt-summary 응답에 IV 가 없습니다");
  }

  return { rows, flow: parseTakerBlock(taker), history: parseOkxHistory(oiVol, ratio) };
}

export async function fetchOkxIndexPrice(): Promise<number | null> {
  return parseOkxIndexPrice(await get("/market/index-tickers?instId=BTC-USD"));
}

/** 최근 일봉 마감 종가, 오래된 것부터. 지난 봉은 변하지 않으니 캐시를 길게(300초) 둔다. */
export async function fetchOkxDailyCloses(limit = 32): Promise<number[]> {
  return parseDailyCloses(
    await get(`/market/candles?instId=BTC-USDT-SWAP&bar=1D&limit=${limit}`, 300),
  );
}
