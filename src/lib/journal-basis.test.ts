import { describe, expect, it } from 'vitest';

import type { Trade, TradeFill } from '@/lib/domain';
import { addOnFills, diffBasis, fillBasis, parseBasis, snapshotBasis } from '@/lib/journal-basis';

/** 보유중 롱 — 진입 100 · 계획 손절 95 · TP 105/110/- · 명목가 1000 · 10배. */
function trade(over: Partial<Trade> = {}): Trade {
  return {
    id: 't1',
    book_id: 'b1',
    user_id: 'u1',
    seq: 1,
    side: 'long',
    symbol: 'BTC',
    entry_at: '2026-09-01T00:00:00Z',
    exit_at: null,
    result: 'open',
    equity_before: null,
    equity_after: null,
    withdrawal: null,
    notional: 1000,
    leverage: 10,
    pnl: null,
    entry_price: 100,
    exit_price: null,
    fee: null,
    funding_fee: null,
    realized_pnl: null,
    unrealized_pnl: 12.5,
    margin_mode: null,
    stop_price: 95,
    tp1_price: 105,
    tp2_price: 110,
    tp3_price: null,
    tp1_pct: null,
    tp2_pct: null,
    tp3_pct: null,
    okx_stop_price: null,
    okx_tp_price: null,
    okx_sl_source: null,
    trend: null,
    openness: null,
    setup: null,
    rationale: null,
    review: null,
    emotion: null,
    note: null,
    okx_pos_id: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...over,
  };
}

function fill(over: Partial<TradeFill> = {}): TradeFill {
  return {
    id: 'f1',
    trade_id: 't1',
    user_id: 'u1',
    role: 'open',
    filled_at: '2026-09-01T00:00:00Z',
    price: 100,
    amount: 0.1,
    fee: null,
    order_no: null,
    okx_bill_id: null,
    created_at: '2026-09-01T00:00:00Z',
    ...over,
  };
}

describe('snapshotBasis', () => {
  it('거래 행의 수치를 그대로 뜬다 — 체결·변경은 비어 있다', () => {
    expect(snapshotBasis(trade())).toEqual({
      entry_price: 100,
      notional: 1000,
      leverage: 10,
      stop_price: 95,
      tp_prices: [105, 110, null],
      unrealized_pnl: 12.5,
      fill: null,
      changes: null,
    });
  });

  it('거래소에 걸린 손절·익절이 있으면 계획값보다 먼저다', () => {
    const b = snapshotBasis(trade({ okx_stop_price: 96, okx_tp_price: 107 }));
    expect(b.stop_price).toBe(96);
    expect(b.tp_prices[0]).toBe(107);
  });
});

describe('diffBasis', () => {
  it('직전 기록이 없으면 견줄 수 없다 — 빈 배열', () => {
    expect(diffBasis(null, snapshotBasis(trade()))).toEqual([]);
  });

  it('손절만 옮겼으면 손절 한 건', () => {
    const prev = snapshotBasis(trade());
    const cur = snapshotBasis(trade({ stop_price: 98 }));
    expect(diffBasis(prev, cur)).toEqual([{ label: '손절', from: 95, to: 98 }]);
  });

  it('추가 진입으로 진입가·투입이 같이 바뀌면 둘 다, 평가손익은 세지 않는다', () => {
    const prev = snapshotBasis(trade());
    const cur = snapshotBasis(trade({ entry_price: 101, notional: 2000, unrealized_pnl: -3 }));
    expect(diffBasis(prev, cur).map((c) => c.label)).toEqual(['진입가', '투입']);
  });

  it('TP 를 비우거나 새로 적은 것도 변경이다', () => {
    const prev = snapshotBasis(trade());
    const cur = snapshotBasis(trade({ tp2_price: null, tp3_price: 120 }));
    expect(diffBasis(prev, cur)).toEqual([
      { label: 'TP2', from: 110, to: null },
      { label: 'TP3', from: null, to: 120 },
    ]);
  });

  it('아무것도 안 바뀌면 빈 배열', () => {
    const b = snapshotBasis(trade());
    expect(diffBasis(b, snapshotBasis(trade()))).toEqual([]);
  });
});

describe('addOnFills', () => {
  it('첫 진입 체결과 청산 체결을 빼고, 오래된 것부터', () => {
    const fills = [
      fill({ id: 'c1', role: 'close', filled_at: '2026-09-03T00:00:00Z' }),
      fill({ id: 'o3', filled_at: '2026-09-02T12:00:00Z', price: 103 }),
      fill({ id: 'o1', filled_at: '2026-09-01T00:00:00Z' }),
      fill({ id: 'o2', filled_at: '2026-09-02T00:00:00Z', price: 102 }),
    ];
    expect(addOnFills(fills).map((f) => f.id)).toEqual(['o2', 'o3']);
  });

  it('진입 체결이 하나뿐이면 추가 진입은 없다', () => {
    expect(addOnFills([fill()])).toEqual([]);
  });
});

describe('parseBasis', () => {
  it('저장한 모양을 그대로 되읽는다', () => {
    const b = snapshotBasis(trade());
    b.fill = fillBasis(fill({ filled_at: '2026-09-02T00:00:00Z', price: 102, amount: 0.05 }));
    b.changes = [{ label: '손절', from: 95, to: 98 }];
    expect(parseBasis(JSON.parse(JSON.stringify(b)))).toEqual(b);
  });

  it('칸 하나가 깨졌으면 통째로 버린다', () => {
    const b = snapshotBasis(trade());
    expect(parseBasis({ ...b, stop_price: '95' })).toBeNull();
    expect(parseBasis({ ...b, tp_prices: 'x' })).toBeNull();
    expect(parseBasis({ ...b, fill: { filled_at: 1, price: 100, amount: null } })).toBeNull();
    expect(parseBasis(null)).toBeNull();
    expect(parseBasis([])).toBeNull();
  });
});
