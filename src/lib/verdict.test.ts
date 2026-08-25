import { describe, expect, it } from 'vitest';

import {
  breakEvenWinRate,
  readBalanceGap,
  readCost,
  readDrawdown,
  readExpectancy,
  readKelly,
  readKellyFit,
  readLossStreak,
  readRisk,
  readSample,
  readWinRate,
  recoveryNeeded,
} from '@/lib/verdict';

describe('breakEvenWinRate', () => {
  it('손익비 1이면 본전 승률은 50%', () => {
    expect(breakEvenWinRate(1)).toBeCloseTo(0.5, 10);
  });

  it('손익비가 커질수록 본전 승률은 내려간다', () => {
    expect(breakEvenWinRate(3)).toBeCloseTo(0.25, 10);
  });

  it('손익비가 없거나 0 이하면 기준을 못 잡는다', () => {
    expect(breakEvenWinRate(null)).toBeNull();
    expect(breakEvenWinRate(0)).toBeNull();
  });
});

describe('recoveryNeeded', () => {
  it('50% 잃으면 100%를 벌어야 돌아온다', () => {
    expect(recoveryNeeded(-0.5)).toBeCloseTo(1, 10);
  });

  it('낙폭이 없으면 회복도 필요 없다', () => {
    expect(recoveryNeeded(0)).toBeNull();
  });

  it('원금을 다 잃었으면 정의되지 않는다', () => {
    expect(recoveryNeeded(-1)).toBeNull();
  });
});

describe('readWinRate', () => {
  it('본전 승률보다 넉넉히 앞서면 좋음', () => {
    // 손익비 1 → 본전 50%. 60%면 10%p 앞선다.
    expect(readWinRate(0.6, 1).tone).toBe('good');
  });

  it('여유가 얇으면 주의 — 비용이 조금만 커져도 뒤집힌다', () => {
    expect(readWinRate(0.52, 1).tone).toBe('warn');
  });

  it('본전에 못 미치면 나쁨', () => {
    expect(readWinRate(0.45, 1).tone).toBe('bad');
  });

  it('손익비가 높으면 낮은 승률도 좋음으로 읽힌다', () => {
    // 손익비 3 → 본전 25%. 35%면 충분하다.
    expect(readWinRate(0.35, 3).tone).toBe('good');
  });
});

describe('readDrawdown', () => {
  it('10% 안쪽은 좋음', () => {
    expect(readDrawdown(-0.08).tone).toBe('good');
  });

  it('10~20%는 주의', () => {
    expect(readDrawdown(-0.18).tone).toBe('warn');
  });

  it('20%를 넘으면 나쁨이고 회복 수익률을 함께 알린다', () => {
    const v = readDrawdown(-0.5);
    expect(v.tone).toBe('bad');
    expect(v.text).toContain('100.0%');
  });
});

describe('readRisk', () => {
  it('2% 이내면 좋음', () => {
    expect(readRisk(0.015).tone).toBe('good');
  });

  it('5%를 넘으면 나쁨', () => {
    expect(readRisk(0.08).tone).toBe('bad');
  });

  it('손절가가 없으면 판단하지 않는다', () => {
    expect(readRisk(null).tone).toBe('neutral');
  });
});

describe('readExpectancy', () => {
  it('양수면 반복할수록 는다', () => {
    expect(readExpectancy(0.42).tone).toBe('good');
  });

  it('음수면 반복할수록 준다', () => {
    expect(readExpectancy(-0.2).tone).toBe('bad');
  });
});

describe('readSample', () => {
  it('30건이 안 되면 흔들린다고 알린다', () => {
    expect(readSample(12).tone).toBe('warn');
  });

  it('30건부터는 믿고 볼 만하다', () => {
    expect(readSample(30).tone).toBe('neutral');
  });
});

describe('readKelly', () => {
  it('승·패가 다 없으면 판단하지 않는다', () => {
    expect(readKelly(null, 50).tone).toBe('neutral');
  });

  it('켈리가 0 이하면 크기가 아니라 방식의 문제다', () => {
    expect(readKelly(-0.1, 50).tone).toBe('bad');
  });

  it('표본이 얇으면 켈리가 양수여도 경고한다 — 오차를 키우는 지표라서', () => {
    expect(readKelly(0.2, 12).tone).toBe('warn');
  });

  it('표본이 충분하면 절반 켈리를 실전 상한으로 말한다', () => {
    const v = readKelly(0.2, 40);
    expect(v.tone).toBe('good');
    expect(v.text).toContain('10.0%');
  });
});

describe('readKellyFit', () => {
  it('둘 중 하나라도 없으면 견줄 수 없다', () => {
    expect(readKellyFit(null, 0.02).tone).toBe('neutral');
    expect(readKellyFit(0.2, null).tone).toBe('neutral');
  });

  it('켈리를 넘기면 나쁨', () => {
    expect(readKellyFit(0.2, 0.25).tone).toBe('bad');
  });

  it('절반 켈리와 켈리 사이면 주의', () => {
    expect(readKellyFit(0.2, 0.15).tone).toBe('warn');
  });

  it('절반 켈리 안쪽이면 좋음', () => {
    expect(readKellyFit(0.2, 0.05).tone).toBe('good');
  });

  it('켈리가 0 이하인데 잃고 있으면 걸수록 줄어드는 구간이다', () => {
    expect(readKellyFit(-0.1, 0.05).tone).toBe('bad');
  });
});

describe('readLossStreak', () => {
  it('연패가 없으면 알릴 게 없다', () => {
    expect(readLossStreak(0, 0.02).tone).toBe('neutral');
  });

  it('같은 폭으로 다시 겪었을 때 깎이는 자금을 함께 말한다', () => {
    // 2%씩 5연패 → 1 - 0.98^5 ≈ 9.6%
    expect(readLossStreak(5, 0.02).text).toContain('9.6%');
  });
});

describe('readBalanceGap', () => {
  it('오차가 반올림 수준이면 일치로 본다', () => {
    expect(readBalanceGap(1000.2, 1000).tone).toBe('good');
  });

  it('2%를 넘게 벌어지면 놓친 게 있다고 본다', () => {
    expect(readBalanceGap(1050, 1000).tone).toBe('bad');
  });

  it('거래소 잔고가 없으면 판단하지 않는다', () => {
    expect(readBalanceGap(1000, null).tone).toBe('neutral');
  });

  /*
   * 재현: 포지션을 들고 있는 내내 "놓친 거래나 입출금이 있습니다"가 떴다.
   *
   * 거래소 잔고에는 미청산 포지션의 손익이 들어 있는데 계산 자금은 청산분만 더한다.
   * 자금이 60인 계좌에서는 1.2만 어긋나도 2% 선을 넘어 상시 오경보가 된다.
   * 실측치(잔고 60.60, 계산 61.36, 미청산 -0.76)를 그대로 넣어 둔다.
   */
  it('미청산 손익은 걷어내고 견준다', () => {
    expect(readBalanceGap(61.36, 60.6, -0.76).tone).toBe('good');
    // 같은 값이라도 미청산분을 모르면 예전처럼 벌어져 보인다.
    expect(readBalanceGap(61.36, 60.6, null).tone).toBe('warn');
  });

  /*
   * 미실현 가격손익만 빼면 그 포지션이 이미 낸 수수료가 남아 여전히 어긋난다.
   * 같은 순간의 미실현분은 -0.34였고, 나머지 -0.42가 수수료였다.
   */
  it('이미 낸 수수료까지 걷어내야 맞는다', () => {
    expect(readBalanceGap(61.36, 60.6, -0.34).tone).not.toBe('good');
  });

  it('미청산분을 걷어내도 남는 차이는 그대로 잡는다', () => {
    // 잔고 100(미실현 +5) → 청산 기준 95인데 계산은 80. 15는 진짜 누락이다.
    expect(readBalanceGap(80, 100, 5).tone).toBe('bad');
  });

  it('얼마를 걷어냈는지 문구에 남긴다', () => {
    expect(readBalanceGap(61.36, 60.6, -0.76).text).toContain('미청산');
  });
});

describe('readCost', () => {
  /*
   * 실계좌 값: 가격 손익 −64.81, 수수료 −266.30, 펀딩비 −0.75, 실현손익 −337.08.
   * 손실의 79%가 비용이라 "방향보다 회전율"이 먼저다.
   */
  it('비용이 손실의 절반을 넘으면 회전율을 짚는다', () => {
    const v = readCost({ pnlBeforeCost: -64.81, cost: -267.05, netPnl: -337.08, flipped: 5 });
    expect(v.tone).toBe('bad');
    expect(v.text).toContain('79%');
    expect(v.text).toContain('회전율');
  });

  it('가격으로는 벌었는데 비용에 밀려 계좌가 줄면 그걸 먼저 말한다', () => {
    const v = readCost({ pnlBeforeCost: 30, cost: -50, netPnl: -20, flipped: 3 });
    expect(v.tone).toBe('bad');
    expect(v.text).toContain('가격으로는');
  });

  it('비용을 내고도 남았으면 좋음', () => {
    expect(readCost({ pnlBeforeCost: 300, cost: -50, netPnl: 250, flipped: 0 }).tone).toBe('good');
  });

  it('비용에 밀려 뒤집힌 거래 수를 함께 알린다', () => {
    expect(
      readCost({ pnlBeforeCost: -64.81, cost: -267.05, netPnl: -337.08, flipped: 5 }).text,
    ).toContain('5건');
  });

  it('수수료가 기록되지 않았으면 판단하지 않는다', () => {
    expect(readCost({ pnlBeforeCost: 10, cost: 0, netPnl: 10, flipped: 0 }).tone).toBe('neutral');
  });
});
