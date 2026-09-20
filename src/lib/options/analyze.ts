/**
 * 옵션 분석 — 스냅샷(원재료)을 화면이 그대로 그리는 숫자로 바꾼다.
 *
 * 전부 순수 함수다. 시각은 `nowMs` 로 밖에서 받는다 — 같은 스냅샷·같은 시각이면 같은
 * 결과가 나와야 테스트와 복기가 된다. 재료가 없으면 null 을 돌린다. 0 은 "없음"이 아니라
 * 값이라서, 두 개를 섞으면 화면이 "OI 0" 과 "수집 실패" 를 구분하지 못한다.
 *
 * 지표마다 재료의 범위가 다르다 — 이 구분이 이 파일의 핵심이다.
 * - OI·거래량·맥스페인·벽: 두 거래소 **합산**. 정산통화(BTC)가 같아 그냥 더한다.
 * - IV 지표(ATM IV·25Δ RR·기간구조·선도가): 거래소 **하나**(`ivVenue`)만. 두 거래소의
 *   마크 IV 는 산출 방식이 달라 섞으면 스마일이 톱니가 된다. Deribit 이 BTC 옵션의
 *   기준 시장이라 우선, 없으면 OKX.
 * - GEX: OI 가중 합산 지표라 markIv 가 있는 **모든 행**(두 거래소)을 쓴다.
 */

import { bsDelta, bsGamma } from "@/lib/options/bs";
import type {
  ExpirySummary,
  GexRow,
  IvTermPoint,
  OptionRow,
  OptionVenue,
  OptionsAnalysis,
  OptionsSnapshot,
  StrikeRow,
  VenueTotals,
} from "@/lib/options/types";

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
const TRADING_DAYS = 365;

/** IV 지표의 기준 거래소 — 앞이 우선. */
const IV_VENUE_PRIORITY: readonly OptionVenue[] = ["deribit", "okx"];
/** byVenue 는 행이 없는 거래소도 0 으로 넣는다 — 화면이 열을 고정으로 그린다. */
const VENUES: readonly OptionVenue[] = ["okx", "deribit"];

type RowWithIv = OptionRow & { markIv: number };

function hasIv(row: OptionRow): row is RowWithIv {
  return row.markIv !== null;
}

/* ── 순수 helper ─────────────────────────────────────────── */

/**
 * 헤드라인 "근월" 의 최소 잔여일.
 *
 * 만기 하루 이틀 앞 종목은 T 가 0 에 가까워 델타가 극단으로 몰리고 ATM IV·25Δ 스큐가
 * 잡음이 된다(실측: D-1 RR +6.1%p, 다음 만기 null·+3.3%p). 한눈에 타일과 해석 문구는
 * 일주일 이상 남은 첫 만기를 쓴다 — 표에는 전 만기가 그대로 있다.
 */
export const HEADLINE_MIN_DTE = 7;

/**
 * 화면의 D-day(올림)가 `minDte` 이상인 첫 점. 그런 점이 없으면 첫 점(있다면). 만기 오름차순을
 * 전제한다. 올림을 쓰는 이유 — 표에 「D-7」로 찍힌 만기가 "D-7 이상 첫 만기"에서 빠지면 안 된다.
 */
export function pickHeadline<T extends { dte: number }>(points: T[], minDte = HEADLINE_MIN_DTE): T | null {
  return points.find((point) => Math.ceil(point.dte) >= minDte) ?? points[0] ?? null;
}

/** 풋/콜 비율. 콜이 0 이면 비율이 아니라 null 이다. */
export function putCallRatio(put: number, call: number): number | null {
  return call > 0 ? put / call : null;
}

/**
 * 맥스페인 — 만기 시 옵션 보유자 총 지급액(payout)이 최소가 되는 행사가.
 * payout(K) = Σ callOi·max(0, K − strike) + Σ putOi·max(0, strike − K). 후보는 행사가 집합,
 * 동률이면 작은 K. OI 합이 0 이면 null. BTC 개수 그대로 곱한다 — 정산통화가 같아 환산이 없다.
 */
export function maxPain(rows: StrikeRow[]): number | null {
  const totalOi = rows.reduce((sum, row) => sum + row.callOi + row.putOi, 0);
  if (totalOi <= 0) return null;

  const strikes = [...new Set(rows.map((row) => row.strike))].sort((a, b) => a - b);
  let best: number | null = null;
  let bestPayout = Infinity;
  for (const k of strikes) {
    let payout = 0;
    for (const row of rows) {
      payout += row.callOi * Math.max(0, k - row.strike) + row.putOi * Math.max(0, row.strike - k);
    }
    // 엄격한 < 라 동률이면 먼저 본(작은) K 가 남는다.
    if (payout < bestPayout) {
      bestPayout = payout;
      best = k;
    }
  }
  return best;
}

/**
 * ATM IV — markIv 가 있는 행 중 forward 에 가장 가까운 행사가의 콜·풋 IV 평균(하나만 있으면
 * 그것). 같은 만기·같은 거래소 행을 넘겨야 한다. 거리 동률이면 작은 행사가.
 */
export function atmIv(rows: OptionRow[], forward: number): number | null {
  const withIv = rows.filter(hasIv);
  if (withIv.length === 0) return null;

  let atmStrike = withIv[0].strike;
  let bestDistance = Math.abs(atmStrike - forward);
  for (const row of withIv) {
    const distance = Math.abs(row.strike - forward);
    if (distance < bestDistance || (distance === bestDistance && row.strike < atmStrike)) {
      bestDistance = distance;
      atmStrike = row.strike;
    }
  }
  const ivs = withIv.filter((row) => row.strike === atmStrike).map((row) => row.markIv);
  return ivs.reduce((sum, iv) => sum + iv, 0) / ivs.length;
}

interface DeltaIv {
  delta: number;
  iv: number;
}

/** 델타 오름차순 점들에서 target 을 양쪽에서 감싸는 두 점 사이 선형보간. 못 감싸면 null. */
function interpolateIvAtDelta(points: DeltaIv[], target: number): number | null {
  const sorted = [...points].sort((a, b) => a.delta - b.delta);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const lo = sorted[i];
    const hi = sorted[i + 1];
    if (lo.delta <= target && target <= hi.delta) {
      if (hi.delta === lo.delta) return lo.iv;
      const w = (target - lo.delta) / (hi.delta - lo.delta);
      return lo.iv + w * (hi.iv - lo.iv);
    }
  }
  return null;
}

/**
 * 25Δ 리스크 리버설 = IV(25Δ 콜) − IV(25Δ 풋). 각 행의 델타는 그 행의 markIv 로 낸 BS 델타.
 * 콜은 0.25, 풋은 −0.25 를 감싸는 두 점 사이 보간 — 감싸는 점이 없으면(행사가가 좁거나
 * 만기 직전) null. 외삽하면 스마일이 없는 곳의 숫자를 지어내게 된다.
 */
export function riskReversal25(rows: OptionRow[], forward: number, T: number): number | null {
  const calls: DeltaIv[] = [];
  const puts: DeltaIv[] = [];
  for (const row of rows) {
    if (!hasIv(row)) continue;
    const delta = bsDelta(row.type, forward, row.strike, row.markIv, T);
    if (delta === null) continue;
    (row.type === "C" ? calls : puts).push({ delta, iv: row.markIv });
  }
  const callIv = interpolateIvAtDelta(calls, 0.25);
  const putIv = interpolateIvAtDelta(puts, -0.25);
  if (callIv === null || putIv === null) return null;
  return callIv - putIv;
}

/** GEX 한 다리 — Γ 를 낼 재료(IV·잔여기간)를 갖춘 행만 여기까지 온다. */
interface GexLeg {
  strike: number;
  /** 콜 +1, 풋 −1 — 딜러가 콜 롱(고객이 콜 매도)·풋 숏(고객이 풋 매수)이라는 관례 부호. */
  sign: 1 | -1;
  oi: number;
  iv: number;
  T: number;
  /** Γ 의 S — 행의 선도가, 없으면 현물. */
  S: number;
}

/**
 * 현물이 `spot` 일 때 이 다리의 GEX(USD / 현물 1% 변동). Γ 를 못 구하면 null.
 *
 * Γ 는 선도가 S(=F) 기준(Black-76)이라 현물 기준 감마는 Γ_F·F/S 다. 그래서 현물 1% 의 헤지
 * USD 는 Γ_F·OI·(F/S)·S²·0.01 = Γ_F·OI·F·S·0.01 — spot² 을 곱하면 원월에서 F/S 만큼(오늘 최대
 * 3.8%) 작아진다. OKX gammaBS ÷ 우리 Γ_F 가 만기마다 정확히 F/S 인 것으로 확인했다.
 */
function legGex(leg: GexLeg, S: number, spot: number): number | null {
  const gamma = bsGamma(S, leg.strike, leg.iv, leg.T);
  if (gamma === null) return null;
  return leg.sign * gamma * leg.oi * S * spot * 0.01;
}

/**
 * 감마 익스포저 — 행마다 gex = (콜 +1 / 풋 −1) × Γ × OI × spot² × 0.01 (USD / 현물 1% 변동).
 * IV 가 없거나 만기가 지난 행은 건너뛴다. byStrike 는 행사가 오름차순 합, total 은 전체 합
 * (다리가 하나도 없으면 null).
 *
 * flipStrike: 현물을 후보 행사가로 바꿔 넣고(각 다리의 S 를 그 후보로, T·IV 는 그대로)
 * 총 GEX 를 다시 계산해, 후보 오름차순에서 부호가 바뀌는 인접 쌍을 선형보간한 가격.
 * 교차가 여럿이면 현재가에서 가장 가까운 것. 후보는 byStrike 의 행사가.
 */
export function gammaExposure(
  rows: OptionRow[],
  spot: number,
  nowMs: number,
): { total: number | null; byStrike: GexRow[]; flipStrike: number | null } {
  const legs: GexLeg[] = [];
  for (const row of rows) {
    if (!hasIv(row)) continue;
    const T = (row.expiryMs - nowMs) / YEAR_MS;
    if (T <= 0) continue;
    legs.push({
      strike: row.strike,
      sign: row.type === "C" ? 1 : -1,
      oi: row.oi,
      iv: row.markIv,
      T,
      S: row.forward ?? spot,
    });
  }

  const byStrikeMap = new Map<number, number>();
  let total: number | null = null;
  for (const leg of legs) {
    const gex = legGex(leg, leg.S, spot);
    if (gex === null) continue;
    byStrikeMap.set(leg.strike, (byStrikeMap.get(leg.strike) ?? 0) + gex);
    total = (total ?? 0) + gex;
  }
  const byStrike: GexRow[] = [...byStrikeMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([strike, gex]) => ({ strike, gex }));

  return { total, byStrike, flipStrike: findFlipStrike(legs, byStrike, spot) };
}

function findFlipStrike(legs: GexLeg[], byStrike: GexRow[], spot: number): number | null {
  const candidates = byStrike.map((row) => row.strike);
  // 후보 K 마다 "현물이 K 였다면"의 총 GEX.
  const totals = candidates.map((k) =>
    legs.reduce((sum, leg) => sum + (legGex(leg, k, k) ?? 0), 0),
  );

  const crossings: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const a = totals[i];
    if (a === 0) {
      crossings.push(candidates[i]);
    } else if (i + 1 < candidates.length && Math.sign(a) * Math.sign(totals[i + 1]) < 0) {
      // a + w·(b − a) = 0 인 w 로 두 행사가 사이를 자른다.
      const b = totals[i + 1];
      const w = a / (a - b);
      crossings.push(candidates[i] + w * (candidates[i + 1] - candidates[i]));
    }
  }
  if (crossings.length === 0) return null;
  return crossings.reduce((best, k) => (Math.abs(k - spot) < Math.abs(best - spot) ? k : best));
}

/**
 * 실현변동성 — 마지막 window 개 로그수익률의 표본 표준편차(n − 1) × √365, 소수.
 * 종가가 window + 1 개 미만이면 null. 0 이하 종가가 끼면 로그가 깨지므로 null.
 */
export function realizedVol(closes: number[], window = 30): number | null {
  if (window < 2 || closes.length < window + 1) return null;
  const tail = closes.slice(-(window + 1));
  const returns: number[] = [];
  for (let i = 1; i < tail.length; i++) {
    if (!(tail[i - 1] > 0) || !(tail[i] > 0)) return null;
    returns.push(Math.log(tail[i] / tail[i - 1]));
  }
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) * (r - mean), 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
}

/* ── 조립 ────────────────────────────────────────────────── */

function pickIvVenue(rows: OptionRow[]): OptionVenue | null {
  for (const venue of IV_VENUE_PRIORITY) {
    if (rows.some((row) => row.venue === venue && hasIv(row))) return venue;
  }
  return null;
}

/** 행사가별 콜·풋 OI 합, 행사가 오름차순. */
function aggregateStrikes(rows: OptionRow[]): StrikeRow[] {
  const map = new Map<number, StrikeRow>();
  for (const row of rows) {
    const entry = map.get(row.strike) ?? { strike: row.strike, callOi: 0, putOi: 0 };
    if (row.type === "C") entry.callOi += row.oi;
    else entry.putOi += row.oi;
    map.set(row.strike, entry);
  }
  return [...map.values()].sort((a, b) => a.strike - b.strike);
}

/** OI 최대 행사가. 후보가 없거나 OI 가 전부 0 이면 벽이 아니다 — null. */
function heaviestStrike(rows: StrikeRow[], side: "callOi" | "putOi"): number | null {
  let best: number | null = null;
  let bestOi = 0;
  for (const row of rows) {
    if (row[side] > bestOi) {
      bestOi = row[side];
      best = row.strike;
    }
  }
  return best;
}

function findWalls(
  all: StrikeRow[],
  spot: number | null,
): { callWall: number | null; putWall: number | null } {
  // 기준가가 없으면 "위/아래" 가 없다 — 전체 최대를 벽이라 부르면 현재가 아래 콜벽이 그려진다.
  if (spot === null) return { callWall: null, putWall: null };
  const above = all.filter((row) => row.strike > spot);
  const below = all.filter((row) => row.strike < spot);
  return { callWall: heaviestStrike(above, "callOi"), putWall: heaviestStrike(below, "putOi") };
}

function sumOi(rows: OptionRow[]): number {
  return rows.reduce((sum, row) => sum + row.oi, 0);
}

function sumVol(rows: OptionRow[]): number {
  return rows.reduce((sum, row) => sum + (row.vol24h ?? 0), 0);
}

function summarizeExpiry(
  expiry: string,
  rows: OptionRow[],
  ivVenue: OptionVenue | null,
  spot: number | null,
  nowMs: number,
): ExpirySummary {
  const calls = rows.filter((row) => row.type === "C");
  const puts = rows.filter((row) => row.type === "P");
  const callOi = sumOi(calls);
  const putOi = sumOi(puts);
  const expiryMs = rows[0].expiryMs;
  const dte = Math.max(0, (expiryMs - nowMs) / DAY_MS);
  const T = dte / TRADING_DAYS;

  // IV 지표는 기준 거래소 행만 — 선도가도 그 행들의 것. 계산의 기준점(ref)은 선도가가 없으면
  // 현물로 대신하지만, 표의 「선도가」 칸(forward)에는 현물을 선도가인 척 넣지 않는다.
  const ivRows = ivVenue === null ? [] : rows.filter((row) => row.venue === ivVenue);
  const forward = ivRows.find((row) => row.forward !== null)?.forward ?? null;
  const ref = forward ?? spot;

  return {
    expiry,
    expiryMs,
    dte,
    callOi,
    putOi,
    callVol: sumVol(calls),
    putVol: sumVol(puts),
    pcrOi: putCallRatio(putOi, callOi),
    maxPain: maxPain(aggregateStrikes(rows)),
    atmIv: ref === null ? null : atmIv(ivRows, ref),
    rr25: ref === null ? null : riskReversal25(ivRows, ref, T),
    forward,
  };
}

export function analyzeOptions(snapshot: OptionsSnapshot, nowMs: number): OptionsAnalysis {
  const spot = snapshot.indexPrice;
  const rows = snapshot.rows;
  const ivVenue = pickIvVenue(rows);

  const byExpiry = new Map<string, OptionRow[]>();
  for (const row of rows) {
    const group = byExpiry.get(row.expiry);
    if (group) group.push(row);
    else byExpiry.set(row.expiry, [row]);
  }
  const expiries = [...byExpiry.entries()]
    .map(([expiry, group]) => summarizeExpiry(expiry, group, ivVenue, spot, nowMs))
    .sort((a, b) => a.expiryMs - b.expiryMs);

  const strikesByExpiry: Record<string, StrikeRow[]> = {};
  for (const [expiry, group] of byExpiry) strikesByExpiry[expiry] = aggregateStrikes(group);
  strikesByExpiry.all = aggregateStrikes(rows);

  const calls = rows.filter((row) => row.type === "C");
  const puts = rows.filter((row) => row.type === "P");
  const oi = sumOi(rows);
  const byVenue: VenueTotals[] = VENUES.map((venue) => {
    const venueRows = rows.filter((row) => row.venue === venue);
    return { venue, oi: sumOi(venueRows), vol24h: sumVol(venueRows) };
  });

  const ivTerm: IvTermPoint[] = [];
  for (const e of expiries) {
    if (e.atmIv !== null) ivTerm.push({ expiry: e.expiry, dte: e.dte, atmIv: e.atmIv });
  }

  const rv30 = realizedVol(snapshot.dailyCloses, 30);
  const dvol = snapshot.dvol;

  return {
    spot,
    totals: {
      oi,
      oiUsd: spot === null ? null : oi * spot,
      vol24h: sumVol(rows),
      pcrOi: putCallRatio(sumOi(puts), sumOi(calls)),
      pcrVol: putCallRatio(sumVol(puts), sumVol(calls)),
      byVenue,
    },
    expiries,
    strikesByExpiry,
    walls: findWalls(strikesByExpiry.all, spot),
    gex:
      spot === null
        ? { total: null, byStrike: [], flipStrike: null }
        : gammaExposure(rows, spot, nowMs),
    ivTerm,
    ivVenue,
    rv30,
    dvol,
    ivMinusRv: dvol !== null && rv30 !== null ? dvol - rv30 : null,
  };
}
