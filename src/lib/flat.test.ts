import { describe, expect, it } from 'vitest';

import type { Book, FlatSession, Trade, TradeResult } from '@/lib/domain';
import { flatEnd, flatState, reentryStats } from '@/lib/flat';
import { deriveTrades } from '@/lib/metrics';

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
    okx_stop_price: null,
    okx_tp_price: null,
    okx_sl_source: null,
    tp1_price: null,
    tp2_price: null,
    tp3_price: null,
    tp1_pct: null,
    tp2_pct: null,
    tp3_pct: null,
    trend: null,
    openness: null,
    timeframe_bias: null,
    timeframe_entry: null,
    setup: null,
    rationale: null,
    plan_on_loss: null,
    plan_on_profit: null,
    review: null,
    emotion: null,
    note: null,
    image_paths: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

function session(startedAt: string): FlatSession {
  return { id: 's1', book_id: 'b1', user_id: 'u1', started_at: startedAt, created_at: startedAt };
}

const at = (iso: string) => Date.parse(iso);

describe('flatEnd', () => {
  it('시작 뒤 첫 진입 시각에 끝난다 — 그 거래가 이미 청산됐어도', () => {
    seq = 0;
    const before = trade({ pnl: -5, result: 'loss', entry_at: '2026-09-01T00:00:00Z', exit_at: '2026-09-01T01:00:00Z' });
    const next = trade({ pnl: 3, result: 'win', entry_at: '2026-09-01T05:00:00Z', exit_at: '2026-09-01T06:00:00Z' });
    const later = trade({ pnl: 0, result: 'open', entry_at: '2026-09-01T08:00:00Z', exit_at: null });

    const end = flatEnd(at('2026-09-01T02:00:00Z'), [later, before, next]);
    expect(end?.endMs).toBe(at('2026-09-01T05:00:00Z'));
    expect(end?.endedBy.id).toBe(next.id);
  });

  it('시작 전에 끝난 거래뿐이면 아직 안 끝났다 — 청산과 같은 시각의 시작도 겹치지 않는다', () => {
    seq = 0;
    const before = trade({ pnl: -5, result: 'loss', entry_at: '2026-09-01T00:00:00Z', exit_at: '2026-09-01T01:00:00Z' });
    expect(flatEnd(at('2026-09-01T01:00:00Z'), [before])).toBeNull();
    expect(flatEnd(at('2026-09-01T02:00:00Z'), [])).toBeNull();
  });

  it('시작 때 이미 들고 있던 포지션(늦게 동기화됨)이면 길이 0 으로 끝난다', () => {
    seq = 0;
    const held = trade({ pnl: 2, result: 'win', entry_at: '2026-09-01T00:00:00Z', exit_at: '2026-09-01T03:00:00Z' });
    const open = trade({ pnl: 0, result: 'open', entry_at: '2026-09-01T00:30:00Z', exit_at: null });
    const start = at('2026-09-01T02:00:00Z');

    expect(flatEnd(start, [held])?.endMs).toBe(start);
    expect(flatEnd(start, [open])?.endMs).toBe(start);
  });
});

describe('flatState', () => {
  it('보유중 거래가 있으면 holding — 그 진입이 끝낸 무포지션을 같이 돌려준다', () => {
    seq = 0;
    const closed = trade({ pnl: -5, result: 'loss', entry_at: '2026-09-01T00:00:00Z', exit_at: '2026-09-01T01:00:00Z' });
    const open = trade({ pnl: 0, result: 'open', entry_at: '2026-09-01T05:00:00Z', exit_at: null });

    const state = flatState(session('2026-09-01T02:00:00Z'), [closed, open]);
    expect(state.kind).toBe('holding');
    if (state.kind !== 'holding') return;
    expect(state.open.map((t) => t.id)).toEqual([open.id]);
    expect(state.endedFlat).toEqual({
      startMs: at('2026-09-01T02:00:00Z'),
      endMs: at('2026-09-01T05:00:00Z'),
      endedBy: open,
    });
  });

  it('holding 인데 무포지션을 든 적이 없거나, 길이 0 이거나, 이미 청산된 거래가 끝낸 것이면 endedFlat 은 없다', () => {
    seq = 0;
    const mid = trade({ pnl: 1, result: 'win', entry_at: '2026-09-01T03:00:00Z', exit_at: '2026-09-01T04:00:00Z' });
    const open = trade({ pnl: 0, result: 'open', entry_at: '2026-09-01T05:00:00Z', exit_at: null });

    const none = flatState(null, [open]);
    expect(none.kind === 'holding' && none.endedFlat).toBeNull();
    // 무포지션(02:00)을 끝낸 것은 mid 진입이고, 지금 들고 있는 open 이 아니다
    const stale = flatState(session('2026-09-01T02:00:00Z'), [mid, open]);
    expect(stale.kind === 'holding' && stale.endedFlat).toBeNull();
    // 포지션을 든 채로 누른 시작
    const zero = flatState(session('2026-09-01T06:00:00Z'), [open]);
    expect(zero.kind === 'holding' && zero.endedFlat).toBeNull();
  });

  it('포지션이 없고 가장 최근 시작이 안 끝났으면 flat', () => {
    seq = 0;
    const closed = trade({ pnl: -5, result: 'loss', entry_at: '2026-09-01T00:00:00Z', exit_at: '2026-09-01T01:00:00Z' });
    expect(flatState(session('2026-09-01T02:00:00Z'), [closed])).toEqual({
      kind: 'flat',
      startMs: at('2026-09-01T02:00:00Z'),
    });
  });

  it('시작한 적이 없거나, 시작 뒤 거래가 들어왔다 나갔으면 idle — 다시 눌러야 한다', () => {
    seq = 0;
    const roundTrip = trade({ pnl: 4, result: 'win', entry_at: '2026-09-01T05:00:00Z', exit_at: '2026-09-01T06:00:00Z' });
    expect(flatState(null, [roundTrip])).toEqual({ kind: 'idle' });
    expect(flatState(session('2026-09-01T02:00:00Z'), [roundTrip])).toEqual({ kind: 'idle' });
  });
});

describe('reentryStats', () => {
  it('직전 청산 60분을 경계로 가른다 — 기산점 없는 첫 거래와 보유중은 뺀다', () => {
    seq = 0;
    const first = trade({ pnl: -10, result: 'loss', entry_at: '2026-09-01T00:00:00Z', exit_at: '2026-09-01T01:00:00Z' });
    // 청산 10분 뒤 재진입 — 손실
    const quickLoss = trade({ pnl: -6, result: 'loss', entry_at: '2026-09-01T01:10:00Z', exit_at: '2026-09-01T02:00:00Z' });
    // 청산 59분 뒤 — 아직 60분 안
    const quickWin = trade({ pnl: 2, result: 'win', entry_at: '2026-09-01T02:59:00Z', exit_at: '2026-09-01T03:30:00Z' });
    // 정확히 60분 뒤 — 기다린 쪽
    const waitedWin = trade({ pnl: 9, result: 'win', entry_at: '2026-09-01T04:30:00Z', exit_at: '2026-09-01T05:00:00Z' });
    const open = trade({ pnl: 0, result: 'open', entry_at: '2026-09-01T05:01:00Z', exit_at: null });

    const stats = reentryStats(deriveTrades(book, [first, quickLoss, quickWin, waitedWin, open]));
    expect(stats.quick).toEqual({ count: 2, wins: 1, losses: 1, net: -4, winRate: 0.5, avgNet: -2 });
    expect(stats.waited).toEqual({ count: 1, wins: 1, losses: 0, net: 9, winRate: 1, avgNet: 9 });
  });

  it('거래가 없으면 비율은 null', () => {
    const stats = reentryStats([]);
    expect(stats.quick).toEqual({ count: 0, wins: 0, losses: 0, net: 0, winRate: null, avgNet: null });
    expect(stats.waited.count).toBe(0);
  });
});
