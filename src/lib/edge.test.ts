import { describe, expect, it } from 'vitest';

import { cumulativeR, edgeInterval, edgeStats, edgeVerdict, rollingEdge } from '@/lib/edge';

describe('edgeStats — 명세 예시 ② 10건', () => {
  const rs = [2.0, -1.1, -1.0, 3.0, -1.1, 0.5, -1.0, -0.3, 1.5, -1.0];
  const s = edgeStats(rs);

  it('승률 40%, W̄ 1.75R, L̄ 0.917R', () => {
    expect(s.winRate).toBeCloseTo(0.4, 10);
    expect(s.avgWinR).toBeCloseTo(1.75, 10);
    expect(s.avgLossR).toBeCloseTo(5.5 / 6, 10);
  });

  it('엣지 +0.15R, 검산(R 배수 평균)과 같다', () => {
    expect(s.edge).toBeCloseTo(0.15, 10);
    expect(s.meanR).toBeCloseTo(0.15, 10);
  });

  it('손익비 1.91, 본전 승률 34.4%', () => {
    expect(s.payoff).toBeCloseTo(1.909, 3);
    expect(s.breakEvenWinRate).toBeCloseTo(0.344, 3);
  });
});

describe('edgeStats — 경계', () => {
  it('본전(0R)은 패로 센다 — 엣지와 평균이 여전히 같다', () => {
    const s = edgeStats([1, 0, -1, 0]);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(3);
    expect(s.edge).toBeCloseTo(s.meanR as number, 10);
  });

  it('빈 표본은 전부 null', () => {
    const s = edgeStats([]);
    expect(s.edge).toBeNull();
    expect(s.winRate).toBeNull();
  });

  it('전승이면 L̄·손익비가 없고 엣지는 W̄', () => {
    const s = edgeStats([1, 2]);
    expect(s.avgLossR).toBeNull();
    expect(s.payoff).toBeNull();
    expect(s.edge).toBeCloseTo(1.5, 10);
  });
});

describe('edgeInterval · edgeVerdict', () => {
  it('같은 시드면 같은 구간, 구간은 평균을 품는다', () => {
    const rs = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 2 : -0.5));
    const a = edgeInterval(rs);
    const b = edgeInterval(rs);
    expect(a).toEqual(b);
    const [lo, hi] = a as [number, number];
    expect(lo).toBeLessThan(1 / 3);
    expect(hi).toBeGreaterThan(1 / 3);
  });

  it('N < 50 이면 표본 부족', () => {
    expect(edgeVerdict(49, [0.1, 0.5])).toBe('insufficient');
  });

  it('구간 하단 > 0 확인, 상단 < 0 음수, 0 을 품으면 판정 불가', () => {
    expect(edgeVerdict(121, [0.05, 0.4])).toBe('positive');
    expect(edgeVerdict(121, [-0.61, -0.07])).toBe('negative');
    expect(edgeVerdict(121, [-0.2, 0.3])).toBe('undetermined');
  });
});

describe('rollingEdge · cumulativeR', () => {
  it('창이 차기 전은 null, 그 뒤는 마지막 창 평균', () => {
    expect(rollingEdge([1, -1, 2, 0], 2)).toEqual([null, 0, 0.5, 1]);
  });

  it('누적 R', () => {
    expect(cumulativeR([1, -1, 2])).toEqual([1, 0, 2]);
  });
});
