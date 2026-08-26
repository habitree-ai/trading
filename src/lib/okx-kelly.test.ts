import { describe, expect, it } from 'vitest';

import { enrich, loadOkxKelly, MIN_SAMPLE } from '@/lib/okx-kelly';

describe('enrich — 집계본을 켈리까지 채운다', () => {
  it('승률·손익비·켈리를 집계 입력에서 그대로 낸다', () => {
    // 승 2 · 패 1, 평균수익 20 · 평균손실 10 → W 2/3, b 2, f* = 2/3 − (1/3)/2 = 0.5
    const row = enrich('A', { n: 3, wins: 2, losses: 1, avgWin: 20, avgLoss: 10, netPnl: 30 });

    expect(row.winRate).toBeCloseTo(2 / 3, 10);
    expect(row.payoffRatio).toBeCloseTo(2, 10);
    expect(row.kelly).toBeCloseTo(0.5, 10);
    expect(row.decided).toBe(3);
  });

  it('본전은 승률의 분모에서 빠진다 — 앱의 KPI 와 같은 처리', () => {
    // n 4 인데 승 2 · 패 1 → 나머지 1건은 본전. 승률은 2/3 이지 2/4 가 아니다.
    const row = enrich('A', { n: 4, wins: 2, losses: 1, avgWin: 20, avgLoss: 10, netPnl: 30 });

    expect(row.decided).toBe(3);
    expect(row.winRate).toBeCloseTo(2 / 3, 10);
  });

  it('패가 없으면 손익비도 켈리도 정의되지 않는다', () => {
    const row = enrich('A', { n: 2, wins: 2, losses: 0, avgWin: 20, avgLoss: null, netPnl: 40 });

    expect(row.payoffRatio).toBeNull();
    expect(row.kelly).toBeNull();
  });

  it('승이 없어도 마찬가지다', () => {
    const row = enrich('A', { n: 2, wins: 0, losses: 2, avgWin: null, avgLoss: 10, netPnl: -20 });

    expect(row.winRate).toBe(0);
    expect(row.kelly).toBeNull();
  });
});

describe('loadOkxKelly — 커밋된 집계본', () => {
  const report = loadOkxKelly();

  it('전 구간 켈리가 승률·손익비에서 나온다', () => {
    const { overall } = report;
    const expected =
      overall.winRate! - (1 - overall.winRate!) / overall.payoffRatio!;

    expect(overall.kelly).toBeCloseTo(expected, 10);
  });

  it('모든 차원의 거래 수 합계가 전체와 같다 — 칸을 흘리지 않았다', () => {
    for (const dim of report.dimensions) {
      const sum = dim.rows.reduce((a, r) => a + r.n, 0);
      expect(sum, `${dim.label} 합계`).toBe(report.overall.n);
    }
  });

  it('크기순 축이 아닌 표는 켈리 내림차순이고, 표본 미달은 아래로 내려간다', () => {
    for (const dim of report.dimensions.filter((d) => !d.ordered)) {
      const thick = dim.rows.filter((r) => r.decided >= MIN_SAMPLE);
      const firstThin = dim.rows.findIndex((r) => r.decided < MIN_SAMPLE);

      // 표본이 받쳐 주는 칸이 전부 앞에 온다.
      if (firstThin >= 0) expect(firstThin).toBe(thick.length);

      const kellies = thick.map((r) => r.kelly ?? -Infinity);
      expect(kellies, `${dim.label} 정렬`).toEqual([...kellies].sort((a, b) => b - a));
    }
  });

  it('보유시간 축은 집계본 순서(짧은 것부터)를 지킨다', () => {
    const hold = report.dimensions.find((d) => d.key === 'hold');

    expect(hold?.ordered).toBe(true);
    expect(hold?.rows[0].key).toBe('1분 미만');
  });
});
