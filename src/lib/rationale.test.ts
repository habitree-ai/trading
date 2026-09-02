import { describe, expect, it } from 'vitest';

import type { Trade } from '@/lib/domain';
import { lacksRationale, unjustifiedTrades } from '@/lib/rationale';

let seq = 0;
function trade(partial: Partial<Trade> = {}): Trade {
  seq += 1;
  return {
    id: `t${seq}`,
    book_id: 'b1',
    user_id: 'u1',
    seq,
    side: 'long',
    symbol: 'BTC',
    entry_at: '2026-09-01T10:00:00+09:00',
    exit_at: '2026-09-01T11:00:00+09:00',
    result: 'win',
    equity_before: null,
    equity_after: null,
    withdrawal: null,
    notional: null,
    leverage: null,
    pnl: 10,
    entry_price: null,
    exit_price: null,
    fee: null,
    funding_fee: null,
    realized_pnl: null,
    unrealized_pnl: null,
    margin_mode: null,
    stop_price: null,
    tp1_price: null,
    tp2_price: null,
    tp3_price: null,
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
    created_at: '2026-09-01T10:00:00+09:00',
    updated_at: '2026-09-01T10:00:00+09:00',
    ...partial,
  };
}

const NOW = Date.parse('2026-09-03T12:00:00+09:00');

describe('lacksRationale', () => {
  it('비었거나 공백뿐이면 근거 없음', () => {
    expect(lacksRationale({ rationale: null })).toBe(true);
    expect(lacksRationale({ rationale: '   ' })).toBe(true);
    expect(lacksRationale({ rationale: '지지선 반등' })).toBe(false);
  });
});

describe('unjustifiedTrades', () => {
  it('근거가 있는 거래는 빠진다', () => {
    expect(unjustifiedTrades([trade({ rationale: '있음' })], NOW)).toEqual([]);
  });

  it('창 안의 빈 거래와 보유중 빈 거래를 최근순으로 올린다', () => {
    const old = trade({ entry_at: '2026-06-01T10:00:00+09:00', exit_at: '2026-06-01T11:00:00+09:00' });
    const recent = trade();
    const openOld = trade({
      entry_at: '2026-05-01T10:00:00+09:00',
      exit_at: null,
      pnl: null,
      result: 'open',
    });
    const newest = trade({ entry_at: '2026-09-03T09:00:00+09:00', exit_at: '2026-09-03T10:00:00+09:00' });
    const out = unjustifiedTrades([old, recent, openOld, newest], NOW);
    expect(out.map((t) => t.id)).toEqual([newest.id, recent.id, openOld.id]);
  });

  it('창 경계 — 정확히 30일 전은 포함, 그보다 하루 앞은 제외', () => {
    const edge = trade({ entry_at: '2026-08-04T12:00:00+09:00', exit_at: '2026-08-04T13:00:00+09:00' });
    const before = trade({ entry_at: '2026-08-03T12:00:00+09:00', exit_at: '2026-08-03T13:00:00+09:00' });
    expect(unjustifiedTrades([edge, before], NOW).map((t) => t.id)).toEqual([edge.id]);
  });
});
