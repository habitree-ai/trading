import { describe, expect, it } from 'vitest';

import type { Trade } from '@/lib/domain';
import {
  attachedTarget,
  dailyStatus,
  gateOpen,
  marginNeeded,
  planGate,
  planRisk,
  sizeOrder,
  type OrderPlan,
} from '@/lib/manual-order';

/** BTC-USDT-SWAP 규격 — ctVal 0.01 BTC, lot 0.01 계약. */
const BTC = { ctVal: 0.01, lotSz: 0.01, szDecimals: 2 };

describe('sizeOrder', () => {
  it('명목가를 lot 단위로 내려 계약 수를 낸다', () => {
    // 한 계약 = 0.01 × 100,000 = 1,000 USDT. 2,550 USDT → 2.55 계약.
    const s = sizeOrder({ notionalUsd: 2550, price: 100_000, ...BTC });
    expect(s.contracts).toBe(2.55);
    expect(s.sz).toBe('2.55');
    expect(s.notional).toBeCloseTo(2550, 6);
  });

  it('lot 에 못 미치는 나머지는 버린다 — 반올림으로 한 lot 더 싣지 않는다', () => {
    const s = sizeOrder({ notionalUsd: 2559, price: 100_000, ...BTC });
    expect(s.contracts).toBe(2.55);
    expect(s.notional).toBeCloseTo(2550, 6);
  });

  it('정확히 n lot 인 값이 부동소수 오차로 한 lot 내려가지 않는다', () => {
    // 0.3 / 0.01 = 29.999999999999996 → floor 하면 29. 보정이 없으면 0.29 가 된다.
    const s = sizeOrder({ notionalUsd: 30, price: 10_000, ...BTC });
    expect(s.contracts).toBe(0.3);
  });

  it('최소 lot 보다 작으면 0 계약', () => {
    const s = sizeOrder({ notionalUsd: 5, price: 100_000, ...BTC });
    expect(s.contracts).toBe(0);
    expect(s.sz).toBe('0.00');
  });

  it('시세·명목가가 없으면 0', () => {
    expect(sizeOrder({ notionalUsd: 0, price: 100_000, ...BTC }).contracts).toBe(0);
    expect(sizeOrder({ notionalUsd: 100, price: 0, ...BTC }).contracts).toBe(0);
  });
});

describe('marginNeeded', () => {
  it('격리 증거금에 여유를 얹는다', () => {
    const m = marginNeeded(1000, 10);
    expect(m.margin).toBe(100);
    expect(m.need).toBeCloseTo(110, 6);
  });
});

const base: OrderPlan = {
  side: 'long',
  price: 100_000,
  stop: 99_000,
  targets: [102_000, null, null],
  notionalUsd: 1000,
  leverage: 10,
  setup: '4H 지지 되돌림',
  rationale: '4시간봉 지지선 되돌림에서 거래량 실림, RSI 30 반등',
};

describe('planGate', () => {
  it('다 채운 롱 계획은 전부 열린다', () => {
    const items = planGate(base, { minNotional: 10 });
    expect(items.map((g) => g.ok)).toEqual([true, true, true, true, true]);
    expect(gateOpen(items)).toBe(true);
  });

  it('근거가 20자 미만이면 닫힌다', () => {
    const items = planGate({ ...base, rationale: '그냥 오를 것 같음' }, { minNotional: null });
    const r = items.find((g) => g.key === 'rationale')!;
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('10/20자');
    expect(gateOpen(items)).toBe(false);
  });

  it('기준이 비면 닫힌다', () => {
    const items = planGate({ ...base, setup: '  ' }, { minNotional: null });
    expect(items.find((g) => g.key === 'setup')!.ok).toBe(false);
  });

  it('롱인데 손절이 진입 위에 있으면 닫힌다', () => {
    const items = planGate({ ...base, stop: 101_000 }, { minNotional: null });
    const s = items.find((g) => g.key === 'stop')!;
    expect(s.ok).toBe(false);
    expect(s.detail).toContain('반대쪽');
  });

  it('숏은 손절 위·목표 아래여야 한다', () => {
    const short: OrderPlan = { ...base, side: 'short', stop: 101_000, targets: [98_000, null, null] };
    expect(gateOpen(planGate(short, { minNotional: null }))).toBe(true);
    const flipped = planGate({ ...short, stop: 99_000 }, { minNotional: null });
    expect(flipped.find((g) => g.key === 'stop')!.ok).toBe(false);
  });

  it('TP1 이 없으면 닫히고, TP2 가 TP1 안쪽이면 닫힌다', () => {
    expect(planGate({ ...base, targets: [null, null, null] }, { minNotional: null }).find((g) => g.key === 'target')!.ok).toBe(false);
    const inner = planGate({ ...base, targets: [102_000, 101_000, null] }, { minNotional: null });
    const t = inner.find((g) => g.key === 'target')!;
    expect(t.ok).toBe(false);
    expect(t.detail).toContain('TP2');
  });

  it('TP 가 순서대로 멀어지면 열린다', () => {
    const items = planGate({ ...base, targets: [102_000, 103_000, 105_000] }, { minNotional: null });
    expect(items.find((g) => g.key === 'target')!.ok).toBe(true);
  });

  it('투입이 최소 명목가보다 작거나 레버리지가 범위 밖이면 닫힌다', () => {
    expect(planGate({ ...base, notionalUsd: 5 }, { minNotional: 10 }).find((g) => g.key === 'size')!.ok).toBe(false);
    expect(planGate({ ...base, leverage: 0 }, { minNotional: null }).find((g) => g.key === 'size')!.ok).toBe(false);
    expect(planGate({ ...base, leverage: 101 }, { minNotional: null }).find((g) => g.key === 'size')!.ok).toBe(false);
    expect(planGate({ ...base, notionalUsd: null }, { minNotional: null }).find((g) => g.key === 'size')!.ok).toBe(false);
  });
});

describe('attachedTarget', () => {
  it('TP 가 하나일 때만 브래킷에 건다', () => {
    expect(attachedTarget([102_000, null, null])).toBe(102_000);
    expect(attachedTarget([null, 103_000, null])).toBe(103_000);
    expect(attachedTarget([102_000, 103_000, null])).toBeUndefined();
    expect(attachedTarget([null, null, null])).toBeUndefined();
  });
});

describe('planRisk', () => {
  it('손절폭 × 명목가가 리스크 금액, 잔고 대비 % 와 손익비를 낸다', () => {
    const r = planRisk(base, 2000)!;
    expect(r.riskAmount).toBeCloseTo(10, 6); // 1% × 1000
    expect(r.riskPctOfEquity).toBeCloseTo(0.5, 6);
    expect(r.rr).toBeCloseTo(2, 6);
  });

  it('계획이 덜 찼거나 방향이 어긋나면 null', () => {
    expect(planRisk({ ...base, stop: null }, 2000)).toBeNull();
    expect(planRisk({ ...base, stop: 101_000 }, 2000)).toBeNull();
    expect(planRisk({ ...base, notionalUsd: null }, 2000)).toBeNull();
  });

  it('잔고가 없으면 % 만 null', () => {
    const r = planRisk(base, null)!;
    expect(r.riskAmount).toBeCloseTo(10, 6);
    expect(r.riskPctOfEquity).toBeNull();
  });
});

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
    entry_at: '2026-09-03T10:00:00+09:00',
    exit_at: '2026-09-03T11:00:00+09:00',
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
    created_at: '2026-09-03T10:00:00+09:00',
    updated_at: '2026-09-03T10:00:00+09:00',
    ...partial,
  };
}

describe('dailyStatus', () => {
  const now = '2026-09-03T15:00:00+09:00';

  it('오늘 진입·손실을 세고 다음 진입 번호를 낸다', () => {
    const s = dailyStatus([trade(), trade({ pnl: -5, result: 'loss' })], now);
    expect(s.entriesToday).toBe(2);
    expect(s.lossesToday).toBe(1);
    expect(s.nextEntryNo).toBe(3);
    expect(s.overEntries).toBe(false);
    expect(s.overLosses).toBe(false);
  });

  it('3건 있으면 다음은 상한 초과, 손실 2건이면 종료 신호', () => {
    const s = dailyStatus(
      [trade({ pnl: -1, result: 'loss' }), trade({ pnl: -1, result: 'loss' }), trade()],
      now,
    );
    expect(s.overEntries).toBe(true);
    expect(s.overLosses).toBe(true);
  });

  it('어제 거래는 세지 않고, 어제 들어가 오늘 잃은 것은 오늘 손실이다', () => {
    const s = dailyStatus(
      [
        trade({ entry_at: '2026-09-02T22:00:00+09:00', exit_at: '2026-09-03T01:00:00+09:00', pnl: -3, result: 'loss' }),
        trade({ entry_at: '2026-09-02T10:00:00+09:00', exit_at: '2026-09-02T11:00:00+09:00' }),
      ],
      now,
    );
    expect(s.entriesToday).toBe(0);
    expect(s.lossesToday).toBe(1);
  });

  it('보유중 거래는 손실로 세지 않는다', () => {
    const s = dailyStatus([trade({ exit_at: null, pnl: null, result: 'open' })], now);
    expect(s.entriesToday).toBe(1);
    expect(s.lossesToday).toBe(0);
  });
});
