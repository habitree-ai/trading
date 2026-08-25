import { describe, expect, it } from 'vitest';

import type { Trade, TradeFill } from '@/lib/domain';
import {
  activeTargetPrices,
  buildExitActual,
  buildExitPlan,
  checkTpSplit,
  exitMode,
  groupCloseFills,
  mergeStages,
  positionSize,
  resolveShares,
  summarizeExits,
} from '@/lib/exit-plan';
import { isOpenTrade } from '@/lib/metrics';

/** 롱 기본형 — 진입 100 · 손절 95 · TP 105/110/120 · 명목가 1000 · 10배 → 증거금 100, 1R = 5%. */
function trade(over: Partial<Trade> = {}): Trade {
  return {
    id: 't1',
    book_id: 'b1',
    user_id: 'u1',
    seq: 1,
    side: 'long',
    symbol: 'BTC',
    entry_at: '2026-08-01T00:00:00Z',
    exit_at: '2026-08-02T00:00:00Z',
    result: 'win',
    equity_before: null,
    equity_after: null,
    withdrawal: null,
    notional: 1000,
    leverage: 10,
    pnl: 50,
    entry_price: 100,
    exit_price: null,
    fee: null,
    funding_fee: null,
    realized_pnl: null,
    unrealized_pnl: null,
    margin_mode: null,
    stop_price: 95,
    tp1_price: 105,
    tp2_price: 110,
    tp3_price: 120,
    tp1_pct: null,
    tp2_pct: null,
    tp3_pct: null,
    okx_stop_price: null,
    okx_tp_price: null,
    okx_sl_source: null,
    setup: null,
    rationale: null,
    review: null,
    emotion: null,
    note: null,
    okx_pos_id: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

let fillSeq = 0;

function fill(over: Partial<TradeFill> & { role: 'open' | 'close'; price: number }): TradeFill {
  fillSeq += 1;
  return {
    id: `f${fillSeq}`,
    trade_id: 't1',
    user_id: 'u1',
    filled_at: `2026-08-01T0${Math.min(fillSeq, 9)}:00:00Z`,
    amount: null,
    fee: null,
    order_no: null,
    okx_bill_id: null,
    created_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

const NO_SIZE = { qty: 10, notional: 1000, source: 'notional' as const };

describe('resolveShares — 비중 규칙', () => {
  it('셋 다 비면 가격 있는 TP 수로 균등', () => {
    const r = resolveShares([105, 110, 120], [null, null, null]);
    expect(r.shares.map((s) => s && Number(s.toFixed(4)))).toEqual([0.3333, 0.3333, 0.3333]);
    expect(r.sources).toEqual(['even', 'even', 'even']);
    expect(r.sum).toBeCloseTo(1, 10);
    expect(r.problem).toBeNull();
  });

  it('하나라도 적으면 빈 칸은 0 이고 정규화하지 않는다', () => {
    const r = resolveShares([105, 110, 120], [60, null, null]);
    expect(r.shares).toEqual([0.6, 0, 0]);
    expect(r.sources).toEqual(['explicit', 'zero', 'zero']);
    expect(r.sum).toBeCloseTo(0.6, 10);
    expect(r.problem).toContain('60%');
    expect(r.problem).toContain('40%');
  });

  it('합이 100 을 넘으면 그대로 두고 문구만 낸다', () => {
    const r = resolveShares([105, 110, 120], [50, 40, 30]);
    expect(r.sum).toBeCloseTo(1.2, 10);
    expect(r.problem).toContain('120%');
  });

  it('가격 없는 단의 비중은 무시한다', () => {
    const r = resolveShares([105, null, 120], [null, 30, null]);
    expect(r.shares).toEqual([0.5, null, 0.5]);
    expect(r.problem).toBeNull();
  });

  it('활성 단이 없으면 전부 비어 있다', () => {
    const r = resolveShares([null, null, null], [50, null, null]);
    expect(r.shares).toEqual([null, null, null]);
    expect(r.sum).toBeNull();
  });
});

describe('checkTpSplit — 폼 경고', () => {
  const prices = [105, 110, 120];
  it('멀쩡하면 null', () => {
    expect(checkTpSplit({ prices, pcts: [50, 30, 20] })).toBeNull();
    expect(checkTpSplit({ prices, pcts: [null, null, null] })).toBeNull();
  });
  it('범위 밖', () => {
    expect(checkTpSplit({ prices, pcts: [0, null, null] })).toContain('TP1');
    expect(checkTpSplit({ prices, pcts: [null, 150, null] })).toContain('TP2');
  });
  it('가격 없는 단에 비율만', () => {
    expect(checkTpSplit({ prices: [105, null, 120], pcts: [null, 30, null] })).toContain(
      'TP2 은 가격이 없는데',
    );
  });
  it('합이 맞지 않으면 계획과 같은 문구', () => {
    expect(checkTpSplit({ prices, pcts: [50, 60, null] })).toContain('넘습니다');
    expect(checkTpSplit({ prices: [105, 110, null], pcts: [50, 30, null] })).toContain('80%');
  });
});

describe('activeTargetPrices — 거래소 익절이 TP1 자리', () => {
  it('okx 값이 있으면 손 입력보다 먼저다', () => {
    expect(activeTargetPrices(trade({ okx_tp_price: 106 }))).toEqual([106, 110, 120]);
    expect(activeTargetPrices(trade({ tp1_price: null, okx_tp_price: 106 }))).toEqual([106, 110, 120]);
    expect(activeTargetPrices(trade({ tp1_price: null }))).toEqual([null, 110, 120]);
  });
});

describe('buildExitPlan — 계획', () => {
  it('균등 분할: 금액·증거금 대비·R·합계', () => {
    const plan = buildExitPlan(trade(), NO_SIZE);
    expect(plan.steps.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(plan.steps.map((s) => s.movePct)).toEqual([0.05, 0.1, 0.2].map((v) => expect.closeTo(v, 10)));
    expect(plan.steps.map((s) => s.amount)).toEqual(
      [16.667, 33.333, 66.667].map((v) => expect.closeTo(v, 2)),
    );
    expect(plan.steps.map((s) => s.returnPct)).toEqual(
      [0.16667, 0.33333, 0.66667].map((v) => expect.closeTo(v, 4)),
    );
    expect(plan.steps.map((s) => s.r)).toEqual([1, 2, 4].map((v) => expect.closeTo(v, 10)));
    expect(plan.total.amount).toBeCloseTo(116.667, 2);
    expect(plan.total.returnPct).toBeCloseTo(1.16667, 4);
    expect(plan.total.blendedR).toBeCloseTo(2.333, 2);
    expect(plan.stop).toMatchObject({ price: 95, source: 'plan', planPrice: null });
    expect(plan.stop?.riskPct).toBeCloseTo(0.05, 10);
    expect(plan.stop?.lossAmount).toBeCloseTo(-50, 10);
    expect(plan.stop?.returnPct).toBeCloseTo(-0.5, 10);
    expect(plan.shareProblem).toBeNull();
    expect(plan.rBasis).toBe('plan');
  });

  it('명시 비율 50/30/20', () => {
    const plan = buildExitPlan(trade({ tp1_pct: 50, tp2_pct: 30, tp3_pct: 20 }), NO_SIZE);
    expect(plan.steps.map((s) => s.amount)).toEqual([25, 30, 40].map((v) => expect.closeTo(v, 10)));
    expect(plan.total.amount).toBeCloseTo(95, 10);
    expect(plan.total.blendedR).toBeCloseTo(1.9, 10);
    expect(plan.steps.every((s) => s.shareSource === 'explicit')).toBe(true);
  });

  it('일부만 적으면 나머지는 0 — 합 60% 경고', () => {
    const plan = buildExitPlan(trade({ tp1_pct: 60 }), NO_SIZE);
    expect(plan.steps.map((s) => s.share)).toEqual([0.6, 0, 0]);
    expect(plan.steps[1].amount).toBe(0);
    expect(plan.shareSum).toBeCloseTo(0.6, 10);
    expect(plan.shareProblem).toContain('40%');
  });

  it('거래소 익절이 TP1 자리에 서고 계획은 옆에 남는다', () => {
    const plan = buildExitPlan(trade({ okx_tp_price: 106, tp1_pct: 50 }), NO_SIZE);
    expect(plan.steps[0]).toMatchObject({ price: 106, source: 'okx', planPrice: 105, share: 0.5 });
  });

  it('손 입력 없이 거래소 익절만 있어도 그 단은 살아 있다', () => {
    const plan = buildExitPlan(trade({ tp1_price: null, okx_tp_price: 106, tp1_pct: 50 }), NO_SIZE);
    expect(plan.steps[0]).toMatchObject({ n: 1, price: 106, source: 'okx', planPrice: null, share: 0.5 });
  });

  it('거래소 손절이 먼저 서도 R 은 계획 손절 기준이다', () => {
    const plan = buildExitPlan(trade({ okx_stop_price: 94 }), NO_SIZE);
    expect(plan.stop).toMatchObject({ price: 94, source: 'okx', planPrice: 95 });
    expect(plan.stop?.riskPct).toBeCloseTo(0.06, 10);
    expect(plan.stop?.lossAmount).toBeCloseTo(-60, 10);
    expect(plan.steps[0].r).toBeCloseTo(1, 10);
    expect(plan.rBasis).toBe('plan');
  });

  it('계획 손절이 없으면 거래소 손절로 R 을 재고 기준을 남긴다', () => {
    const plan = buildExitPlan(trade({ stop_price: null, okx_stop_price: 94 }), NO_SIZE);
    expect(plan.rBasis).toBe('okx');
    expect(plan.steps[0].r).toBeCloseTo(0.05 / 0.06, 10);
  });

  it('손절이 아예 없으면 R 도 없다', () => {
    const plan = buildExitPlan(trade({ stop_price: null }), NO_SIZE);
    expect(plan.stop).toBeNull();
    expect(plan.rBasis).toBeNull();
    expect(plan.steps.every((s) => s.r === null)).toBe(true);
  });

  it('숏 — 폭은 아래로 가야 양수', () => {
    const plan = buildExitPlan(
      trade({ side: 'short', stop_price: 103, tp1_price: 97, tp2_price: 94, tp3_price: null, notional: 500, leverage: 5 }),
      { qty: 5, notional: 500, source: 'notional' },
    );
    expect(plan.stop?.lossAmount).toBeCloseTo(-15, 10);
    expect(plan.stop?.returnPct).toBeCloseTo(-0.15, 10);
    expect(plan.steps.map((s) => s.movePct)).toEqual([0.03, 0.06].map((v) => expect.closeTo(v, 10)));
    expect(plan.steps.map((s) => s.r)).toEqual([1, 2].map((v) => expect.closeTo(v, 10)));
    expect(plan.steps.map((s) => s.amount)).toEqual([7.5, 15].map((v) => expect.closeTo(v, 10)));
  });

  it('반대쪽 TP 는 그 단만 경고하고 나머지는 산다', () => {
    const plan = buildExitPlan(trade({ tp1_price: 98 }), NO_SIZE);
    expect(plan.steps[0].movePct).toBeCloseTo(-0.02, 10);
    expect(plan.steps[0].r).toBeCloseTo(-0.4, 10);
    expect(plan.steps[0].amount).toBeCloseTo(-6.667, 2);
    expect(plan.steps[0].problem).toBeTruthy();
    expect(plan.steps[1].problem).toBeNull();
    expect(plan.steps[2].problem).toBeNull();
  });

  it('손절이 반대쪽이면 손절만 경고하고 R 은 그 폭으로 잰다', () => {
    const plan = buildExitPlan(trade({ stop_price: 101 }), NO_SIZE);
    expect(plan.stop?.problem).toBeTruthy();
    expect(plan.stop?.riskPct).toBeCloseTo(0.01, 10);
    expect(plan.steps.map((s) => s.r)).toEqual([5, 10, 20].map((v) => expect.closeTo(v, 8)));
  });

  it('TP 순서가 뒤집히면 짚어 준다', () => {
    const plan = buildExitPlan(trade({ tp1_price: 110, tp2_price: 105 }), NO_SIZE);
    expect(plan.orderProblem).toBeTruthy();
    expect(plan.steps).toHaveLength(3);
  });

  it('가격이 0 이면 그 단이 경고다', () => {
    const plan = buildExitPlan(trade({ tp1_price: 0 }), NO_SIZE);
    expect(plan.steps[0].problem).toContain('0 이하');
  });

  it('진입가가 없으면 가격만 남고 폭·금액·R 은 비어 있다', () => {
    for (const entry of [null, 0]) {
      const plan = buildExitPlan(trade({ entry_price: entry }), NO_SIZE);
      expect(plan.steps.map((s) => s.price)).toEqual([105, 110, 120]);
      expect(plan.steps.every((s) => s.movePct === null && s.amount === null && s.r === null)).toBe(true);
      expect(plan.stop?.riskPct).toBeNull();
    }
  });

  it('명목가가 없으면 폭·R 은 있고 금액은 없다', () => {
    const plan = buildExitPlan(trade({ notional: null }), { qty: null, notional: null, source: null });
    expect(plan.steps[0].movePct).toBeCloseTo(0.05, 10);
    expect(plan.steps[0].r).toBeCloseTo(1, 10);
    expect(plan.steps[0].amount).toBeNull();
    expect(plan.total.amount).toBeNull();
  });

  it('레버리지가 없으면 1배 — 증거금 대비 = 폭 × 비중', () => {
    const plan = buildExitPlan(trade({ leverage: null }), NO_SIZE);
    expect(plan.steps[0].returnPct).toBeCloseTo(0.05 / 3, 10);
  });

  it('원래 크기를 넘기면 그 명목가로 금액을 낸다 — 남은 물량이 아니라', () => {
    const plan = buildExitPlan(
      trade({ notional: 500, tp1_pct: 100, tp2_price: null, tp3_price: null }),
      { qty: 9.545, notional: 954.5, source: 'notional+closed' },
    );
    expect(plan.steps[0].amount).toBeCloseTo(47.725, 10);
  });
});

describe('positionSize — 원래 진입 크기', () => {
  it('닫힌 거래는 명목가가 총량이다 — 진입 체결이 있어도 명목가 우선', () => {
    const size = positionSize(
      trade({ okx_pos_id: 'p1' }),
      [fill({ role: 'open', price: 100, amount: 300 })],
      false,
    );
    expect(size).toEqual({ qty: 10, notional: 1000, source: 'notional' });
  });

  it('열린 OKX 거래는 진입 체결이 다 있으면 그 합이다 — 금액은 견적통화라 가격으로 나눈다', () => {
    const size = positionSize(
      trade({ okx_pos_id: 'p1', notional: 500 }),
      [fill({ role: 'open', price: 100, amount: 500 }), fill({ role: 'open', price: 102, amount: 500 })],
      true,
    );
    expect(size.qty).toBeCloseTo(5 + 500 / 102, 10);
    expect(size.source).toBe('open_fills');
  });

  it('열린 OKX 거래에 진입 체결이 없으면 남은 물량에 덜어낸 양을 되돌려 더한다', () => {
    const size = positionSize(
      trade({ okx_pos_id: 'p1', notional: 500 }),
      [fill({ role: 'close', price: 110, amount: 550 })],
      true,
    );
    expect(size.qty).toBeCloseTo(10, 10);
    expect(size.notional).toBeCloseTo(1000, 10);
    expect(size.source).toBe('notional+closed');
  });

  it('열린 수기 거래의 명목가는 원래 크기다 — 되돌리지 않는다', () => {
    const size = positionSize(
      trade({ okx_pos_id: null, notional: 1000 }),
      [fill({ role: 'close', price: 110, amount: 550 })],
      true,
    );
    expect(size).toEqual({ qty: 10, notional: 1000, source: 'notional' });
  });

  it('덜어낸 양을 모르면(금액 0·null) 남은 크기로 두고 출처를 비운다', () => {
    const size = positionSize(
      trade({ okx_pos_id: 'p1', notional: 500 }),
      [fill({ role: 'close', price: 110, amount: 0 })],
      true,
    );
    expect(size).toEqual({ qty: null, notional: 500, source: null });
  });

  it('진입가가 없으면 수량을 잴 수 없다', () => {
    expect(positionSize(trade({ entry_price: null }), [], false)).toEqual({
      qty: null,
      notional: 1000,
      source: null,
    });
  });
});

describe('groupCloseFills — 차수', () => {
  it('주문번호로 묶고 첫 체결 시각 순으로 세운다. 진입은 뺀다', () => {
    const fills = [
      fill({ role: 'open', price: 100, filled_at: '2026-08-01T00:00:00Z' }),
      fill({ role: 'close', price: 105, order_no: 'o1', filled_at: '2026-08-01T01:00:00Z' }),
      fill({ role: 'close', price: 112, order_no: 'o2', filled_at: '2026-08-01T02:00:00Z' }),
      fill({ role: 'close', price: 105.2, order_no: 'o1', filled_at: '2026-08-01T03:00:00Z' }),
    ];
    const groups = groupCloseFills(fills);
    expect(groups.map((g) => g.map((f) => f.price))).toEqual([[105, 105.2], [112]]);
  });

  it('주문번호가 없으면 낱개가 한 차수다', () => {
    const groups = groupCloseFills([
      fill({ role: 'close', price: 105 }),
      fill({ role: 'close', price: 110 }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe('buildExitActual — 실적', () => {
  const closes = () => [
    fill({ role: 'close', price: 105, amount: 262.5, fee: -0.1, order_no: 'o1', filled_at: '2026-08-01T01:00:00Z' }),
    fill({ role: 'close', price: 105.2, amount: 263, fee: -0.1, order_no: 'o1', filled_at: '2026-08-01T01:00:01Z' }),
    fill({ role: 'close', price: 112, amount: 560, fee: -0.3, order_no: 'o2', filled_at: '2026-08-01T02:00:00Z' }),
  ];

  it('주문별로 수량·가중가·손익·비중·R 을 낸다', () => {
    const actual = buildExitActual(trade(), closes(), false, NO_SIZE)!;
    expect(actual.source).toBe('fills');
    expect(actual.steps).toHaveLength(2);
    const [first, second] = actual.steps;
    expect(first).toMatchObject({ n: 1, fillCount: 2, estimated: false });
    expect(first.qty).toBeCloseTo(5, 10);
    expect(first.price).toBeCloseTo(105.1, 10);
    expect(first.share).toBeCloseTo(0.5, 10);
    expect(first.pnl).toBeCloseTo(25.5, 10);
    expect(first.r).toBeCloseTo(1.02, 10);
    expect(first.fee).toBeCloseTo(-0.2, 10);
    expect(second.share).toBeCloseTo(0.5, 10);
    expect(second.pnl).toBeCloseTo(60, 10);
    expect(second.r).toBeCloseTo(2.4, 10);
    expect(actual.closedShare).toBeCloseTo(1, 10);
    expect(actual.remainingShare).toBe(0);
    expect(actual.pnlTotal).toBeCloseTo(85.5, 10);
    expect(actual.closeFeeTotal).toBeCloseTo(-0.5, 10);
    expect(actual.estimated).toBe(false);
  });

  it('숏 — 내려가야 이익', () => {
    const actual = buildExitActual(
      trade({ side: 'short', entry_price: 200, stop_price: 206, notional: 2000 }),
      [fill({ role: 'close', price: 190, amount: 950 })],
      false,
      { qty: 10, notional: 2000, source: 'notional' },
    )!;
    expect(actual.steps[0].pnl).toBeCloseTo(50, 10);
    expect(actual.steps[0].share).toBeCloseTo(0.5, 10);
    expect(actual.steps[0].movePct).toBeCloseTo(0.05, 10);
  });

  it('손실 청산은 R 도 음수다', () => {
    const actual = buildExitActual(
      trade(),
      [fill({ role: 'close', price: 98, amount: 490 })],
      false,
      NO_SIZE,
    )!;
    expect(actual.steps[0].movePct).toBeCloseTo(-0.02, 10);
    expect(actual.steps[0].pnl).toBeCloseTo(-10, 10);
    expect(actual.steps[0].r).toBeCloseTo(-0.4, 10);
  });

  it('금액 모르는 체결이 섞이면 그 차수만 추정이고 다른 차수는 정상', () => {
    const fills = closes();
    fills[0] = { ...fills[0], amount: null };
    const actual = buildExitActual(trade(), fills, false, NO_SIZE)!;
    const [first, second] = actual.steps;
    expect(first.estimated).toBe(true);
    expect(first.price).toBeCloseTo(105.1, 10);
    expect(first.qty).toBeNull();
    expect(first.share).toBeNull();
    expect(first.pnl).toBeNull();
    expect(second.pnl).toBeCloseTo(60, 10);
    expect(actual.closedShare).toBeNull();
    expect(actual.estimated).toBe(true);
  });

  it('차수가 넷 이상이면 전부 그린다', () => {
    const fills = [1, 2, 3, 4, 5].map((i) =>
      fill({ role: 'close', price: 100 + i, amount: 100, order_no: `o${i}`, filled_at: `2026-08-01T0${i}:00:00Z` }),
    );
    const actual = buildExitActual(trade(), fills, false, NO_SIZE)!;
    expect(actual.steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5]);
  });

  it('체결 없는 닫힌 거래는 청산가 한 점으로 되짚는다 — 수수료는 섞여 있어 넣지 않는다', () => {
    const actual = buildExitActual(trade({ exit_price: 110, fee: -1 }), [], false, NO_SIZE)!;
    expect(actual.source).toBe('exit_price');
    expect(actual.steps[0]).toMatchObject({ n: 1, share: 1, qty: 10, fee: null, estimated: true });
    expect(actual.steps[0].pnl).toBeCloseTo(100, 10);
    expect(actual.estimated).toBe(true);
  });

  it('체결 없는 열린 거래는 실적이 없다', () => {
    expect(buildExitActual(trade({ exit_at: null, result: 'open' }), [], true, NO_SIZE)).toBeNull();
  });

  it('부분청산 중인 열린 OKX 거래 — 원래 크기로 비중을 잰다', () => {
    const t = trade({ okx_pos_id: 'p1', notional: 500, exit_at: null, result: 'open', pnl: null });
    const fills = [fill({ role: 'close', price: 110, amount: 550 })];
    const summary = summarizeExits(t, fills, true);
    expect(summary.size.source).toBe('notional+closed');
    expect(summary.actual?.steps[0].share).toBeCloseTo(0.5, 10);
    expect(summary.actual?.remainingShare).toBeCloseTo(0.5, 10);
    expect(summary.mode).toBe('plan-with-actual');
    // 계획 금액도 원래 크기(1000) 기준이다 — 남은 500 이 아니라.
    expect(summary.plan.steps[0].amount).toBeCloseTo(0.05 * 1000 * (1 / 3), 6);
  });

  it('장부의 실현손익은 읽지 않는다', () => {
    const a = buildExitActual(trade({ realized_pnl: 1 }), closes(), false, NO_SIZE);
    const b = buildExitActual(trade({ realized_pnl: 999 }), closes(), false, NO_SIZE);
    expect(a).toEqual(b);
  });
});

describe('mergeStages — 체결 뒤에 예상을 잇는다', () => {
  const openTrade = (over: Partial<Trade> = {}) =>
    trade({ okx_pos_id: 'p1', exit_at: null, result: 'open', pnl: null, ...over });

  it('1차가 체결됐으면 다음 예상은 TP2·TP3 이고 금액은 원래 크기 기준이다', () => {
    const summary = summarizeExits(
      openTrade({ notional: 500 }),
      [fill({ role: 'close', price: 110, amount: 550 })],
      true,
    );
    const stages = mergeStages(summary);
    expect(stages.map((s) => [s.n, s.kind, s.tp])).toEqual([
      [1, 'filled', null],
      [2, 'expected', 2],
      [3, 'expected', 3],
    ]);
    expect(stages[0].pnl).toBeCloseTo(50, 10);
    expect(stages[0].share).toBeCloseTo(0.5, 10);
    expect(stages[1].price).toBe(110);
    expect(stages[1].pnl).toBeCloseTo(0.1 * 1000 * (1 / 3), 6);
    expect(stages[2].pnl).toBeCloseTo(0.2 * 1000 * (1 / 3), 6);
  });

  it('체결이 없으면 셋 다 예상이다', () => {
    const stages = mergeStages(summarizeExits(openTrade(), [], true));
    expect(stages.map((s) => [s.kind, s.tp])).toEqual([
      ['expected', 1],
      ['expected', 2],
      ['expected', 3],
    ]);
  });

  it('계획이 없으면 체결 뒤는 빈 자리다 — 세 자리는 늘 선다', () => {
    const stages = mergeStages(
      summarizeExits(
        openTrade({ notional: 500, tp1_price: null, tp2_price: null, tp3_price: null }),
        [fill({ role: 'close', price: 110, amount: 550 })],
        true,
      ),
    );
    expect(stages.map((s) => s.kind)).toEqual(['filled', 'empty', 'empty']);
  });

  it('닫힌 거래는 체결만 — 예상도 빈 자리도 없다', () => {
    const stages = mergeStages(
      summarizeExits(trade(), [fill({ role: 'close', price: 110, amount: 1100 })], false),
    );
    expect(stages.map((s) => s.kind)).toEqual(['filled']);
  });
});

describe('모드 판정', () => {
  it('exitMode', () => {
    expect(exitMode(true, null)).toBe('plan');
    expect(exitMode(true, { steps: [] } as never)).toBe('plan');
    expect(exitMode(true, { steps: [{}] } as never)).toBe('plan-with-actual');
    expect(exitMode(false, null)).toBe('actual-with-plan');
  });

  it('isOpenTrade 는 result·exit_at·pnl 셋을 모두 본다', () => {
    expect(isOpenTrade(trade({ result: 'open' }))).toBe(true);
    expect(isOpenTrade(trade({ exit_at: null }))).toBe(true);
    expect(isOpenTrade(trade({ pnl: null }))).toBe(true);
    expect(isOpenTrade(trade())).toBe(false);
  });
});
