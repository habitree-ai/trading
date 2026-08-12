import { describe, expect, it } from 'vitest';

import type { Book, CashFlow, CashFlowKind, Trade, TradeResult } from '@/lib/domain';
import {
  bucketBy,
  computeMetrics,
  crossCheckPnl,
  dayKey,
  deriveTrades,
  groupPerformance,
  lastActivityAt,
  monthKey,
  summarizePerformance,
  summarizePrinciples,
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
  exchange_account_id: null,
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
    okx_pos_id: null,
    fee: null,
    funding_fee: null,
    realized_pnl: null,
    unrealized_pnl: null,
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

describe('summarizePrinciples', () => {
  it('판단을 남긴 거래만 분모에 넣는다 — 안 본 거래는 위반이 아니다', () => {
    seq = 0;
    const a = trade({ pnl: -30, result: 'loss' });
    const b = trade({ pnl: 12, result: 'win' });
    // 판단을 남기지 않은 거래. 분모에도 분자에도 들어가면 안 된다.
    const c = trade({ pnl: 5, result: 'win' });

    const derived = deriveTrades(book, [a, b, c]);
    const out = summarizePrinciples(derived, [
      { trade_id: a.id, principle_id: 'p1', kept: false },
      { trade_id: b.id, principle_id: 'p1', kept: true },
    ]);

    expect(out.get('p1')).toEqual({
      judged: 2,
      broken: 1,
      brokenPnl: -30,
      keptPnl: 12,
    });
  });

  it('없는 거래를 가리키는 판단은 세지 않는다 — 손익을 알 수 없다', () => {
    seq = 0;
    const a = trade({ pnl: -8, result: 'loss' });

    const out = summarizePrinciples(deriveTrades(book, [a]), [
      { trade_id: a.id, principle_id: 'p1', kept: false },
      { trade_id: '다른-북-거래', principle_id: 'p1', kept: false },
    ]);

    expect(out.get('p1')?.judged).toBe(1);
    expect(out.get('p1')?.brokenPnl).toBe(-8);
  });

  it('한쪽만 있으면 반대쪽은 null로 남는다 — 0과 구분한다', () => {
    seq = 0;
    const a = trade({ pnl: 7, result: 'win' });

    const out = summarizePrinciples(deriveTrades(book, [a]), [
      { trade_id: a.id, principle_id: 'p1', kept: true },
    ]);

    expect(out.get('p1')?.keptPnl).toBe(7);
    expect(out.get('p1')?.brokenPnl).toBeNull();
  });
});

let flowSeq = 0;

function flow(kind: CashFlowKind, at: string, amount: number): CashFlow {
  flowSeq += 1;
  return {
    id: `f${flowSeq}`,
    book_id: 'b1',
    user_id: 'u1',
    kind,
    at,
    ccy: 'USDT',
    amount,
    fee: null,
    note: null,
    okx_ref: `ref${flowSeq}`,
    source: 'okx',
    created_at: '2026-01-01T00:00:00Z',
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

describe('비용 분해 — 가격으로 번 돈과 계좌에 남은 돈', () => {
  it('가격 손익·수수료·펀딩비를 따로 센다', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      trade({ pnl: 20, fee: -12, funding_fee: -1, realized_pnl: 7, result: 'win' }),
      trade({ pnl: -5, fee: -8, funding_fee: 0.5, realized_pnl: -12.5, result: 'loss' }),
    ]);
    const m = computeMetrics(book, derived);

    expect(m.pnlBeforeCost).toBeCloseTo(15, 10);
    expect(m.fees).toBeCloseTo(-20, 10);
    expect(m.fundingFees).toBeCloseTo(-0.5, 10);
    // 실현손익은 거래소 값이 정본이라 셋의 합과 꼭 같지는 않다.
    expect(m.netPnl).toBeCloseTo(-5.5, 10);
  });

  /*
   * 100배로 회전하면 수수료가 손익보다 커진다 — 가격으로는 이겼는데 계좌는 줄어든
   * 거래가 그렇게 생긴다. 이 건수가 안 보이면 승률이 왜 낮은지가 설명되지 않는다.
   */
  it('가격으로는 이겼는데 비용에 밀려 진 거래를 센다', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      trade({ pnl: 3, fee: -4, realized_pnl: -1, result: 'win' }), // 뒤집힘
      trade({ pnl: 20, fee: -4, realized_pnl: 16, result: 'win' }), // 그대로 승
      trade({ pnl: -6, fee: -4, realized_pnl: -10, result: 'loss' }), // 원래 패
    ]);

    expect(computeMetrics(book, derived).costFlippedCount).toBe(1);
  });
});

describe('실현손익 — 거래소 값이 정본', () => {
  it('realized_pnl이 있으면 되짚지 않고 그 값을 쓴다', () => {
    seq = 0;
    // 실계좌 대조: pnl+fee+funding 으로 되짚으면 청산 수수료·ADL이 빠진다.
    const derived = deriveTrades(book, [
      trade({ pnl: 65.385, fee: -190.205, funding_fee: -0.343, realized_pnl: -130.385, result: 'loss' }),
    ]);

    expect(derived[0].net).toBeCloseTo(-130.385, 10);
    // 되짚은 값(-125.163)이었다면 5.22 만큼 자금이 후하게 잡힌다.
    expect(derived[0].net).not.toBeCloseTo(-125.163, 2);
    expect(derived[0].equityAfter).toBeCloseTo(100 - 130.385, 10);
  });

  it('비어 있으면 손익+수수료+펀딩비로 되짚는다 — 수기 입력 경로', () => {
    seq = 0;
    const derived = deriveTrades(book, [trade({ pnl: 20, fee: -5, funding_fee: -1, result: 'win' })]);
    expect(derived[0].net).toBeCloseTo(14, 10);
  });

  it('0도 값이다 — 되짚기로 새지 않는다', () => {
    seq = 0;
    const derived = deriveTrades(book, [trade({ pnl: 20, fee: -5, realized_pnl: 0, result: 'be' })]);
    expect(derived[0].net).toBe(0);
    expect(derived[0].result).toBe('be');
  });
});

describe('손익률 — 증거금 대비 실현손익', () => {
  it('투입 ÷ 레버리지를 증거금으로 본다', () => {
    seq = 0;
    // 투입 10,000 · 100배 → 증거금 100. 실현손익 +25 → +25%
    const derived = deriveTrades(book, [
      trade({ pnl: 30, fee: -5, result: 'win', notional: 10_000, leverage: 100 }),
    ]);

    expect(derived[0].margin).toBeCloseTo(100, 10);
    expect(derived[0].pnlPct).toBeCloseTo(0.25, 10);
  });

  it('자금이 마이너스로 내려가도 승 거래는 +로 나온다', () => {
    seq = 0;
    // 초기자금(100)보다 큰 손실이 나면 자금 곡선이 음수 구간에 들어간다.
    // 분모를 자금으로 쓰면 이 지점부터 손익률 부호가 통째로 뒤집혔다.
    const derived = deriveTrades(book, [
      trade({ pnl: -300, result: 'loss', notional: 10_000, leverage: 100 }),
      trade({ pnl: 50, result: 'win', notional: 5_000, leverage: 50 }),
    ]);

    expect(derived[0].equityAfter).toBe(-200);
    expect(derived[1].pnlPct).toBeCloseTo(0.5, 10); // 50 / 100
    expect(derived[1].pnlPct! > 0).toBe(true);
  });

  it('레버리지가 비면 1배 — 투입 전액이 증거금이다', () => {
    seq = 0;
    const derived = deriveTrades(book, [trade({ pnl: 20, result: 'win', notional: 200 })]);
    expect(derived[0].margin).toBe(200);
    expect(derived[0].pnlPct).toBeCloseTo(0.1, 10);
  });

  it('투입이 없으면 분모를 모르므로 null', () => {
    seq = 0;
    const derived = deriveTrades(book, [trade({ pnl: 20, result: 'win' })]);
    expect(derived[0].margin).toBeNull();
    expect(derived[0].pnlPct).toBeNull();
  });
});

describe('승패 — 수수료 후 실현손익 기준', () => {
  it('수수료가 손익을 넘기면 저장된 승도 패로 뒤집는다', () => {
    seq = 0;
    // 총손익 +2, 수수료 −5 → 실현 −3. DB에 'win'으로 남아 있어도 계좌는 줄었다.
    const derived = deriveTrades(book, [trade({ pnl: 2, fee: -5, result: 'win' })]);

    expect(derived[0].net).toBeCloseTo(-3, 10);
    expect(derived[0].result).toBe('loss');
  });

  it('보유중은 그대로 둔다 — 손익 부호로 정할 수 없다', () => {
    seq = 0;
    const derived = deriveTrades(book, [trade({ pnl: 0, result: 'open', exit_at: null })]);
    expect(derived[0].result).toBe('open');
  });

  it('승률도 뒤집힌 승패로 다시 센다', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      trade({ pnl: 2, fee: -5, result: 'win' }), // 실현 −3 → 패
      trade({ pnl: 20, fee: -5, result: 'win' }), // 실현 +15 → 승
    ]);
    const m = computeMetrics(book, derived);

    expect(m.wins).toBe(1);
    expect(m.losses).toBe(1);
    expect(m.winRate).toBeCloseTo(0.5, 10);
  });
});

describe('입출금 — 자금 곡선과 매매 성과를 가른다', () => {
  it('이체는 자금 곡선을 움직이고 매매 곡선에서는 빠진다', () => {
    seq = 0;
    flowSeq = 0;
    const flows = [flow('transfer', '2026-01-01T12:00:00Z', 100)];
    const derived = deriveTrades(
      book,
      [trade({ pnl: 20, result: 'win' }), trade({ pnl: 10, result: 'win' })],
      flows,
    );

    expect(derived[0].equityAfter).toBe(120); // 100 + 20
    expect(derived[1].equityBefore).toBe(220); // 120 + 이체 100
    expect(derived[1].equityAfter).toBe(230);
    // 이체로 자금이 늘어도 낙폭은 생기지 않는다 — 고점도 함께 올라간다.
    expect(derived[1].peak).toBe(230);
    expect(derived[1].drawdownPct).toBe(0);
  });

  it('마지막 거래 뒤의 이체도 최종 자금에 담는다', () => {
    seq = 0;
    flowSeq = 0;
    const flows = [flow('transfer', '2026-02-01T00:00:00Z', 50)];
    const derived = deriveTrades(book, [trade({ pnl: 20, result: 'win' })], flows);
    const m = computeMetrics(book, derived, flows);

    expect(m.finalEquity).toBe(170); // 100 + 20 + 50
    expect(m.netChange).toBe(20); // 매매로 번 돈만
    expect(m.netTransfer).toBe(50);
    expect(m.investedCapital).toBe(150);
    expect(m.returnPct).toBeCloseTo(20 / 150, 10);
  });

  it('온체인 입출금은 거래계좌 잔액을 건드리지 않는다 — 자금계좌에 먼저 닿는다', () => {
    seq = 0;
    flowSeq = 0;
    const flows = [
      flow('deposit', '2026-01-01T12:00:00Z', 500),
      flow('withdrawal', '2026-01-01T13:00:00Z', -200),
    ];
    const derived = deriveTrades(book, [trade({ pnl: 20, result: 'win' })], flows);
    const m = computeMetrics(book, derived, flows);

    expect(m.finalEquity).toBe(120);
    expect(m.netTransfer).toBe(0);
    expect(m.deposits).toBe(500);
    expect(m.withdrawals).toBe(-200);
  });

  it('입금은 낙폭을 지우지 않는다 — 고점을 같은 금액만큼 올린다', () => {
    seq = 0;
    flowSeq = 0;
    // 자금 100 → +100(200) → 이체 +1000(1200) → −120(1080).
    // 1200 중 120을 잃었으니 −10%다. 이체를 무시하고 매매분만 보면 −60%로 부풀었다.
    const flows = [flow('transfer', '2026-01-01T12:00:00Z', 1000)];
    const derived = deriveTrades(
      book,
      [trade({ pnl: 100, result: 'win' }), trade({ pnl: -120, result: 'loss' })],
      flows,
    );
    const m = computeMetrics(book, derived, flows);

    expect(derived[1].peak).toBe(1200);
    expect(m.maxDrawdownPct).toBeCloseTo(-0.1, 10);
    expect(m.peakEquity).toBe(1200);
  });

  it('초기자금 0에서 시작해도 MDD가 폭주하지 않는다', () => {
    seq = 0;
    flowSeq = 0;
    // 실계좌 재현: 초기 0에서 시작하니 고점이 0에 붙어 낙폭이 −846%까지 튀었다.
    const zeroBase = { ...book, initial_capital: 0 };
    const flows = [flow('transfer', '2026-01-01T00:00:00Z', 200)];
    const derived = deriveTrades(
      zeroBase,
      [trade({ pnl: 50, result: 'win' }), trade({ pnl: -125, result: 'loss' })],
      flows,
    );
    const m = computeMetrics(zeroBase, derived, flows);

    expect(derived[0].equityAfter).toBe(250); // 0 + 이체 200 + 50
    expect(m.maxDrawdownPct).toBeCloseTo(-0.5, 10); // 250 → 125
    expect(m.maxDrawdownPct).toBeGreaterThan(-1);
  });

  it('왕복 이체는 투입원금을 부풀리지 않는다', () => {
    seq = 0;
    flowSeq = 0;
    // 100을 넣었다 뺐다 세 번 — 유입만 더하면 300이지만 실제로 넣은 건 100이다.
    const zeroBase = { ...book, initial_capital: 0 };
    const flows = [
      flow('transfer', '2026-01-01T00:00:00Z', 100),
      flow('transfer', '2026-01-01T01:00:00Z', -100),
      flow('transfer', '2026-01-01T02:00:00Z', 100),
      flow('transfer', '2026-01-01T03:00:00Z', -100),
      flow('transfer', '2026-01-01T04:00:00Z', 100),
    ];
    const m = computeMetrics(zeroBase, deriveTrades(zeroBase, [], flows), flows);

    expect(m.investedCapital).toBe(100);
    expect(m.netTransfer).toBe(100);
  });

  it('입출금이 없으면 예전과 똑같이 그린다', () => {
    seq = 0;
    const derived = deriveTrades(book, [trade({ pnl: 20, result: 'win' })]);
    const m = computeMetrics(book, derived);

    expect(m.finalEquity).toBe(120);
    expect(m.investedCapital).toBe(100);
    expect(m.returnPct).toBeCloseTo(0.2, 10);
  });
});

describe('출금 — 자금이 줄어든 게 아니다', () => {
  it('나간 이체만 출금으로 세고 들어온 이체는 세지 않는다', () => {
    seq = 0;
    flowSeq = 0;
    // 첫 거래 진입(2026-01-01T00:00:00Z) 전에 둘 다 일어나야 그 거래에 반영된다.
    const flows = [
      flow('transfer', '2025-12-31T00:00:00Z', 200),
      flow('transfer', '2025-12-31T01:00:00Z', -50),
    ];
    const derived = deriveTrades(book, [trade({ pnl: 20, result: 'win' })], flows);

    // 순이체는 +150이지만 뽑아 간 돈은 50이다.
    expect(derived[0].withdrawnTotal).toBe(50);
    expect(computeMetrics(book, derived, flows).netTransfer).toBe(150);
  });

  it('출금 누계는 거래를 거치며 쌓인다', () => {
    seq = 0;
    flowSeq = 0;
    const flows = [
      flow('transfer', '2026-01-01T12:00:00Z', -30),
      flow('transfer', '2026-01-02T12:00:00Z', -20),
    ];
    const derived = deriveTrades(
      book,
      [
        trade({ pnl: 10, result: 'win' }),
        trade({ pnl: 10, result: 'win' }),
        trade({ pnl: 10, result: 'win' }),
      ],
      flows,
    );

    expect(derived.map((d) => d.withdrawnTotal)).toEqual([0, 30, 50]);
  });

  it('시트의 `출금` 컬럼도 출금 누계에 들어간다', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      trade({ pnl: 50, result: 'win', withdrawal: 20 }),
      trade({ pnl: 10, result: 'win' }),
    ]);

    expect(derived.map((d) => d.withdrawnTotal)).toEqual([20, 20]);
    expect(derived[0].equityAfter).toBe(130); // 100 + 50 − 20
  });

  it('성과 곡선은 출금에 꺾이지 않는다 — 뽑아 간 돈은 잃은 돈이 아니다', () => {
    seq = 0;
    flowSeq = 0;
    // 100 → +50(150) → 이체 −100(50) → +10(60).
    // 실제 잔액은 150에서 60으로 내려앉지만 매매로는 60을 벌었다.
    const flows = [flow('transfer', '2026-01-01T12:00:00Z', -100)];
    const derived = deriveTrades(
      book,
      [trade({ pnl: 50, result: 'win' }), trade({ pnl: 10, result: 'win' })],
      flows,
    );

    expect(derived.map((d) => d.equityAfter)).toEqual([150, 60]);
    expect(derived.map((d) => d.netTotal)).toEqual([50, 60]);
    // 성과 곡선 = 초기자금 + 누적 실현손익 — 계속 오른다.
    expect(derived.map((d) => book.initial_capital + d.netTotal)).toEqual([150, 160]);
  });

  it('출금 누계는 왕복 이체에 상쇄되지 않는다', () => {
    seq = 0;
    flowSeq = 0;
    // 100을 넣었다 뺐다 두 번 — 순이체는 0이지만 뽑아 간 돈은 200이다.
    const flows = [
      flow('transfer', '2026-01-01T00:00:00Z', 100),
      flow('transfer', '2026-01-01T01:00:00Z', -100),
      flow('transfer', '2026-01-01T02:00:00Z', 100),
      flow('transfer', '2026-01-01T03:00:00Z', -100),
    ];
    const m = computeMetrics(book, deriveTrades(book, [], flows), flows);

    expect(m.netTransfer).toBe(0);
    expect(m.withdrawnFromAccount).toBe(200);
  });

  it('마지막 거래 뒤의 출금도 합계에 담는다', () => {
    seq = 0;
    flowSeq = 0;
    const flows = [flow('transfer', '2026-02-01T00:00:00Z', -40)];
    const derived = deriveTrades(book, [trade({ pnl: 20, result: 'win' })], flows);
    const m = computeMetrics(book, derived, flows);

    // 곡선은 거래 시점까지만 찍으므로 0이지만, 합계는 전부여야 한다.
    expect(derived[0].withdrawnTotal).toBe(0);
    expect(m.withdrawnFromAccount).toBe(40);
  });

  it('출금이 없으면 누계도 0이다', () => {
    seq = 0;
    const derived = deriveTrades(book, [trade({ pnl: 20, result: 'win' })]);

    expect(derived[0].withdrawnTotal).toBe(0);
    expect(computeMetrics(book, derived).withdrawnFromAccount).toBe(0);
  });
});

describe('summarizePerformance — 값마다 언제인지가 붙는다', () => {
  /** 날짜와 손익을 지정해 거래를 만든다. 시각은 KST 정오라 날짜 경계에 걸리지 않는다. */
  function onDay(day: string, pnl: number, result: TradeResult = pnl >= 0 ? 'win' : 'loss') {
    return trade({
      pnl,
      result,
      entry_at: `${day}T03:00:00Z`, // KST 정오
      exit_at: `${day}T04:00:00Z`,
    });
  }

  it('하루에 여러 건이면 그날 합계로 판단한다', () => {
    seq = 0;
    // 같은 날 +5, −2, +1 → 그날은 +4 이익일 하나다. 건별로 세면 2승 1패가 된다.
    const derived = deriveTrades(book, [
      onDay('2026-03-02', 5),
      onDay('2026-03-02', -2),
      onDay('2026-03-02', 1),
    ]);
    const s = summarizePerformance(book, derived);

    expect(s.tradingDays).toBe(1);
    expect(s.bestDay).toEqual({ pnl: 4, day: '2026-03-02' });
    expect(s.dailyWinRate).toBe(1); // 이익일 1 / (1+0)
  });

  it('하루 최대 수익·손실은 날별 합계에서 고르고 날짜를 남긴다', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      onDay('2026-03-02', 3),
      onDay('2026-03-03', -7),
      onDay('2026-03-04', 9),
    ]);
    const s = summarizePerformance(book, derived);

    expect(s.bestDay).toEqual({ pnl: 9, day: '2026-03-04' });
    expect(s.worstDay).toEqual({ pnl: -7, day: '2026-03-03' });
    expect(s.period).toEqual({ from: '2026-03-02', to: '2026-03-04' });
    expect(s.tradingDays).toBe(3);
  });

  it('연속 이익일은 거래가 없는 날을 건너뛴다 — 12거래일이 달력으로는 더 길 수 있다', () => {
    seq = 0;
    // 3/02, 3/05, 3/09 이익 → 3거래일 연속. 달력으로는 8일에 걸친다.
    const derived = deriveTrades(book, [
      onDay('2026-03-02', 1),
      onDay('2026-03-05', 2),
      onDay('2026-03-09', 3),
      onDay('2026-03-10', -1),
    ]);
    const s = summarizePerformance(book, derived);

    expect(s.winStreak).toEqual({ days: 3, from: '2026-03-02', to: '2026-03-09' });
    expect(s.lossStreak).toEqual({ days: 1, from: '2026-03-10', to: '2026-03-10' });
  });

  it('마지막 날까지 이어지는 연속도 닫아 준다', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      onDay('2026-03-02', -1),
      onDay('2026-03-03', 2),
      onDay('2026-03-04', 3),
    ]);

    expect(summarizePerformance(book, derived).winStreak).toEqual({
      days: 2,
      from: '2026-03-03',
      to: '2026-03-04',
    });
  });

  it('MDD는 금액·비율과 함께 고점일~저점일을 남긴다', () => {
    seq = 0;
    // 100 → +50(150, 고점) → −30(120) → −20(100, 최저)
    const derived = deriveTrades(book, [
      onDay('2026-03-02', 50),
      onDay('2026-03-03', -30),
      onDay('2026-03-04', -20),
    ]);
    const s = summarizePerformance(book, derived);

    expect(s.maxDrawdown).toEqual({
      amount: -50, // 150 → 100
      pct: -50 / 150,
      from: '2026-03-02', // 고점을 찍은 날
      to: '2026-03-04', // 바닥을 친 날
    });
  });

  it('ROA는 총손익을 최대 낙폭 금액으로 나눈다 — 이미지의 2546%를 재현한다', () => {
    seq = 0;
    // 이미지의 관계: 총손익 245.94 ÷ MDD 9.66 = 25.46배 = 2546%.
    // +255.60(고점 355.60) → −9.66(345.94) 이면 그 둘이 정확히 나온다.
    const derived = deriveTrades(book, [
      onDay('2026-03-02', 255.6),
      onDay('2026-03-03', -9.66),
    ]);
    const s = summarizePerformance(book, derived);

    expect(s.netPnl).toBeCloseTo(245.94, 2);
    expect(s.maxDrawdown?.amount).toBeCloseTo(-9.66, 2);
    expect(s.roa).toBeCloseTo(245.94 / 9.66, 4); // 25.4596… → 2546%
  });

  it('손익 P/F 는 총이익 ÷ |총손실| — 이미지의 2.06을 재현한다', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      onDay('2026-03-02', 478.59),
      onDay('2026-03-03', -232.65),
    ]);
    const s = summarizePerformance(book, derived);

    expect(s.grossProfit).toBeCloseTo(478.59, 2);
    expect(s.grossLoss).toBeCloseTo(-232.65, 2);
    expect(s.netPnl).toBeCloseTo(245.94, 2);
    expect(s.profitFactor).toBeCloseTo(2.06, 2);
  });

  it('보유 중인 거래는 거래일에 세지 않는다 — 아직 성적이 없다', () => {
    seq = 0;
    const derived = deriveTrades(book, [
      onDay('2026-03-02', 10),
      trade({ pnl: 0, result: 'open', exit_at: null, entry_at: '2026-03-03T03:00:00Z' }),
    ]);

    expect(summarizePerformance(book, derived).tradingDays).toBe(1);
  });

  it('거래가 없으면 전부 비어 있다 — 0으로 채워 없는 성적을 만들지 않는다', () => {
    const s = summarizePerformance(book, []);

    expect(s.period).toBeNull();
    expect(s.tradingDays).toBe(0);
    expect(s.bestDay).toBeNull();
    expect(s.worstDay).toBeNull();
    expect(s.maxDrawdown).toBeNull();
    expect(s.roa).toBeNull();
    expect(s.winStreak).toBeNull();
    expect(s.dailyWinRate).toBeNull();
  });

  it('낙폭이 없으면 ROA도 없다 — 0으로 나눌 수 없다', () => {
    seq = 0;
    const derived = deriveTrades(book, [onDay('2026-03-02', 10), onDay('2026-03-03', 20)]);
    const s = summarizePerformance(book, derived);

    expect(s.maxDrawdown).toBeNull();
    expect(s.roa).toBeNull();
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

describe('dayKey', () => {
  it('표시 타임존(KST) 기준으로 하루를 가른다', () => {
    // UTC 22:30 은 한국 시각으로 다음 날 07:30 이다.
    expect(dayKey('2026-07-28T22:30:00Z')).toBe('2026-07-29');
    // UTC 14:00 = 한국 23:00 — 아직 같은 날.
    expect(dayKey('2026-07-28T14:00:00Z')).toBe('2026-07-28');
  });

  it('bucketBy 와 맞물려 하루씩 묶는다', () => {
    const trades = [
      trade({ pnl: 10, result: 'win' }),
      trade({ pnl: -4, result: 'loss' }),
    ];
    trades[0].exit_at = '2026-07-28T22:30:00Z'; // KST 07-29
    trades[1].exit_at = '2026-07-28T14:00:00Z'; // KST 07-28

    const buckets = bucketBy(deriveTrades(book, trades), dayKey);
    expect(buckets.map((b) => b.key)).toEqual(['2026-07-28', '2026-07-29']);
    expect(buckets.find((b) => b.key === '2026-07-29')?.pnl).toBe(10);
  });
});

describe('lastActivityAt — 벤치마크 구간의 끝', () => {
  it('거래가 없으면 끝이 없다', () => {
    expect(lastActivityAt([])).toBeNull();
  });

  /**
   * 목록은 진입순이라 마지막 칸이 가장 늦게 청산된 거래가 아니다. 먼저 들어가 나중에
   * 나온 포지션이 있으면 그 청산이 목록 끝보다 뒤에 온다 — 목록 끝으로 구간을 자르면
   * 그 뒤 거래들이 시세 구간 밖으로 밀린다.
   */
  it('목록 끝이 아니라 가장 늦은 청산을 고른다', () => {
    seq = 0;
    const long = trade({ pnl: 10, result: 'win' });
    long.entry_at = '2026-07-01T00:00:00Z';
    long.exit_at = '2026-07-20T00:00:00Z';

    const short = trade({ pnl: -4, result: 'loss' });
    short.entry_at = '2026-07-02T00:00:00Z';
    short.exit_at = '2026-07-03T00:00:00Z';

    const derived = deriveTrades(book, [long, short]);
    expect(derived[derived.length - 1].trade.exit_at).toBe('2026-07-03T00:00:00Z');
    expect(lastActivityAt(derived)).toBe('2026-07-20T00:00:00Z');
  });

  it('아직 들고 있는 거래는 진입 시각으로 센다', () => {
    seq = 0;
    const closed = trade({ pnl: 10, result: 'win' });
    closed.entry_at = '2026-07-01T00:00:00Z';
    closed.exit_at = '2026-07-02T00:00:00Z';

    const open = trade({ pnl: 0, result: 'open' });
    open.entry_at = '2026-07-05T00:00:00Z';
    open.exit_at = null;

    expect(lastActivityAt(deriveTrades(book, [closed, open]))).toBe('2026-07-05T00:00:00Z');
  });
});
