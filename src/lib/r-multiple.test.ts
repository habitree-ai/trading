import { describe, expect, it } from 'vitest';

import { entrySizeOf, parseRBaseInput, tradeR, type RFill, type RTrade } from '@/lib/r-multiple';

/** 명세 「계산 예시」 ① — 기준 R 10 USDT, BTC 롱, 테이커 0.05%(진입·청산 각각). */
function exampleOne(stop: number): RTrade {
  const entryFee = 100_000 * 0.01 * 0.0005; // 0.5
  const exitFee = 102_000 * 0.01 * 0.0005; // 0.51
  return {
    side: 'long',
    entry_price: 100_000,
    notional: 1_000,
    pnl: 20,
    fee: -(entryFee + exitFee),
    funding_fee: null,
    realized_pnl: null,
    exit_at: '2026-11-01T01:00:00Z',
    result: 'win',
    stop_px_0: stop,
    stop_px_0_source: 'plan',
    r_base_at_entry: 10,
    fee_rate_at_entry: 0.0005,
  };
}

describe('tradeR — 명세 예시 ① 같은 수익, 다른 위험', () => {
  it('A: 손절 99,000 → 최초 위험 10, +1.90R, 위험 배수 1.10(비용 포함)', () => {
    const r = tradeR(exampleOne(99_000));
    expect(r.measurable).toBe(true);
    expect(r.initialRisk).toBeCloseTo(10, 10);
    expect(r.rMultiple).toBeCloseTo(1.899, 10);
    expect(r.baseRPnl).toBeCloseTo(1.899, 10);
    expect(r.riskMultiple).toBeCloseTo(1.0995, 10);
    expect(r.priceR).toBeCloseTo(2, 10);
    expect(r.costR).toBeCloseTo(0.101, 10);
    expect((r.priceR as number) - (r.costR as number)).toBeCloseTo(r.rMultiple as number, 10);
  });

  it('B: 손절 96,000 → 최초 위험 40, +0.47R, 기준R 손익은 A 와 같은 +1.90', () => {
    const r = tradeR(exampleOne(96_000));
    expect(r.initialRisk).toBeCloseTo(40, 10);
    expect(r.rMultiple).toBeCloseTo(0.474_75, 10);
    expect(r.baseRPnl).toBeCloseTo(1.899, 10);
    expect(r.riskMultiple).toBeCloseTo(4.098, 10);
  });
});

describe('tradeR — 예외', () => {
  it('숏은 손절가 − 진입가로 잰다', () => {
    const r = tradeR({ ...exampleOne(101_000), side: 'short', pnl: -20, fee: -1.01, result: 'loss' });
    expect(r.initialRisk).toBeCloseTo(10, 10);
    expect(r.rMultiple).toBeCloseTo(-2.101, 10);
  });

  it('최초 손절이 없으면 R 미측정(no_stop) — 기준R 손익은 낸다', () => {
    const r = tradeR({ ...exampleOne(99_000), stop_px_0: null });
    expect(r.measurable).toBe(false);
    expect(r.reason).toBe('no_stop');
    expect(r.rMultiple).toBeNull();
    expect(r.baseRPnl).toBeCloseTo(1.899, 10);
  });

  it('손절이 진입가 반대편이면 stop_wrong_side', () => {
    const r = tradeR(exampleOne(100_500));
    expect(r.measurable).toBe(false);
    expect(r.reason).toBe('stop_wrong_side');
  });

  it('최초 손절 출처를 그대로 싣는다', () => {
    expect(tradeR({ ...exampleOne(99_000), stop_px_0_source: 'okx_last' }).stop0Source).toBe('okx_last');
  });

  it('수량을 모르면 no_qty', () => {
    const r = tradeR({ ...exampleOne(99_000), notional: null });
    expect(r.reason).toBe('no_qty');
  });

  it('보유 중이면 최초 위험·위험 배수만 있고 R 배수는 없다', () => {
    const r = tradeR({ ...exampleOne(99_000), exit_at: null, result: 'open', pnl: null });
    expect(r.measurable).toBe(false);
    expect(r.reason).toBeNull();
    expect(r.initialRisk).toBeCloseTo(10, 10);
    expect(r.rMultiple).toBeNull();
  });

  it('기준 R 스냅샷이 없으면 위험 배수·기준R 손익만 비고 R 배수는 낸다', () => {
    const r = tradeR({ ...exampleOne(99_000), r_base_at_entry: null });
    expect(r.rMultiple).toBeCloseTo(1.899, 10);
    expect(r.riskMultiple).toBeNull();
    expect(r.baseRPnl).toBeNull();
  });

  it('거래소 실현손익이 있으면 그쪽이 순손익 정본', () => {
    const r = tradeR({ ...exampleOne(99_000), realized_pnl: 15 });
    expect(r.rMultiple).toBeCloseTo(1.5, 10);
    expect(r.costR).toBeCloseTo(0.5, 10);
  });
});

describe('entrySizeOf — 진입 크기', () => {
  const fill = (at: string, price: number, amount: number, role: 'open' | 'close' = 'open'): RFill => ({
    role,
    filled_at: at,
    price,
    amount,
  });
  const fills = [
    fill('2026-11-01T00:00:00Z', 100_000, 1_000),
    fill('2026-11-01T00:05:00Z', 102_000, 1_020),
    fill('2026-11-01T00:10:00Z', 105_000, 1_050, 'close'),
  ];

  it('청산 거래는 평균 진입가·명목가 — 추가 진입분도 분모에 든다(명세 10/17 숫자와 같은 방식)', () => {
    expect(entrySizeOf({ entry_price: 101_000, notional: 2_020 }, fills, false)).toEqual({ price: 101_000, qty: 0.02 });
  });

  it('보유 중이면 진입 체결 합계 — 명목가는 남은 물량이라 쓰지 않는다', () => {
    const size = entrySizeOf({ entry_price: 101_000, notional: 1_010 }, fills, true);
    expect(size?.qty).toBeCloseTo(0.02, 10);
    expect(size?.price).toBeCloseTo(101_000, 6);
  });

  it('보유 중인데 체결이 없으면 진입가·명목가로 되짚는다', () => {
    expect(entrySizeOf({ entry_price: 100_000, notional: 1_000 }, [], true)).toEqual({ price: 100_000, qty: 0.01 });
  });
});

describe('parseRBaseInput — 설정 입력', () => {
  it('금액과 % 수수료율을 이력 행 값으로 바꾼다', () => {
    expect(parseRBaseInput('1,000', '0.05')).toEqual({ amount: 1000, feeRate: 0.0005 });
  });

  it('0 이하 금액, 빈 수수료율, 1% 이상 수수료율은 막는다', () => {
    expect(parseRBaseInput('0', '0.05')).toHaveProperty('error');
    expect(parseRBaseInput('10', '')).toHaveProperty('error');
    expect(parseRBaseInput('10', '1')).toHaveProperty('error');
    expect(parseRBaseInput('abc', '0.05')).toHaveProperty('error');
  });

  it('수수료율 0 은 허용', () => {
    expect(parseRBaseInput('10', '0')).toEqual({ amount: 10, feeRate: 0 });
  });
});
