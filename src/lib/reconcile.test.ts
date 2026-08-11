import { describe, expect, it } from 'vitest';

import { reconcileEquity, type ReconcileCode, type ReconcileInput } from '@/lib/reconcile';

const FLOOR = Date.parse('2026-05-13T00:00:00Z');

function input(partial: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    initialCapital: 100,
    netPnl: 0,
    netTransfer: 0,
    tradeWithdrawal: 0,
    computedEquity: 100,
    actual: 100,
    unrealizedPnl: 0,
    foreignFlowCount: 0,
    baseCurrency: 'USDT',
    startDate: '2026-08-11',
    historyFloorMs: FLOOR,
    lastSyncAt: '2026-08-11T09:15:52Z',
    linked: true,
    ...partial,
  };
}

function codes(notes: readonly { code: ReconcileCode }[]): ReconcileCode[] {
  return notes.map((n) => n.code);
}

describe('reconcileEquity', () => {
  it('원장이 맞으면 일치로 본다', () => {
    const r = reconcileEquity(input());
    expect(r.diff).toBe(0);
    expect(r.tone).toBe('good');
    expect(codes(r.notes)).toEqual(['match']);
  });

  /*
   * 실계좌에서 실제로 났던 어긋남.
   *
   * 초기자금 100을 "이체가 끝난 뒤의 잔고"로 잡아 두고, 그 100을 만든 이체 7건을
   * 동기화가 또 더했다. 화면은 196.47, 거래소는 100.09였다.
   */
  it('초기자금에 이체분이 들어 있으면 그 사실을 짚는다', () => {
    const netTransfer = 96.46903151026402;
    const r = reconcileEquity(
      input({ netTransfer, computedEquity: 100 + netTransfer, actual: 100.0858024 }),
    );

    expect(r.diff).toBeCloseTo(96.383, 2);
    expect(r.tone).toBe('bad');
    expect(codes(r.notes)).toContain('initial-double-counted');
    // 초기자금을 이 값으로 두면 계산 자금이 거래소 잔고와 같아진다.
    expect(r.suggestedInitialCapital).toBeCloseTo(3.6168, 3);
  });

  /*
   * 같은 계좌에 거래가 들어온 뒤 — 잔차가 그만큼 커진다.
   *
   * 조회 구간 앞뒤에 걸친 거래의 손익(−1.91)이 차이와 순이체 사이에 남는다.
   * 허용폭이 이체의 2%(1.93)였을 때는 이 잔차 2.00에 걸려 원인을 놓쳤다.
   */
  it('누적 손익이 잔차로 남아도 이체 이중 계상을 짚는다', () => {
    const netTransfer = 96.46903151026402;
    const netPnl = -1.913397223;
    const r = reconcileEquity(
      input({
        netPnl,
        netTransfer,
        computedEquity: 100 + netPnl + netTransfer,
        actual: 102.23018358815276,
        unrealizedPnl: 2.141491765000108,
      }),
    );

    expect(r.diff).toBeCloseTo(94.467, 3);
    expect(codes(r.notes)).toEqual(['initial-double-counted']);
    expect(r.suggestedInitialCapital).toBeCloseTo(5.533, 3);
  });

  it('보정값을 다시 넣으면 차이가 사라진다', () => {
    const netTransfer = 96.46903151026402;
    const first = reconcileEquity(
      input({ netTransfer, computedEquity: 100 + netTransfer, actual: 100.0858024 }),
    );
    const fixed = first.suggestedInitialCapital!;

    const second = reconcileEquity(
      input({ netTransfer, initialCapital: fixed, computedEquity: fixed + netTransfer, actual: 100.0858024 }),
    );
    expect(second.diff).toBeCloseTo(0, 8);
    expect(second.tone).toBe('good');
  });

  it('미청산 손익은 걷어내고 견준다', () => {
    const r = reconcileEquity(input({ computedEquity: 100, actual: 110, unrealizedPnl: 10 }));
    expect(r.settled).toBe(100);
    expect(r.diff).toBe(0);
    expect(codes(r.notes)).toEqual(['match']);
  });

  it('잔고가 없으면 대조하지 않고 받아 오라고만 말한다', () => {
    const r = reconcileEquity(input({ actual: null }));
    expect(r.diff).toBeNull();
    expect(r.suggestedInitialCapital).toBeNull();
    expect(codes(r.notes)).toEqual(['no-balance']);
  });

  it('북 시작일이 조회 구간보다 이르면 그 구간의 누락을 짚는다', () => {
    const r = reconcileEquity(
      input({ startDate: '2026-01-01', netPnl: -40, computedEquity: 60, actual: 100 }),
    );
    expect(codes(r.notes)).toEqual(['pre-window']);
  });

  it('기준 통화가 아닌 흐름이 섞여 있으면 알린다', () => {
    const r = reconcileEquity(
      input({ foreignFlowCount: 2, netPnl: 30, computedEquity: 130, actual: 100 }),
    );
    expect(codes(r.notes)).toEqual(['foreign-ccy']);
  });

  it('수기 자금이 곡선을 붙잡고 있으면 보정이 안 먹는다고 알린다', () => {
    // 원장 합계는 150인데 화면 자금은 140 — 어느 거래의 `자금` 칸이 곡선을 눌러 놨다.
    const r = reconcileEquity(input({ netPnl: 50, computedEquity: 140, actual: 140 }));
    expect(codes(r.notes)).toContain('manual-equity');
  });

  it('짚이는 원인이 없으면 원인 미상으로 남긴다', () => {
    const r = reconcileEquity(input({ netPnl: 30, computedEquity: 130, actual: 100 }));
    expect(codes(r.notes)).toEqual(['unexplained']);
    expect(r.tone).toBe('bad');
  });

  it('0.5% 안쪽 어긋남은 일치로 본다 — 수수료 반올림 수준이다', () => {
    const r = reconcileEquity(input({ netPnl: 0.3, computedEquity: 100.3, actual: 100 }));
    expect(r.tone).toBe('good');
    expect(codes(r.notes)).toEqual(['match']);
  });

  it('연결돼 있는데 성공한 동기화가 없으면 알린다', () => {
    const r = reconcileEquity(
      input({ lastSyncAt: null, netPnl: 30, computedEquity: 130, actual: 100 }),
    );
    expect(codes(r.notes)).toContain('never-synced');
  });
});
