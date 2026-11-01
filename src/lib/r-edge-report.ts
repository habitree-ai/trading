/**
 * R 엣지 탭의 집계 — 거래별 R(`tradeR`)을 모아 화면 한 장 분량으로 만든다(REQ-0089).
 *
 * 표본은 청산 + 최초 위험이 있는 거래다. 잴 수 없는 청산 거래는 빼되 건수·순손익 합계·이유를
 * 같이 돌려준다 — 빠진 거래가 이긴 쪽에 몰려 있으면 엣지가 낮게 나온다(10/17 분석: 제외 21건 중 16건 승).
 */
import type { Trade } from '@/lib/domain';
import {
  cumulativeR,
  edgeInterval,
  edgeStats,
  edgeVerdict,
  rollingEdge,
  type EdgeStats,
  type EdgeVerdict,
} from '@/lib/edge';
import { netOf } from '@/lib/metrics';
import type { RUnmeasuredReason, TradeR } from '@/lib/r-multiple';

type Maybe = number | null;

export interface RItem {
  trade: Pick<Trade, 'id' | 'seq' | 'symbol' | 'exit_at' | 'realized_pnl' | 'pnl' | 'fee' | 'funding_fee'>;
  r: TradeR;
}

export interface RPoint {
  /** 청산 시각(ms) */
  t: number;
  seq: number;
  symbol: string;
  r: number;
  cum: number;
  roll20: Maybe;
  roll50: Maybe;
}

export interface RBin {
  /** 구간 하단(포함) — 맨 끝 구간은 바깥 값을 모은다 */
  from: number;
  label: string;
  count: number;
}

export interface REdgeReport {
  stats: EdgeStats;
  interval: [number, number] | null;
  verdict: EdgeVerdict;
  /** 수수료 전 엣지 — 가격R 평균 */
  edgeBeforeCost: Maybe;
  /** 평균 비용R */
  avgCostR: Maybe;
  /** 표본 중 추정 손절(과거 거래의 마지막 거래소 손절)로 잰 건수 */
  estimated: number;
  unmeasured: { count: number; net: number; byReason: Record<RUnmeasuredReason, number> };
  points: RPoint[];
  bins: RBin[];
}

const BIN = 0.5;
const LOW = -3;
const HIGH = 5;

/** R 분포 — 0.5R 폭. −3R 아래·+5R 위는 끝 구간에 모은다(드문 큰 값이 축을 늘리지 않게). */
export function rBins(rs: readonly number[]): RBin[] {
  const bins: RBin[] = [];
  for (let from = LOW; from < HIGH; from += BIN) {
    const label =
      from === LOW ? `≤${from + BIN}` : from + BIN >= HIGH ? `≥${from}` : `${from}~${from + BIN}`;
    bins.push({ from, label, count: 0 });
  }
  for (const r of rs) {
    const i = Math.min(bins.length - 1, Math.max(0, Math.floor((r - LOW) / BIN)));
    bins[i].count += 1;
  }
  return bins;
}

const mean = (xs: readonly number[]): Maybe => (xs.length === 0 ? null : xs.reduce((a, x) => a + x, 0) / xs.length);

export function buildREdgeReport(items: readonly RItem[]): REdgeReport {
  const measured = items
    .filter((i) => i.r.measurable && i.r.rMultiple !== null && i.trade.exit_at !== null)
    .sort((a, b) => Date.parse(a.trade.exit_at as string) - Date.parse(b.trade.exit_at as string));

  const rs = measured.map((i) => i.r.rMultiple as number);
  const cum = cumulativeR(rs);
  const r20 = rollingEdge(rs, 20);
  const r50 = rollingEdge(rs, 50);
  const interval = edgeInterval(rs);

  const byReason: Record<RUnmeasuredReason, number> = { no_stop: 0, stop_wrong_side: 0, no_qty: 0 };
  let unmeasuredNet = 0;
  let unmeasuredCount = 0;
  for (const i of items) {
    if (!i.r.closed || i.r.reason === null) continue;
    unmeasuredCount += 1;
    byReason[i.r.reason] += 1;
    unmeasuredNet += netOf(i.trade);
  }

  return {
    stats: edgeStats(rs),
    interval,
    verdict: edgeVerdict(rs.length, interval),
    edgeBeforeCost: mean(measured.map((i) => i.r.priceR as number)),
    avgCostR: mean(measured.map((i) => i.r.costR as number)),
    estimated: measured.filter((i) => i.r.stop0Source === 'okx_last').length,
    unmeasured: { count: unmeasuredCount, net: unmeasuredNet, byReason },
    points: measured.map((i, k) => ({
      t: Date.parse(i.trade.exit_at as string),
      seq: i.trade.seq,
      symbol: i.trade.symbol,
      r: rs[k],
      cum: cum[k],
      roll20: r20[k],
      roll50: r50[k],
    })),
    bins: rBins(rs),
  };
}
