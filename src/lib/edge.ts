/**
 * 트레이딩 엣지 — 거래별 R 배수를 모아 "한 거래에 평균 몇 R 을 버는가"를 낸다(REQ-0089).
 *
 *   엣지 = p × W̄ − (1 − p) × L̄
 *
 * p 는 R 배수 > 0 인 거래의 비율, W̄ 는 이긴 거래 R 배수의 평균, L̄ 는 진 거래 R 배수 절댓값의 평균.
 * 본전(R 배수 0)은 패로 센다 — 그래야 (1 − p) 와 맞고, 엣지가 R 배수 평균과 같아진다(검산).
 */
import { breakEvenWinRate } from '@/lib/verdict';

type Maybe = number | null;

export interface EdgeStats {
  n: number;
  wins: number;
  losses: number;
  winRate: Maybe;
  /** 이긴 거래 R 배수 평균 */
  avgWinR: Maybe;
  /** 진 거래 R 배수 절댓값 평균 (양수) */
  avgLossR: Maybe;
  /** p × W̄ − (1 − p) × L̄ */
  edge: Maybe;
  /** 검산 — R 배수 평균. 엣지와 같아야 한다 */
  meanR: Maybe;
  /** W̄ ÷ L̄ */
  payoff: Maybe;
  /** 본전 승률 L̄ ÷ (W̄ + L̄) */
  breakEvenWinRate: Maybe;
}

const mean = (xs: readonly number[]): Maybe => (xs.length === 0 ? null : xs.reduce((a, x) => a + x, 0) / xs.length);

export function edgeStats(rs: readonly number[]): EdgeStats {
  const n = rs.length;
  const winsR = rs.filter((r) => r > 0);
  const lossesR = rs.filter((r) => r <= 0).map((r) => Math.abs(r));
  const winRate = n === 0 ? null : winsR.length / n;
  const avgWinR = mean(winsR);
  const avgLossR = mean(lossesR);

  let edge: Maybe = null;
  if (winRate !== null) edge = winRate * (avgWinR ?? 0) - (1 - winRate) * (avgLossR ?? 0);

  const payoff = avgWinR !== null && avgLossR !== null && avgLossR > 0 ? avgWinR / avgLossR : null;
  return {
    n,
    wins: winsR.length,
    losses: lossesR.length,
    winRate,
    avgWinR,
    avgLossR,
    edge,
    meanR: mean(rs),
    payoff,
    breakEvenWinRate: payoff === null ? null : breakEvenWinRate(payoff),
  };
}

/** 고정 시드 난수 — 같은 표본이면 새로고침해도 구간이 흔들리지 않게. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 엣지(= R 배수 평균)의 95% 구간 — 부트스트랩. 표본 2건 미만이면 null. */
export function edgeInterval(
  rs: readonly number[],
  opts: { iterations?: number; seed?: number } = {},
): [number, number] | null {
  const { iterations = 10_000, seed = 20261101 } = opts;
  const n = rs.length;
  if (n < 2) return null;
  const rand = mulberry32(seed);
  const means = new Float64Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < n; j += 1) sum += rs[Math.floor(rand() * n)];
    means[i] = sum / n;
  }
  means.sort();
  const at = (q: number) => means[Math.min(iterations - 1, Math.max(0, Math.floor(q * iterations)))];
  return [at(0.025), at(0.975)];
}

export type EdgeVerdict = 'insufficient' | 'undetermined' | 'positive' | 'negative';

export const EDGE_MIN_SAMPLE = 50;

export const EDGE_VERDICT_LABEL: Record<EdgeVerdict, string> = {
  insufficient: '표본 부족',
  undetermined: '아직 판정 불가',
  positive: '엣지 확인',
  negative: '엣지 음수',
};

/** 판정 — N < 50 표본 부족, 구간이 0 을 품으면 판정 불가, 하단 > 0 확인, 상단 < 0 음수. */
export function edgeVerdict(n: number, interval: [number, number] | null): EdgeVerdict {
  if (n < EDGE_MIN_SAMPLE || interval === null) return 'insufficient';
  const [lo, hi] = interval;
  if (lo > 0) return 'positive';
  if (hi < 0) return 'negative';
  return 'undetermined';
}

/** 최근 `window` 건 이동 엣지 — i 번째 값은 i 번째 거래까지의 마지막 window 건 평균. 모자라면 null. */
export function rollingEdge(rs: readonly number[], window: number): Maybe[] {
  const out: Maybe[] = [];
  let sum = 0;
  for (let i = 0; i < rs.length; i += 1) {
    sum += rs[i];
    if (i >= window) sum -= rs[i - window];
    out.push(i >= window - 1 ? sum / window : null);
  }
  return out;
}

/** 누적 R 곡선. */
export function cumulativeR(rs: readonly number[]): number[] {
  let acc = 0;
  return rs.map((r) => (acc += r));
}
