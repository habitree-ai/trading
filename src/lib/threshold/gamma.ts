/**
 * 임계점 ② 감마 — `analyzeOptions` 결과를 롱·숏 켜짐과 핀닝 경고로 읽는다(REQ-0102).
 *
 * GEX 식·부호는 앱의 것을 그대로 쓴다(`@/lib/options/analyze` — 콜 +, 풋 −, USD / 현물 1%).
 * 여기서는 새 식을 만들지 않고 그 결과(순 GEX·플립·행사가별 OI)만 판정에 쓴다. 부호는 "딜러가 콜 롱·풋 숏"
 * 이라는 가정이다 — 화면 근거 글에도 그렇게 남긴다.
 *
 * 판정(초기값 — THRESHOLD_RULES):
 * - 켜짐(롱): ① 순 GEX 음수 + 플립이 현재가 아래(위로 갈수록 음감마가 깊어져 상승이 가속) 또는
 *   ② 큰 콜 벽(전 행사가 중 콜 OI 최대)을 현재가가 넘었고 위 다음 콜 벽까지 ≥ wallGapOnPct.
 * - 켜짐(숏): 대칭 — ① 순 GEX 음수 + 플립이 현재가 위 또는 ② 큰 풋 벽 아래 + 아래 다음 풋 벽까지 ≥ wallGapOnPct.
 *   음감마는 양방향 증폭이라 방향 하나를 고르려면 기준이 필요하다 — 플립에서 멀어지는 쪽(음감마가 깊어지는 쪽).
 *   플립이 없으면 ①로는 방향을 정하지 않는다. 벽 돌파(②)가 있으면 그쪽이 우선.
 * - 경고: 순 GEX 양수 + 가장 가까운 벽이 ±wallNearWarnPct 안 + bigExpiryHours 안에 대형 만기(핀닝).
 */

import type { OptionsAnalysis, StrikeRow } from "@/lib/options/types";
import { THRESHOLD_RULES, type GammaReport, type SignalSide, type SignalState } from "@/lib/threshold/types";

const HOUR_MS = 3_600_000;

/**
 * 대형 만기 — 그 만기의 OI(콜+풋)가 전체 OI 의 이 비중 이상. analyze 쪽에 대형 기준이 없어 여기서 정한다.
 * 초기값 — 검증 전.
 */
export const BIG_EXPIRY_OI_SHARE = 0.2;

/** OI 최대 행사가 — 0 이면 벽이 아니다(analyze.ts heaviestStrike 와 같은 규칙, 거기서는 export 되지 않는다). */
function heaviest(rows: StrikeRow[], side: "callOi" | "putOi"): number | null {
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

function pctFrom(spot: number, price: number): number {
  return (Math.abs(price - spot) / spot) * 100;
}

function fmtPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

/** 48시간 안에 끝나는 만기 중 OI 비중이 가장 큰 대형 만기. 없으면 null. */
function findBigExpiry(analysis: OptionsAnalysis, nowMs: number): GammaReport["bigExpiry"] {
  const total = analysis.totals.oi;
  if (!(total > 0)) return null;
  let best: GammaReport["bigExpiry"] = null;
  for (const e of analysis.expiries) {
    const hoursLeft = (e.expiryMs - nowMs) / HOUR_MS;
    if (hoursLeft <= 0 || hoursLeft > THRESHOLD_RULES.bigExpiryHours) continue;
    const oiShare = (e.callOi + e.putOi) / total;
    if (oiShare < BIG_EXPIRY_OI_SHARE) continue;
    if (best === null || oiShare > best.oiShare) best = { expiry: e.expiry, hoursLeft, oiShare };
  }
  return best;
}

/**
 * 감마 판정. `spot` 은 지금 가격 — 벽의 위/아래와 거리는 이 값으로 다시 잰다(analyze 의 벽은 스냅샷 지수가 기준).
 * 옵션 행이 없거나 spot 이 잘못이면 null, GEX 를 못 냈으면 measured=false.
 */
export function gammaState(analysis: OptionsAnalysis, spot: number, nowMs: number): GammaReport | null {
  const all = analysis.strikesByExpiry.all ?? [];
  if (!(spot > 0) || all.length === 0) return null;

  const net = analysis.gex.total;
  const flip = analysis.gex.flipStrike;

  // 지금 가격 기준 벽 — 위에서 콜 OI 최대, 아래에서 풋 OI 최대(analyze.ts findWalls 와 같은 규칙).
  const callWall = heaviest(all.filter((r) => r.strike > spot), "callOi");
  const putWall = heaviest(all.filter((r) => r.strike < spot), "putOi");
  const wallDistPct = {
    call: callWall === null ? null : pctFrom(spot, callWall),
    put: putWall === null ? null : pctFrom(spot, putWall),
  };

  // 큰 벽 — 전 행사가 중 OI 최대. 현재가가 그 너머에 있으면 돌파.
  const bigCall = heaviest(all, "callOi");
  const bigPut = heaviest(all, "putOi");
  const callBroken = bigCall !== null && spot > bigCall;
  const putBroken = bigPut !== null && spot < bigPut;

  const bigExpiry = findBigExpiry(analysis, nowMs);
  const reasons: string[] = ["GEX 부호는 가정(콜 +, 풋 −)"];

  if (net === null) {
    reasons.push("GEX 재료 없음(IV·잔여기간) — 확인 불가");
    const state: SignalState = { on: null, warn: false, measured: false, reasons };
    return {
      spot,
      netGexNearSpot: null,
      flipStrike: flip,
      callWall,
      putWall,
      wallDistPct,
      nextWallDistPct: null,
      bigExpiry,
      state,
    };
  }

  const gap = THRESHOLD_RULES.wallGapOnPct;
  let on: SignalSide | null = null;
  let nextWallDistPct: number | null = null;

  if (callBroken) {
    nextWallDistPct = wallDistPct.call;
    if (nextWallDistPct !== null && nextWallDistPct >= gap) {
      on = "long";
      reasons.push(`큰 콜 벽 ${bigCall} 돌파 · 다음 콜 벽 ${callWall}까지 ${fmtPct(nextWallDistPct)} ≥ ${gap}%`);
    } else {
      reasons.push(
        `큰 콜 벽 ${bigCall} 돌파 · 다음 콜 벽까지 ${nextWallDistPct === null ? "없음" : fmtPct(nextWallDistPct)} — 여유 부족`,
      );
    }
  } else if (putBroken) {
    nextWallDistPct = wallDistPct.put;
    if (nextWallDistPct !== null && nextWallDistPct >= gap) {
      on = "short";
      reasons.push(`큰 풋 벽 ${bigPut} 아래 · 다음 풋 벽 ${putWall}까지 ${fmtPct(nextWallDistPct)} ≥ ${gap}%`);
    } else {
      reasons.push(
        `큰 풋 벽 ${bigPut} 아래 · 다음 풋 벽까지 ${nextWallDistPct === null ? "없음" : fmtPct(nextWallDistPct)} — 여유 부족`,
      );
    }
  }

  if (net < 0) {
    if (on === null && flip !== null && flip !== spot) {
      on = flip < spot ? "long" : "short";
      nextWallDistPct = on === "long" ? wallDistPct.call : wallDistPct.put;
      reasons.push(`순 GEX 음수 · 플립 ${Math.round(flip)} ${flip < spot ? "아래" : "위"} — ${on === "long" ? "상승" : "하락"} 가속 쪽`);
    } else if (on === null) {
      reasons.push("순 GEX 음수 · 플립 없음 — 방향 미정");
    } else {
      reasons.push("순 GEX 음수(양방향 증폭)");
    }
  } else {
    reasons.push("순 GEX 양수(변동 억제)");
  }

  // 경고 — 순 GEX 양수 + 가장 가까운 벽 ±0.5% + 48h 안 대형 만기.
  const dists = [wallDistPct.call, wallDistPct.put].filter((d): d is number => d !== null);
  const nearest = dists.length > 0 ? Math.min(...dists) : null;
  const warn =
    net > 0 && nearest !== null && nearest <= THRESHOLD_RULES.wallNearWarnPct && bigExpiry !== null;
  if (warn && bigExpiry !== null && nearest !== null) {
    reasons.push(
      `핀닝 경고: 벽까지 ${fmtPct(nearest)} · 대형 만기 ${bigExpiry.expiry} ${Math.round(bigExpiry.hoursLeft)}시간 남음(OI ${Math.round(bigExpiry.oiShare * 100)}%)`,
    );
  }

  return {
    spot,
    netGexNearSpot: net,
    flipStrike: flip,
    callWall,
    putWall,
    wallDistPct,
    nextWallDistPct,
    bigExpiry,
    state: { on, warn, measured: true, reasons },
  };
}
