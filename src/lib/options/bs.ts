/**
 * 블랙숄즈 보조 — 델타·감마만, r = 0, 선도가 기준.
 *
 * 왜 r = 0 인가: BTC 옵션은 두 거래소 모두 만기별 선도가(fwdPx / underlying_price)를 직접
 * 준다. 선도가를 S 로 넣으면 이자·캐리는 이미 그 안에 녹아 있어 r 을 따로 둘 이유가 없다
 * (Black-76 꼴). 프리미엄은 계산하지 않는다 — 화면이 쓰는 건 GEX 의 Γ 와 25Δ 스마일의
 * Δ 뿐이다. 재료(S·K·σ·T)가 하나라도 0 이하거나 유한하지 않으면 null 을 돌린다. 0 이나
 * NaN 을 흘리면 합산 지표가 조용히 틀어진다.
 */

import type { OptionType } from "@/lib/options/types";

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** 표준정규 밀도 φ(x). */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/**
 * 표준정규 누적 N(x) — Hart(1968) 유리근사(West 2005, "Better approximations to
 * cumulative normal functions"). 배정밀도 전 구간에서 오차 ~1e-14 라 A-S 7.1.26(1.5e-7)
 * 대신 골랐다. 꼬리(|x| > 37)는 배정밀도로 0 이다.
 */
export function normCdf(x: number): number {
  const z = Math.abs(x);
  let tail: number;
  if (z > 37) {
    tail = 0;
  } else {
    const e = Math.exp(-0.5 * z * z);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      tail = (e * n) / d;
    } else {
      // 먼 꼬리는 연분수 — 유리근사가 여기서 정밀도를 잃는다.
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      tail = e / b / SQRT_2PI;
    }
  }
  return x > 0 ? 1 - tail : tail;
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * d1 = (ln(S/K) + σ²T/2) / (σ√T).
 * S 선도가(USD), K 행사가(USD), sigma 소수 IV, T 연 단위. 재료가 0 이하·비유한이면 null.
 */
export function bsD1(S: number, K: number, sigma: number, T: number): number | null {
  if (!isPositive(S) || !isPositive(K) || !isPositive(sigma) || !isPositive(T)) return null;
  const v = sigma * Math.sqrt(T);
  return (Math.log(S / K) + 0.5 * v * v) / v;
}

/** 델타 — 콜 N(d1), 풋 N(d1) − 1. */
export function bsDelta(
  type: OptionType,
  S: number,
  K: number,
  sigma: number,
  T: number,
): number | null {
  const d1 = bsD1(S, K, sigma, T);
  if (d1 === null) return null;
  const n = normCdf(d1);
  return type === "C" ? n : n - 1;
}

/** 감마 — φ(d1) / (S·σ·√T). 콜·풋이 같다. */
export function bsGamma(S: number, K: number, sigma: number, T: number): number | null {
  const d1 = bsD1(S, K, sigma, T);
  if (d1 === null) return null;
  return normPdf(d1) / (S * sigma * Math.sqrt(T));
}
