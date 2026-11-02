import { describe, expect, it } from 'vitest';

import { entryCalc, parsePositive, type EntryCalc } from '@/lib/entry-calc';

/** 명세 예시 ① — 기준 R 10, 롱 100,000. 수수료율은 A 의 왕복 비용이 0.01 BTC 에 1 USDT(−1.10R)가 되게. */
const FEE = 0.0005025;
const base = { side: 'long' as const, entry: 100_000, rBase: 10, feeRate: FEE, equity: 100, riskFactor: 1 };

const measured = (c: EntryCalc) => {
  if (!c.measured) throw new Error(`R 미측정: ${c.reason}`);
  return c;
};

describe('명세 예시 ① — 같은 수익, 다른 위험', () => {
  it('A 손절 99,000: 1E 0.01, 0.01 을 넣으면 위험 배수 1.10 (손절 시 −1.10R)', () => {
    const c = measured(entryCalc({ ...base, stop: 99_000, qty: 0.01 }));
    expect(c.oneE).toBeCloseTo(0.01, 12);
    expect(c.actual?.riskMultiple).toBeCloseTo(1.1, 4);
    expect(c.actual?.costR).toBeCloseTo(0.1, 4);
    expect(c.over).toBe(true);
  });

  it('B 손절 96,000: 0.01 을 넣으면 위험 배수 4.10', () => {
    const c = measured(entryCalc({ ...base, stop: 96_000, qty: 0.01 }));
    expect(c.actual?.riskMultiple).toBeCloseTo(4.1, 2);
    expect(c.over).toBe(true);
  });

  it('비용 포함 1R 수량 = 10 ÷ (1,000 + 199,000 × 수수료율) = 0.0090909 — 그 수량이면 정확히 1.00', () => {
    const c = measured(entryCalc({ ...base, stop: 99_000 }));
    expect(c.target.qty).toBeCloseTo(10 / (1000 + 199_000 * FEE), 12);
    expect(c.target.qty).toBeCloseTo(0.0090909, 7);
    expect(c.target.riskMultiple).toBeCloseTo(1, 12);
    expect(c.full.qty).toBe(c.target.qty);
    expect(c.actual).toBeNull();
    expect(c.over).toBe(false);
  });

  it('명목·레버리지 — 자금 100 이면 0.0090909 × 100,000 = 909 USDT, 9.09배', () => {
    const c = measured(entryCalc({ ...base, stop: 99_000 }));
    expect(c.target.notional).toBeCloseTo(909.09, 1);
    expect(c.target.leverage).toBeCloseTo(9.0909, 3);
  });

  it('자금을 모르면 레버리지를 비운다', () => {
    const c = measured(entryCalc({ ...base, stop: 99_000, equity: null }));
    expect(c.target.leverage).toBeNull();
  });
});

describe('축소 단계 — 0.5R', () => {
  const c = measured(entryCalc({ ...base, stop: 99_000, riskFactor: 0.5, qty: 0.006 }));

  it('목표 위험 5 USDT, 수량은 1R 수량의 절반', () => {
    expect(c.targetRisk).toBe(5);
    expect(c.target.qty).toBeCloseTo(c.full.qty / 2, 12);
    expect(c.target.riskMultiple).toBeCloseTo(0.5, 12);
  });

  it('경고 기준도 0.5 — 1R 아래(0.66)여도 넘으면 경고', () => {
    expect(c.actual?.riskMultiple).toBeCloseTo(0.66, 2);
    expect(c.over).toBe(true);
  });
});

describe('숏·R 미측정', () => {
  it('숏 ONDO 0.3906 손절 0.399 — 손절폭 0.0084, 1E 1,190.48', () => {
    const c = measured(
      entryCalc({ side: 'short', entry: 0.3906, stop: 0.399, rBase: 10, feeRate: 0, equity: null, riskFactor: 1 }),
    );
    expect(c.d0).toBeCloseTo(0.0084, 12);
    expect(c.oneE).toBeCloseTo(1190.476, 3);
    expect(c.target.qty).toBeCloseTo(c.oneE, 9); // 수수료 0 이면 1R 수량 = 1E
  });

  it('손절이 비면 「최초 손절 없음」, 이익 쪽이면 「손절이 이익 쪽」, 진입가가 비면 「진입가 없음」', () => {
    expect(entryCalc({ ...base, stop: null })).toEqual({ measured: false, reason: 'no_stop' });
    expect(entryCalc({ ...base, stop: 101_000 })).toEqual({ measured: false, reason: 'stop_wrong_side' });
    expect(entryCalc({ ...base, side: 'short', stop: 99_000 })).toEqual({ measured: false, reason: 'stop_wrong_side' });
    expect(entryCalc({ ...base, entry: null, stop: 99_000 })).toEqual({ measured: false, reason: 'no_entry' });
  });
});

describe('parsePositive', () => {
  it('쉼표 허용, 빈 칸·0·음수·글자는 null', () => {
    expect(parsePositive('100,000')).toBe(100_000);
    expect(parsePositive(' 0.399 ')).toBe(0.399);
    expect(parsePositive('')).toBeNull();
    expect(parsePositive('0')).toBeNull();
    expect(parsePositive('-1')).toBeNull();
    expect(parsePositive('12abc')).toBeNull();
  });
});
