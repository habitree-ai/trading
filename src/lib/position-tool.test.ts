import { describe, expect, it } from 'vitest';

import { positionMetrics } from '@/lib/position-tool';

describe('positionMetrics', () => {
  it('롱 — 목표까지 2, 손절까지 1이면 손익비 2', () => {
    const m = positionMetrics({ side: 'long', entry: 100, stop: 99, target: 102 });
    expect(m?.rewardPct).toBeCloseTo(0.02, 10);
    expect(m?.riskPct).toBeCloseTo(0.01, 10);
    expect(m?.rr).toBeCloseTo(2, 10);
    expect(m?.problem).toBeNull();
  });

  it('숏 — 방향이 뒤집혀도 폭은 양수로 잰다', () => {
    const m = positionMetrics({ side: 'short', entry: 100, stop: 103, target: 94 });
    expect(m?.rewardPct).toBeCloseTo(0.06, 10);
    expect(m?.riskPct).toBeCloseTo(0.03, 10);
    expect(m?.rr).toBeCloseTo(2, 10);
    expect(m?.problem).toBeNull();
  });

  it('명목가가 있으면 금액까지 낸다 — 손실은 음수', () => {
    const m = positionMetrics({ side: 'long', entry: 100, stop: 99, target: 102, notional: 500 });
    expect(m?.rewardAmount).toBeCloseTo(10, 10);
    expect(m?.lossAmount).toBeCloseTo(-5, 10);
  });

  it('명목가가 없으면 비율만 낸다', () => {
    const m = positionMetrics({ side: 'long', entry: 100, stop: 99, target: 102 });
    expect(m?.rewardAmount).toBeNull();
    expect(m?.lossAmount).toBeNull();
  });

  it('롱인데 손절이 진입 위면 짚어 준다', () => {
    const m = positionMetrics({ side: 'long', entry: 100, stop: 101, target: 102 });
    expect(m?.problem).toBe('롱은 손절이 진입보다 낮고 목표가 높아야 합니다.');
  });

  it('숏인데 목표가 진입 위면 짚어 준다', () => {
    const m = positionMetrics({ side: 'short', entry: 100, stop: 103, target: 105 });
    expect(m?.problem).toBe('숏은 손절이 진입보다 높고 목표가 낮아야 합니다.');
  });

  it('손절이 진입과 같으면 손익비가 정의되지 않는다', () => {
    const m = positionMetrics({ side: 'long', entry: 100, stop: 100, target: 102 });
    expect(m?.rr).toBeNull();
  });

  it('진입가가 0이면 잴 기준이 없다', () => {
    expect(positionMetrics({ side: 'long', entry: 0, stop: -1, target: 1 })).toBeNull();
  });
});
