/**
 * 임계점 ③ 유동성 공백 — 거래량 프로파일의 저거래량 구간(LVN)·고거래량 구간(HVN)(REQ-0102).
 *
 * 순수 함수만 둔다. 호가 깊이 비율은 밖(서버 수집)에서 받아 온다 —
 * 측정 못 했으면 null 을 그대로 받고, 0 으로 흘리지 않는다.
 */

import type { Candle } from "@/lib/okx";

import {
  THRESHOLD_RULES,
  type LiquidityReport,
  type PriceRange,
  type SignalSide,
  type VolumeBin,
} from "./types";

const R = THRESHOLD_RULES;

/**
 * 거래량 프로파일.
 * 칸 경계 = refPrice + k × (refPrice × binPct) — 선형 등간격.
 * 각 봉 거래량은 [저, 고] 가 걸친 칸에 겹친 길이 비례로 고르게 나눈다(고=저 이면 그 칸에 전부).
 * 최저~최고 사이 빈 칸(거래량 0)도 남긴다 — 공백 판정에 필요하다.
 */
export function volumeProfile(
  candles: readonly Pick<Candle, "h" | "l" | "v">[],
  binPct: number,
  refPrice: number,
): VolumeBin[] {
  const w = refPrice * binPct;
  if (candles.length === 0 || !(w > 0)) return [];
  const idx = (p: number) => Math.floor((p - refPrice) / w);
  const edge = (k: number) => refPrice + k * w;

  let kMin = Infinity;
  let kMax = -Infinity;
  for (const c of candles) {
    kMin = Math.min(kMin, idx(c.l));
    kMax = Math.max(kMax, idx(c.h));
  }
  const vols: number[] = new Array(kMax - kMin + 1).fill(0);

  for (const c of candles) {
    const k0 = idx(c.l);
    const k1 = idx(c.h);
    if (c.h <= c.l || k0 === k1) {
      vols[k0 - kMin] += c.v;
      continue;
    }
    // 겹친 길이 합으로 나눠 부동소수 오차가 있어도 칸 합 = 봉 거래량
    const parts: number[] = [];
    let total = 0;
    for (let k = k0; k <= k1; k += 1) {
      const len = Math.max(0, Math.min(c.h, edge(k + 1)) - Math.max(c.l, edge(k)));
      parts.push(len);
      total += len;
    }
    if (total <= 0) {
      vols[k0 - kMin] += c.v;
      continue;
    }
    parts.forEach((len, j) => {
      vols[k0 + j - kMin] += (c.v * len) / total;
    });
  }

  return vols.map((vol, j) => ({ lo: edge(kMin + j), hi: edge(kMin + j + 1), vol }));
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 조건을 만족하는 연속 칸을 minLen 이상일 때만 한 구간으로 묶는다. */
function runs(bins: readonly VolumeBin[], hit: (b: VolumeBin) => boolean, minLen: number) {
  const out: { range: PriceRange; from: number; to: number }[] = [];
  let start = -1;
  for (let i = 0; i <= bins.length; i += 1) {
    const ok = i < bins.length && hit(bins[i]);
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) {
      if (i - start >= minLen) {
        out.push({ range: { lo: bins[start].lo, hi: bins[i - 1].hi }, from: start, to: i - 1 });
      }
      start = -1;
    }
  }
  return out;
}

const fmt = (x: number) => `${x.toFixed(2)}%`;

/**
 * 유동성 상태.
 * LVN = 중앙값 35% 이하 칸이 연속 3칸 이상. HVN = 중앙값 150% 이상 칸(연속 묶음, 길이 제한 없음).
 * 켜짐(롱) = 현재 칸 HVN 아님 + 위쪽 공백 입구까지 ≤ 0.3% + depthRatio < 0.5(위 매도가 얇음).
 * 켜짐(숏) = 대칭: 아래쪽 공백 입구까지 ≤ 0.3% + 1/depthRatio < 0.5(= depthRatio > 2, 아래 매수가 얇음).
 * 롱·숏 동시 켜짐은 불가 — depthRatio < 0.5 와 > 2 가 함께 성립할 수 없다.
 * 경고 = 현재 칸 바로 위 칸이 HVN(롱 기준 — 계약상 warn 은 방향 하나). 바로 아래 HVN 은 근거에만 적는다.
 * 현재가가 공백 안이면 위·아래 거리 모두 0.
 * depthRatio null 이면 켜짐 판정 불가 → measured false, 공백·HVN 값은 그대로 채운다.
 */
export function liquidityState(
  bins: readonly VolumeBin[],
  spot: number,
  depthRatio: number | null,
): LiquidityReport {
  const reasons: string[] = [];
  if (bins.length === 0 || !(spot > 0)) {
    return {
      bins: [...bins],
      lvn: [],
      hvn: [],
      gapUpDistPct: null,
      gapDownDistPct: null,
      inHvn: false,
      depthRatio,
      state: { on: null, warn: false, measured: false, reasons: ["거래량 프로파일 없음"] },
    };
  }

  const med = median(bins.map((b) => b.vol));
  const isLvn = (b: VolumeBin) => b.vol <= med * R.lvnMedianRatio;
  const isHvn = (b: VolumeBin) => b.vol >= med * R.hvnMedianRatio;
  const lvnRuns = runs(bins, isLvn, R.lvnMinBins);
  const hvnRuns = runs(bins, isHvn, 1);
  const lvn = lvnRuns.map((r) => r.range);
  const hvn = hvnRuns.map((r) => r.range);

  let gapUp: number | null = null;
  let gapDown: number | null = null;
  for (const g of lvn) {
    if (g.hi > spot) {
      const d = (Math.max(0, g.lo - spot) / spot) * 100;
      gapUp = gapUp === null ? d : Math.min(gapUp, d);
    }
    if (g.lo < spot) {
      const d = (Math.max(0, spot - g.hi) / spot) * 100;
      gapDown = gapDown === null ? d : Math.min(gapDown, d);
    }
  }

  const cur = bins.findIndex((b) => b.lo <= spot && spot < b.hi);
  const inHvn = cur >= 0 && isHvn(bins[cur]);
  const hvnAbove = cur >= 0 && cur + 1 < bins.length && isHvn(bins[cur + 1]);
  const hvnBelow = cur > 0 && isHvn(bins[cur - 1]);

  reasons.push(
    cur < 0 ? "현재가가 프로파일 밖" : inHvn ? "현재가 칸 HVN" : "현재가 칸 HVN 아님",
    gapUp === null ? "위쪽 공백 없음" : `위쪽 공백까지 ${fmt(gapUp)}`,
    gapDown === null ? "아래쪽 공백 없음" : `아래쪽 공백까지 ${fmt(gapDown)}`,
  );
  if (hvnAbove) reasons.push("경고: 바로 위 칸 HVN");
  if (hvnBelow) reasons.push("참고: 바로 아래 칸 HVN");

  const measured = depthRatio !== null && Number.isFinite(depthRatio) && depthRatio >= 0;
  let on: SignalSide | null = null;
  if (!measured) {
    reasons.push("호가 깊이 비율 미측정 — 켜짐 판정 불가");
  } else {
    reasons.push(`호가 깊이 비율(위 매도÷아래 매수) ${depthRatio.toFixed(2)}`);
    const longOn = !inHvn && gapUp !== null && gapUp <= R.gapEntryPct && depthRatio < R.depthRatioOn;
    // 숏은 역수: 아래 매수 ÷ 위 매도 < 0.5 (매수가 얇음). depthRatio 0 이면 1/0=∞ → 숏 아님
    const shortOn =
      !inHvn && gapDown !== null && gapDown <= R.gapEntryPct && 1 / depthRatio < R.depthRatioOn;
    if (longOn) on = "long";
    else if (shortOn) on = "short";
    if (on) reasons.push(on === "long" ? "켜짐: 롱(위쪽 공백 입구)" : "켜짐: 숏(아래쪽 공백 입구)");
  }

  return {
    bins: [...bins],
    lvn,
    hvn,
    gapUpDistPct: gapUp,
    gapDownDistPct: gapDown,
    inHvn,
    depthRatio,
    state: { on, warn: hvnAbove, measured, reasons },
  };
}
