/**
 * 임계점 서버 수집 보조 — OI 24시간 변화, 호가 깊이 비율(REQ-0102). OKX 공개 API, 인증 없음.
 *
 * 서버에서만 부른다(브라우저에서 부르면 CORS). 프로젝트에 'server-only' 패키지 관례가 없어 따로 막지 않는다.
 * 실패는 throw 하지 않고 `{ ok: false, reason }` 으로 돌린다 — 지표판이 소스별 사유를 그대로 보여 준다.
 * 파서는 순수 함수로 따로 둔다(응답 모양 실측 2026-11-07, 아래 각 함수 주석).
 */

import { toInstId } from "@/lib/okx";
import { THRESHOLD_RULES } from "@/lib/threshold/types";

const BASE = "https://www.okx.com/api/v5";
const DAY_MS = 86_400_000;
/** 한도(429) — okx.ts 와 같은 간격(한도 창 2초)으로 몇 번만 물러선다. */
const PAUSE_MS = 2_100;
const MAX_LIMIT_RETRIES = 2;

export type FetchResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface OiChange {
  /** 최신 1시간 칸 시작 시각(ms). */
  ts: number;
  /** 코인 개수(oiCcy) — 같은 소스 안 비율만 쓴다. */
  oiNow: number;
  oi24hAgo: number;
  /** 24시간 변화(%). */
  chgPct: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumeric(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (value === "") return null; // OKX 는 없는 값을 "" 로 준다
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dataOf(json: unknown): unknown[] | null {
  if (!isRecord(json) || !Array.isArray(json.data)) return null;
  return json.data;
}

/**
 * `/rubik/stat/contracts/open-interest-history?instId=BTC-USDT-SWAP&period=1H` 응답 → 24h OI 변화.
 * 행은 `[ts, oi(계약), oiCcy(코인), oiUsd]` 문자열, 최신부터. 코인 개수(oiCcy)를 쓴다 — USD 명목은 가격과
 * 같이 움직여 "가격 상승 + OI 증가" 판정에 가격을 두 번 센다. 최신 칸에서 정확히 24시간 앞 칸이 없으면 null.
 */
export function parseOiHistory(json: unknown): OiChange | null {
  const data = dataOf(json);
  if (data === null) return null;
  const points = new Map<number, number>();
  for (const row of data) {
    if (!Array.isArray(row)) continue;
    const ts = asNumeric(row[0]);
    const oi = asNumeric(row[2]);
    if (ts !== null && oi !== null) points.set(ts, oi);
  }
  if (points.size === 0) return null;
  const ts = Math.max(...points.keys());
  const oiNow = points.get(ts);
  const oi24hAgo = points.get(ts - DAY_MS);
  if (oiNow === undefined || oi24hAgo === undefined || !(oi24hAgo > 0)) return null;
  return { ts, oiNow, oi24hAgo, chgPct: (oiNow / oi24hAgo - 1) * 100 };
}

/**
 * `/market/books-full` (또는 `/market/books`) 응답 → 위 pct 매도 명목 ÷ 아래 pct 매수 명목.
 * 행은 `[px, sz(계약), …]` 문자열, 매도는 싼 것부터·매수는 비싼 것부터. 명목 = px × sz — 계약 단위(ctVal)는
 * 같은 종목 안 비율에서 지워진다. 기준은 최우선 매도·매수의 중간값.
 * 호가가 pct 범위 끝까지 닿지 않으면(한쪽이라도) null — 덮지 못한 깊이를 0 이나 작은 값으로 읽으면 안 된다.
 */
export function parseBookDepth(json: unknown, pct: number = THRESHOLD_RULES.depthPct): number | null {
  const first = dataOf(json)?.[0];
  if (!isRecord(first) || !Array.isArray(first.asks) || !Array.isArray(first.bids)) return null;
  const asks = levels(first.asks);
  const bids = levels(first.bids);
  if (asks.length === 0 || bids.length === 0) return null;

  const mid = (asks[0].px + bids[0].px) / 2;
  const upper = mid * (1 + pct);
  const lower = mid * (1 - pct);
  // 범위를 덮었나 — 가장 먼 호가가 경계 너머(또는 경계)에 있어야 한다.
  if (asks[asks.length - 1].px < upper || bids[bids.length - 1].px > lower) return null;

  const askUsd = asks.filter((l) => l.px <= upper).reduce((sum, l) => sum + l.px * l.sz, 0);
  const bidUsd = bids.filter((l) => l.px >= lower).reduce((sum, l) => sum + l.px * l.sz, 0);
  if (!(bidUsd > 0)) return null;
  return askUsd / bidUsd;
}

interface Level {
  px: number;
  sz: number;
}

function levels(rows: unknown[]): Level[] {
  const out: Level[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const px = asNumeric(row[0]);
    const sz = asNumeric(row[1]);
    if (px !== null && sz !== null) out.push({ px, sz });
  }
  return out;
}

async function get(path: string): Promise<FetchResult<unknown>> {
  try {
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetch(`${BASE}${path}`, {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429 && attempt < MAX_LIMIT_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
        continue;
      }
      if (!res.ok) return { ok: false, reason: `OKX 응답 오류 ${res.status}` };
      const json: unknown = await res.json();
      if (!isRecord(json) || json.code !== "0") {
        const msg = isRecord(json) ? String(json.msg || json.code) : "형식 오류";
        return { ok: false, reason: `OKX 오류: ${msg}` };
      }
      return { ok: true, value: json };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** OI 24시간 변화 — USDT 무기한 한 종목(`BTC` → `BTC-USDT-SWAP`)의 1시간 이력. */
export async function fetchOiHistory(ccy: string): Promise<FetchResult<OiChange>> {
  const instId = encodeURIComponent(toInstId(ccy));
  const res = await get(`/rubik/stat/contracts/open-interest-history?instId=${instId}&period=1H&limit=30`);
  if (!res.ok) return res;
  const value = parseOiHistory(res.value);
  return value === null ? { ok: false, reason: "OI 이력에 24시간 앞 값이 없습니다" } : { ok: true, value };
}

/**
 * 호가 깊이 비율 — 위 pct 매도 ÷ 아래 pct 매수. `/market/books?sz=400` 은 BTC 에서 ±0.06~0.07% 만 덮어
 * (실측) 0.5% 를 못 재므로 `/market/books-full?sz=5000`(±0.9% 안팎)을 쓴다. 범위를 못 덮으면 ok:false.
 */
export async function fetchBookDepth(
  instId: string,
  pct: number = THRESHOLD_RULES.depthPct,
): Promise<FetchResult<number>> {
  const res = await get(`/market/books-full?instId=${encodeURIComponent(toInstId(instId))}&sz=5000`);
  if (!res.ok) return res;
  const value = parseBookDepth(res.value, pct);
  return value === null
    ? { ok: false, reason: `호가가 ±${(pct * 100).toFixed(2)}% 를 덮지 못했습니다` }
    : { ok: true, value };
}
