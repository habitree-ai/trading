import { describe, expect, it } from 'vitest';

import type { Book, Trade, TradeResult } from '@/lib/domain';
import {
  bucketBy,
  computeMetrics,
  crossCheckPnl,
  deriveTrades,
  groupPerformance,
  monthKey,
} from '@/lib/metrics';

const book: Book = {
  id: 'b1',
  user_id: 'u1',
  name: '테스트북',
  exchange: null,
  base_currency: 'USDT',
  initial_capital: 100,
  start_date: '2026-01-01',
  status: 'active',
  memo: null,
  created_at: '2026-01-01T00:00:00Z',
};

let seq = 0;

function trade(partial: Partial<Trade> & { pnl: number; result: TradeResult }): Trade {
  seq += 1;
  return {
    id: `t${seq}`,
    book_id: 'b1',
    user_id: 'u1',
    seq,
    side: 'long',
    symbol: 'BTC',
    entry_at: `2026-01-${String(seq).padStart(2, '0')}T00:00:00Z`,
    exit_at: `2026-01-${String(seq).padStart(2, '0')}T01:00:00Z`,
    equity_before: null,
    equity_after: null,
    withdrawal: null,
    notional: null,
    leverage: null,
    entry_price: null,
    exit_price: null,
    fee: null,
    funding_fee: null,
    margin_mode: null,
    stop_price: null,
    tp1_price: null,
    tp2_price: null,
    tp3_price: null,
    setup: null,
    rationale: null,
    review: null,
    emotion: null,
    note: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

describe('deriveTrades — 자금 곡선', () => {
  it('equity_after가 비면 직전 자금 + 손익 − 출금으로 이어 붙인다', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      trade({ pnl: 20, result: 'win' }),
      trade({ pnl: -30, result: 'loss' }),
      trade({ pnl: 10, result: 'win', withdrawal: 5 }),
    ]);

    expect(derived.map((d) => d.equityAfter)).toEqual([120, 90, 95]);
    expect(derived.map((d) => d.peak)).toEqual([120, 120, 120]);
  });

  it('equity_after가 있으면 그 실측치를 정본으로 쓴다', () => {
    seq = 0;
    const derived = deriveTrades(book, [trade({ pnl: 20, result: 'win', equity_after: 118.5 })]);
    expect(derived[0].equityAfter).toBe(118.5);
  });

  it('MDD하락률은 그 시점까지의 최고치 대비 낙폭이다', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      trade({ pnl: 100, result: 'win' }), // 200, peak 200
      trade({ pnl: -50, result: 'loss' }), // 150, dd -25%
    ]);

    expect(derived[1].drawdownPct).toBeCloseTo(-0.25, 10);
  });

  it('RR과 손실율을 진입가·손절가·익절가에서 계산한다', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      trade({
        pnl: 0,
        result: 'be',
        entry_price: 100,
        stop_price: 90,
        tp1_price: 120,
        tp2_price: 150,
      }),
    ]);

    expect(derived[0].riskPct).toBeCloseTo(0.1, 10);
    expect(derived[0].rr[0]).toBeCloseTo(2, 10); // 20 / 10
    expect(derived[0].rr[1]).toBeCloseTo(5, 10); // 50 / 10
    expect(derived[0].rr[2]).toBeNull();
  });
});

describe('computeMetrics — 시트 KPI 블록', () => {
  it('승률·손익비·기대치값을 시트 산식대로 계산한다', () => {
    seq = 0;
    // 승 2건(평균 +30), 패 2건(평균 -10) → 승률 50%, 손익비 3
    const derived = deriveTrades(book, [
      trade({ pnl: 20, result: 'win' }),
      trade({ pnl: 40, result: 'win' }),
      trade({ pnl: -5, result: 'loss' }),
      trade({ pnl: -15, result: 'loss' }),
    ]);
    const m = computeMetrics(book, derived);

    expect(m.winRate).toBeCloseTo(0.5, 10);
    expect(m.avgWin).toBeCloseTo(30, 10);
    expect(m.avgLoss).toBeCloseTo(10, 10);
    expect(m.payoffRatio).toBeCloseTo(3, 10);
    expect(m.winExpectancy).toBeCloseTo(1.5, 10); // 0.5 × 3
    expect(m.lossExpectancy).toBeCloseTo(0.5, 10); // 패률
    expect(m.expectancy).toBeCloseTo(1.0, 10); // 1.5 − 0.5
    expect(m.profitFactor).toBeCloseTo(3, 10); // 60 / 20
  });

  it('구글시트 첫 탭 요약값(승 9 · 패 15 · 승율 37.5%)을 재현한다', () => {
    seq = 0;
    // 시트 탭1: 평균수익 9.48625, 평균손실 10.0975 → 이익기대치 0.35 · 손실기대치 0.63 · 기대치값 −0.27
    const wins = Array.from({ length: 9 }, () => trade({ pnl: 9.48625, result: 'win' }));
    const losses = Array.from({ length: 15 }, () => trade({ pnl: -10.0975, result: 'loss' }));
    const m = computeMetrics(book, deriveTrades(book, [...wins, ...losses]));

    // 시트는 소수 2자리로 반올림 표시한다(0.352→0.35, 0.625→0.63, −0.273→−0.27).
    expect(m.winRate).toBeCloseTo(0.375, 10);
    expect(m.winExpectancy).toBeCloseTo(0.3522, 3);
    expect(m.lossExpectancy).toBeCloseTo(0.625, 10);
    expect(m.expectancy).toBeCloseTo(-0.2728, 3);
  });

  it('연속수익·연속손실 스트릭을 센다 (본전은 끊지 않는다)', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      trade({ pnl: 1, result: 'win' }),
      trade({ pnl: 1, result: 'win' }),
      trade({ pnl: 0, result: 'be' }),
      trade({ pnl: 1, result: 'win' }),
      trade({ pnl: -1, result: 'loss' }),
      trade({ pnl: -1, result: 'loss' }),
      trade({ pnl: -1, result: 'loss' }),
      trade({ pnl: -1, result: 'loss' }),
    ]);
    const m = computeMetrics(book, derived);

    expect(m.maxWinStreak).toBe(3);
    expect(m.maxLossStreak).toBe(4);
    expect(m.currentStreak).toBe(-4);
  });

  it('차액·수익율은 출금을 되더한다', () => {
    seq = 0;
    // 초기 100 → 손익 +50, 출금 20 → 최종 130, 차액 50
    const derived = deriveTrades(book, [trade({ pnl: 50, result: 'win', withdrawal: 20 })]);
    const m = computeMetrics(book, derived);

    expect(m.finalEquity).toBe(130);
    expect(m.totalWithdrawal).toBe(20);
    expect(m.netChange).toBe(50);
    expect(m.returnPct).toBeCloseTo(0.5, 10);
    expect(m.capitalRatio).toBeCloseTo(1.3, 10);
  });

  it('MDD는 자금 곡선 전체의 최대 낙폭이다', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      trade({ pnl: 100, result: 'win' }), // 200
      trade({ pnl: -120, result: 'loss' }), // 80 → -60%
      trade({ pnl: 40, result: 'win' }), // 120 → -40%
    ]);
    const m = computeMetrics(book, derived);

    expect(m.maxDrawdownPct).toBeCloseTo(-0.6, 10);
    expect(m.peakEquity).toBe(200);
    expect(m.troughEquity).toBe(80);
  });

  it('보유중 거래는 승패·총거래수에서 제외한다', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      trade({ pnl: 10, result: 'win' }),
      trade({ pnl: 0, result: 'open', exit_at: null }),
    ]);
    const m = computeMetrics(book, derived);

    expect(m.closedCount).toBe(1);
    expect(m.openCount).toBe(1);
    expect(m.winRate).toBe(1);
  });

  it('표본이 없으면 0이 아니라 null을 돌려준다', () => {
    const m = computeMetrics(book, []);

    expect(m.winRate).toBeNull();
    expect(m.payoffRatio).toBeNull();
    expect(m.expectancy).toBeNull();
    expect(m.finalEquity).toBe(100);
    expect(m.maxDrawdownPct).toBe(0);
  });

  it('승이 하나도 없어도 손익비가 0으로 계산된다', () => {
    seq = 0;
    const derived = deriveTrades(book, [trade({ pnl: -10, result: 'loss' })]);
    const m = computeMetrics(book, derived);

    expect(m.avgWin).toBeNull();
    expect(m.payoffRatio).toBeNull();
    expect(m.expectancy).toBeNull();
    expect(m.winRate).toBe(0);
  });
});

describe('수수료 반영 — 계좌가 실제로 움직인 금액', () => {
  it('자금 곡선은 손익이 아니라 손익+수수료로 이어진다', () => {
    seq = 0;
    // OKX 캡쳐 기준: Closed PnL +35.31, 수수료 -4.95 → 실현손익 +30.36
    const derived = deriveTrades(book, [trade({ pnl: 35.31, fee: -4.95, result: 'win' })]);

    expect(derived[0].net).toBeCloseTo(30.36, 2);
    expect(derived[0].equityAfter).toBeCloseTo(130.36, 2);
  });

  it('손익비·기대치도 수수료를 반영한다', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      trade({ pnl: 20, fee: -10, result: 'win' }), // 실제 +10
      trade({ pnl: -20, fee: -10, result: 'loss' }), // 실제 -30
    ]);
    const m = computeMetrics(book, derived);

    expect(m.avgWin).toBeCloseTo(10, 10);
    expect(m.avgLoss).toBeCloseTo(30, 10);
    expect(m.payoffRatio).toBeCloseTo(1 / 3, 10);
    expect(m.netPnl).toBeCloseTo(-20, 10);
  });

  it('수수료가 비면 손익 그대로 쓴다', () => {
    seq = 0;
    const derived = deriveTrades(book, [trade({ pnl: 12.4, result: 'win' })]);
    expect(derived[0].net).toBeCloseTo(12.4, 10);
  });
});

describe('crossCheckPnl — OCR 오독을 잡는 안전망', () => {
  const base = {
    side: 'long' as const,
    notional: 8486.01,
    entry_price: 65100,
    exit_price: 65390,
  };

  it('실제 캡쳐 값(OKX BTC 롱)이 허용 범위 안이다', () => {
    // 8486.01 × 290/65100 ≈ 37.8, 실제 35.31 (수수료 차이)
    const check = crossCheckPnl({ ...base, pnl: 35.31 });
    expect(check?.expected).toBeCloseTo(37.81, 1);
    expect(check?.ok).toBe(true);
  });

  it('부호가 반대면 방향 오독으로 잡아낸다', () => {
    const check = crossCheckPnl({ ...base, pnl: -35.31 });
    expect(check?.signFlipped).toBe(true);
    expect(check?.ok).toBe(false);
  });

  it('자릿수가 밀리면 잡아낸다', () => {
    const check = crossCheckPnl({ ...base, pnl: 353.1 });
    expect(check?.ok).toBe(false);
    expect(check?.deviation).toBeGreaterThan(0.25);
  });

  it('숏은 가격이 내려야 이익이다', () => {
    const check = crossCheckPnl({ ...base, side: 'short', pnl: -37.8 });
    expect(check?.ok).toBe(true);
  });

  it('값이 하나라도 비면 검증하지 않는다', () => {
    expect(crossCheckPnl({ ...base, exit_price: null, pnl: 35.31 })).toBeNull();
    expect(crossCheckPnl({ ...base, pnl: null })).toBeNull();
  });
});

describe('집계 헬퍼', () => {
  it('월별로 손익을 묶는다', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      trade({ pnl: 10, result: 'win', entry_at: '2026-01-05T00:00:00Z', exit_at: '2026-01-05T01:00:00Z' }),
      trade({ pnl: -4, result: 'loss', entry_at: '2026-01-20T00:00:00Z', exit_at: '2026-01-20T01:00:00Z' }),
      trade({ pnl: 7, result: 'win', entry_at: '2026-02-03T00:00:00Z', exit_at: '2026-02-03T01:00:00Z' }),
    ]);
    const buckets = bucketBy(derived, monthKey);

    expect(buckets).toEqual([
      { key: '2026-01', pnl: 6, wins: 1, losses: 1, count: 2 },
      { key: '2026-02', pnl: 7, wins: 1, losses: 0, count: 1 },
    ]);
  });

  it('감정별 성과를 손실이 큰 순으로 정렬한다', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      trade({ pnl: -50, result: 'loss', emotion: 'FOMO' }),
      trade({ pnl: 20, result: 'win', emotion: '계획대로' }),
      trade({ pnl: 5, result: 'win' }),
    ]);
    const groups = groupPerformance(derived, 'emotion');

    expect(groups[0].key).toBe('FOMO');
    expect(groups[0].netPnl).toBe(-50);
    expect(groups.at(-1)?.key).toBe('계획대로');
    expect(groups.find((g) => g.key === '(미기재)')?.count).toBe(1);
  });
});
