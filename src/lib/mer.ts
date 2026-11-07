/**
 * 한계 기대 수익(MER) — 진입 뒤 경로에서 "+kR 자리에 추가했다면 그 다리는 몇 R 을 벌었나"를 시뮬하고,
 * 구간별 표본으로 엣지·판정을 내서 어느 자리 추가가 첫 진입보다 효율이 좋은지 가린다(REQ-0102).
 *
 * 구간 = 최초 손절폭 d₀ 의 R 배수. 추가 다리의 손절은 공통 손절(최초 진입가 + 왕복 비용, 본전 손절)이라
 * 다리 R 은 기준 R 과 무관하게 (청산가 − 구간가) ÷ (구간가 − 공통 손절) 로 잰다 — 과거 거래도 표본이 된다.
 * 결과 R·MER 은 저장하지 않고 관측값(도달·터치 시각)에서 매번 계산한다(0044 원칙).
 */
import type { Side } from '@/lib/domain';
import { edgeInterval, edgeStats, edgeVerdict, type EdgeStats, type EdgeVerdict } from '@/lib/edge';
import { floorToBar, type Bar, type Candle } from '@/lib/okx';
import { stopDistance } from '@/lib/r-multiple';

export const MER_ZONES_R = [1, 1.5, 2, 2.5, 3] as const;
export type ZoneR = (typeof MER_ZONES_R)[number];
export type ZoneOutcome = 'reached' | 'stop_first' | 'exit_first';

export interface MerTradeInput {
  side: Side;
  entryMs: number;
  entry0: number;
  stop0: number;
  exitMs: number;
  exit0: number;
  feeRate: number;
}

export interface ZoneHit {
  zoneR: ZoneR;
  zonePx: number;
  outcome: ZoneOutcome;
  /** 구간가에 닿은 봉의 시작 시각 */
  reachedAtMs: number | null;
  /** 도달 뒤 공통 손절에 닿은 봉의 시작 시각 */
  commonStopHitAtMs: number | null;
  bar: Bar;
}

export interface LegSizing {
  /** 공통 손절까지 잃으면 정확히 1R(rBase) 이 되는 코인 수량 */
  qty: number;
  oneRUsd: number;
  /** 왕복 수수료 ÷ rBase */
  costR: number;
  /** 추가분이 최초 진입 수량의 몇 배인가. oneE 를 모르면 null */
  eAdd: number | null;
}

const dirOf = (side: Side) => (side === 'long' ? 1 : -1);

/** 구간 가격 — entry0 + dir·k·d₀ */
export function zonePrice(side: Side, entry0: number, d0: number, k: number): number {
  return entry0 + dirOf(side) * k * d0;
}

/** 공통 손절 — 비용만큼 이익 쪽(롱 위·숏 아래). 닿아도 수수료 포함 본전이라 CR 0. */
export function commonStopPrice(side: Side, entry0: number, feeRate: number): number {
  return entry0 * (1 + dirOf(side) * 2 * feeRate);
}

/** 추가 다리 수량 — 공통 손절이 추가가보다 불리한 쪽에 없으면(위험 0 이하) null. */
export function legSizing(
  side: Side,
  rBase: number,
  oneE: number,
  addPx: number,
  commonStop: number,
  feeRate: number,
): LegSizing | null {
  const dist = dirOf(side) * (addPx - commonStop);
  if (!(dist > 0) || !(rBase > 0)) return null;
  const qty = rBase / dist;
  return {
    qty,
    oneRUsd: dist * qty,
    costR: ((addPx + commonStop) * feeRate * qty) / rBase,
    eAdd: oneE > 0 ? qty / oneE : null,
  };
}

/**
 * 구간별 가상 추가 시뮬. 진입 봉 ~ 청산 봉만 본다.
 * 봉 안 순서를 모르므로 같은 봉에서 구간 도달과 최초 손절 터치가 같이 있으면 stop_first(보수),
 * 공통 손절 터치는 도달 '다음 봉'부터 찾는다. 구간마다 독립 판정.
 */
export function simulateZones(
  input: MerTradeInput,
  candles: readonly Candle[],
  bar: Bar,
  zones: readonly ZoneR[] = MER_ZONES_R,
): ZoneHit[] {
  const { side, entryMs, entry0, stop0, exitMs, feeRate } = input;
  const d0 = stopDistance(side, entry0, stop0);
  if (!(entry0 > 0) || !(d0 > 0)) return [];

  const start = floorToBar(entryMs, bar);
  const end = floorToBar(exitMs, bar);
  const path = candles.filter((c) => c.t >= start && c.t <= end).sort((a, b) => a.t - b.t);
  if (path.length === 0) return [];

  const long = side === 'long';
  const reaches = (c: Candle, px: number) => (long ? c.h >= px : c.l <= px);
  const touches = (c: Candle, px: number) => (long ? c.l <= px : c.h >= px);
  const commonStop = commonStopPrice(side, entry0, feeRate);

  return zones.map((zoneR): ZoneHit => {
    const zonePx = zonePrice(side, entry0, d0, zoneR);
    const base = { zoneR, zonePx, bar, reachedAtMs: null, commonStopHitAtMs: null };
    for (let i = 0; i < path.length; i += 1) {
      const c = path[i];
      if (touches(c, stop0)) return { ...base, outcome: 'stop_first' };
      if (!reaches(c, zonePx)) continue;
      const hit = path.slice(i + 1).find((n) => touches(n, commonStop));
      return { ...base, outcome: 'reached', reachedAtMs: c.t, commonStopHitAtMs: hit ? hit.t : null };
    }
    return { ...base, outcome: 'exit_first' };
  });
}

/** 다리 순 R — reached 만. 공통 손절에 닿았으면 그 가격, 아니면 실제 청산가로 나간다. */
export function legResultR(input: MerTradeInput, hit: ZoneHit): number | null {
  if (hit.outcome !== 'reached') return null;
  const dir = dirOf(input.side);
  const commonStop = commonStopPrice(input.side, input.entry0, input.feeRate);
  const risk = dir * (hit.zonePx - commonStop);
  if (!(risk > 0)) return null;
  const exitPx = hit.commonStopHitAtMs !== null ? commonStop : input.exit0;
  const priceR = (dir * (exitPx - hit.zonePx)) / risk;
  const costR = ((hit.zonePx + exitPx) * input.feeRate) / risk;
  return priceR - costR;
}

export interface MerZoneRow {
  zoneR: ZoneR;
  stats: EdgeStats;
  interval: [number, number] | null;
  verdict: EdgeVerdict;
  /** 구간 다리 R 평균(= 엣지) */
  mer: number | null;
  /** 직전 구간 대비 MER 변화. 첫 구간은 mer0 대비 */
  deltaMer: number | null;
  pass: boolean;
  /** 봉 종류별 표본 수 */
  bars: Record<string, number>;
}

/**
 * 구간별 MER 표. pass = 엣지 확인 && MER 가 첫 진입 MER(mer0) 보다 큼(mer0 모르면 0 초과).
 * best = 통과 구간 중 ΔMER 최대 — 한 칸 더 기다린 값이 가장 큰 자리.
 */
export function merTable(
  byZone: Partial<Record<ZoneR, readonly number[]>>,
  mer0: number | null,
  barsByZone?: Partial<Record<ZoneR, Record<string, number>>>,
): { rows: MerZoneRow[]; best: ZoneR | null } {
  let prev = mer0;
  const rows = MER_ZONES_R.map((zoneR): MerZoneRow => {
    const rs = byZone[zoneR] ?? [];
    const stats = edgeStats(rs);
    const interval = edgeInterval(rs);
    const verdict = edgeVerdict(stats.n, interval);
    const mer = stats.edge;
    const deltaMer = mer !== null && prev !== null ? mer - prev : null;
    prev = mer;
    const pass = verdict === 'positive' && mer !== null && mer > (mer0 ?? 0);
    return { zoneR, stats, interval, verdict, mer, deltaMer, pass, bars: { ...(barsByZone?.[zoneR] ?? {}) } };
  });

  let best: MerZoneRow | null = null;
  for (const row of rows) {
    if (!row.pass) continue;
    if (best === null || (row.deltaMer ?? -Infinity) > (best.deltaMer ?? -Infinity)) best = row;
  }
  return { rows, best: best ? best.zoneR : null };
}

/** 추가 포함 거래 R — 원 거래 R + 다리 순 R 합. */
export function withAddTradeR(originalR: number, legRs: readonly number[]): number {
  return legRs.reduce((a, r) => a + r, originalR);
}
