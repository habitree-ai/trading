/**
 * 프리미엄·베이시스 산식과 기초 통계 — 순수 함수만. analyze.mjs 가 쓰고 premium.test.mjs 가 고정한다.
 *
 * P_coin  테더 김프   = 업비트 KRW-X / (OKX X-USDT × 업비트 KRW-USDT) − 1
 * P_usd   달러 김프   = 업비트 KRW-X / (OKX X-USDT × USD/KRW) − 1
 * P_usdt  테더 프리미엄 = KRW-USDT / USD/KRW − 1
 * R_X     상대 프리미엄 = P_coin,X − P_coin,BTC
 * D       업비트 삼각   = KRW-BTC / (USDT-BTC × KRW-USDT) − 1
 * basis   스왑/현물 − 1 ; 만기 베이시스 연환산 = (F/S − 1) × 365 / 잔존일
 */
export const premiumCoin = (krw, usdt, krwUsdt) => krw / (usdt * krwUsdt) - 1;
export const premiumUsd = (krw, usdt, usdkrw) => krw / (usdt * usdkrw) - 1;
export const tetherPremium = (krwUsdt, usdkrw) => krwUsdt / usdkrw - 1;
export const relPremium = (pX, pBtc) => pX - pBtc;
export const triangle = (krwBtc, usdtBtc, krwUsdt) => krwBtc / (usdtBtc * krwUsdt) - 1;
export const basis = (swapClose, spotClose) => swapClose / spotClose - 1;
export const annualizedBasis = (fut, spot, daysToExpiry) => (fut / spot - 1) * (365 / daysToExpiry);

export function mean(xs) {
  if (!xs.length) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/** 오름차순 정렬된 배열의 분위수(선형 보간). */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summarize(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return { n: 0 };
  return {
    n: s.length,
    mean: mean(s),
    sd: sd(s),
    min: s[0],
    p5: quantile(s, 0.05),
    p20: quantile(s, 0.2),
    p50: quantile(s, 0.5),
    p80: quantile(s, 0.8),
    p95: quantile(s, 0.95),
    max: s[s.length - 1],
  };
}

/**
 * AR(1) 계수와 반감기. x_{t+1} − m = φ(x_t − m) 을 OLS 로 맞춘다.
 * 반감기 = −ln2 / ln φ (0 < φ < 1 일 때만). φ ≥ 1 이면 평균회귀가 없다 → null.
 */
export function ar1(xs) {
  if (xs.length < 10) return { phi: null, halfLife: null, n: xs.length };
  const m = mean(xs);
  let num = 0;
  let den = 0;
  for (let i = 0; i + 1 < xs.length; i += 1) {
    const a = xs[i] - m;
    num += a * (xs[i + 1] - m);
    den += a * a;
  }
  const phi = den > 0 ? num / den : null;
  const halfLife = phi !== null && phi > 0 && phi < 1 ? -Math.LN2 / Math.log(phi) : null;
  return { phi, halfLife, n: xs.length };
}

/** 연속 true 구간의 길이 목록. [1,1,0,1,0,0,1,1,1] → [2,1,3] */
export function runs(flags) {
  const out = [];
  let cur = 0;
  for (const f of flags) {
    if (f) cur += 1;
    else if (cur) {
      out.push(cur);
      cur = 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 시계열 xs 에서 xs[i] ≤ 진입 임계 이후 h 스텝 뒤 변화(xs[i+h] − xs[i]) 를 모은다(겹치지 않게). */
export function forwardChanges(xs, entryMask, h) {
  const out = [];
  let i = 0;
  while (i + h < xs.length) {
    if (entryMask(xs[i], i)) {
      out.push({ i, entry: xs[i], exit: xs[i + h], delta: xs[i + h] - xs[i] });
      i += h;
    } else {
      i += 1;
    }
  }
  return out;
}

/** 시계열 xs 의 값이 lo 이하로 떨어졌을 때 진입해 mid 이상으로 회복하면 청산(최대 maxHold). 겹치지 않는 사이클. */
export function cycles(xs, { lo, mid, maxHold }) {
  const out = [];
  let i = 0;
  while (i < xs.length) {
    if (xs[i] <= lo) {
      let j = i + 1;
      let exitReason = "timeout";
      while (j < xs.length) {
        if (xs[j] >= mid) {
          exitReason = "target";
          break;
        }
        if (j - i >= maxHold) break;
        j += 1;
      }
      if (j >= xs.length) exitReason = "end";
      const jj = Math.min(j, xs.length - 1);
      let worst = xs[i];
      for (let k = i; k <= jj; k += 1) worst = Math.min(worst, xs[k]);
      out.push({ i, j: jj, hold: jj - i, entry: xs[i], exit: xs[jj], delta: xs[jj] - xs[i], mae: worst - xs[i], exitReason });
      i = jj + 1;
    } else {
      i += 1;
    }
  }
  return out;
}
