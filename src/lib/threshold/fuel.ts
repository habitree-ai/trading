/**
 * 임계점 ② 보조 — 스퀴즈 연료(펀딩·가격·미결제약정 24h)(REQ-0102).
 *
 * 켜짐(롱): 펀딩 ≤ 0(숏이 돈을 내는 쪽) + 가격 상승 + OI 24h ≥ +oiChgOnPct% — 숏이 쌓인 채 밀려 올라가는 중.
 * 켜짐(숏): 대칭 — 펀딩 ≥ 0 + 가격 하락 + OI ≥ +oiChgOnPct%(롱이 쌓인 채 밀려 내려가는 중).
 * 경고: 연환산 펀딩 ≥ fundingAnnualWarn(롱 쏠림 → 롱 추가 경고). 대칭으로 ≤ −fundingAnnualWarn 이면 숏 쏠림 경고.
 * 연환산 = 8시간 펀딩 × 3 × 365. 재료 하나라도 null 이면 measured=false(꺼짐으로 보이면 안 된다).
 */

import { THRESHOLD_RULES, type FuelReport, type SignalSide } from "@/lib/threshold/types";

export interface FuelInput {
  /** 8시간 펀딩비(소수). */
  fundingRate: number | null;
  price24hAgo: number | null;
  priceNow: number | null;
  /** 같은 소스·같은 단위의 OI 두 점 — 비율만 쓴다. */
  oiNow: number | null;
  oi24hAgo: number | null;
}

/** 8시간 펀딩 → 연환산(소수). */
export function annualizeFunding(rate8h: number): number {
  return rate8h * 3 * 365;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function fuelState(input: FuelInput): FuelReport {
  const { fundingRate, price24hAgo, priceNow, oiNow, oi24hAgo } = input;

  const fundingAnnual = fundingRate === null ? null : annualizeFunding(fundingRate);
  const priceChg24h =
    priceNow !== null && price24hAgo !== null && price24hAgo > 0 ? priceNow / price24hAgo - 1 : null;
  const oiChg24hPct = oiNow !== null && oi24hAgo !== null && oi24hAgo > 0 ? (oiNow / oi24hAgo - 1) * 100 : null;

  if (fundingRate === null || fundingAnnual === null || priceChg24h === null || oiChg24hPct === null) {
    const missing = [
      fundingRate === null ? "펀딩" : null,
      priceChg24h === null ? "가격 24h" : null,
      oiChg24hPct === null ? "OI 24h" : null,
    ].filter((m): m is string => m !== null);
    return {
      fundingRate,
      fundingAnnual,
      priceChg24h,
      oiChg24hPct,
      state: { on: null, warn: false, measured: false, reasons: [`${missing.join("·")} 없음 — 확인 불가`] },
    };
  }

  const reasons = [
    `펀딩 ${(fundingRate * 100).toFixed(4)}%/8h(연 ${pct(fundingAnnual)}) · 가격 24h ${pct(priceChg24h)} · OI 24h ${oiChg24hPct.toFixed(2)}%`,
  ];

  const oiUp = oiChg24hPct >= THRESHOLD_RULES.oiChgOnPct;
  let on: SignalSide | null = null;
  if (fundingRate <= 0 && priceChg24h > 0 && oiUp) {
    on = "long";
    reasons.push("숏 연료: 펀딩 ≤ 0 · 가격 상승 · OI 증가");
  } else if (fundingRate >= 0 && priceChg24h < 0 && oiUp) {
    on = "short";
    reasons.push("롱 연료: 펀딩 ≥ 0 · 가격 하락 · OI 증가");
  }

  const limit = THRESHOLD_RULES.fundingAnnualWarn;
  let warn = false;
  if (fundingAnnual >= limit) {
    warn = true;
    reasons.push(`롱 쏠림 경고: 연환산 펀딩 ≥ ${pct(limit)} — 롱 추가 금지`);
  } else if (fundingAnnual <= -limit) {
    warn = true;
    reasons.push(`숏 쏠림 경고: 연환산 펀딩 ≤ −${pct(limit)} — 숏 추가 금지`);
  }

  return { fundingRate, fundingAnnual, priceChg24h, oiChg24hPct, state: { on, warn, measured: true, reasons } };
}
