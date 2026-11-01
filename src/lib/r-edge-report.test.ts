import { describe, expect, it } from 'vitest';

import { buildREdgeReport, rBins, type RItem } from '@/lib/r-edge-report';
import type { TradeR } from '@/lib/r-multiple';

function item(seq: number, r: Partial<TradeR>, net = 0): RItem {
  return {
    trade: {
      id: `t${seq}`,
      seq,
      symbol: 'BTC',
      exit_at: new Date(Date.UTC(2026, 10, 1, 0, seq)).toISOString(),
      realized_pnl: net,
      pnl: net,
      fee: null,
      funding_fee: null,
    },
    r: {
      measurable: true,
      reason: null,
      closed: true,
      entry0: 100,
      qty0: 1,
      stop0: 99,
      stop0Source: 'plan',
      initialRisk: 1,
      riskMultiple: null,
      rMultiple: 0,
      priceR: 0,
      costR: 0,
      baseRPnl: null,
      ...r,
    },
  };
}

describe('buildREdgeReport', () => {
  // 명세 예시 ② 10건 + 미측정 2건 + 보유 1건
  const rs = [2.0, -1.1, -1.0, 3.0, -1.1, 0.5, -1.0, -0.3, 1.5, -1.0];
  const items: RItem[] = [
    ...rs.map((r, i) => item(i + 1, { rMultiple: r, priceR: r + 0.1, costR: 0.1, stop0Source: i < 3 ? 'okx_last' : 'plan' })),
    item(20, { measurable: false, reason: 'stop_wrong_side', rMultiple: null }, 30),
    item(21, { measurable: false, reason: 'no_stop', rMultiple: null }, -5),
    item(22, { measurable: false, closed: false, rMultiple: null }),
  ];
  const report = buildREdgeReport(items);

  it('엣지는 측정된 10건으로 +0.15R, 표본 부족', () => {
    expect(report.stats.n).toBe(10);
    expect(report.stats.edge).toBeCloseTo(0.15, 10);
    expect(report.verdict).toBe('insufficient');
  });

  it('수수료 전 엣지 = 가격R 평균, 평균 비용R', () => {
    expect(report.edgeBeforeCost).toBeCloseTo(0.25, 10);
    expect(report.avgCostR).toBeCloseTo(0.1, 10);
  });

  it('미측정은 청산 거래만 — 건수·순손익 합계·이유. 보유 중은 세지 않는다', () => {
    expect(report.unmeasured.count).toBe(2);
    expect(report.unmeasured.net).toBe(25);
    expect(report.unmeasured.byReason).toEqual({ no_stop: 1, stop_wrong_side: 1, no_qty: 0 });
  });

  it('추정 손절 건수, 누적 R 마지막 = 합계', () => {
    expect(report.estimated).toBe(3);
    expect(report.points.at(-1)?.cum).toBeCloseTo(1.5, 10);
  });
});

describe('rBins', () => {
  it('0.5R 폭, 끝 구간이 바깥 값을 모은다', () => {
    const bins = rBins([-10, -1.1, -1.0, 0, 0.4, 9]);
    expect(bins[0].count).toBe(1); // -10 → ≤-2.5
    expect(bins.at(-1)?.count).toBe(1); // 9 → ≥4.5
    expect(bins.find((b) => b.from === -1.5)?.count).toBe(1); // -1.1
    expect(bins.find((b) => b.from === -1)?.count).toBe(1); // -1.0
    expect(bins.find((b) => b.from === 0)?.count).toBe(2); // 0, 0.4
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(6);
  });
});
