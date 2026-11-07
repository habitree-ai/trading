import { describe, expect, it } from 'vitest';

import {
  legPoints,
  legResult,
  matchFill,
  parseChecklist,
  parseLegSignals,
  type LegFill,
  type LegLike,
  type LegTrade,
} from '@/lib/legs';

const AT = '2026-11-01T10:00:00.000Z';
const plus = (min: number) => new Date(Date.parse(AT) + min * 60_000).toISOString();

const fill = (id: string, min: number, price: number, extra: Partial<LegFill> = {}): LegFill => ({
  id,
  trade_id: 't1',
  role: 'open',
  filled_at: plus(min),
  price,
  ...extra,
});

const leg = (extra: Partial<LegLike> = {}): LegLike => ({
  trade_id: 't1',
  leg_no: 1,
  at: AT,
  qty: 0.1,
  common_stop: 101,
  fill_id: null,
  ...extra,
});

describe('matchFill', () => {
  it('±10분 안에서 가장 가까운 진입 체결', () => {
    const fills = [fill('a', -8, 1), fill('b', 3, 2), fill('c', -4, 3), fill('x', 1, 9, { role: 'close' })];
    expect(matchFill(leg(), fills)?.id).toBe('b');
  });

  it('범위 밖이면 null', () => {
    expect(matchFill(leg(), [fill('a', -11, 1), fill('b', 10.5, 2)])).toBeNull();
  });

  it('다른 거래의 체결은 잇지 않는다', () => {
    expect(matchFill(leg(), [fill('a', 1, 1, { trade_id: 't2' })])).toBeNull();
  });

  it('fill_id 가 있으면 시각과 무관하게 그것', () => {
    const fills = [fill('near', 0, 1), fill('pinned', 60, 2)];
    expect(matchFill(leg({ fill_id: 'pinned' }), fills)?.id).toBe('pinned');
  });

  it('같은 거리면 먼저 온 체결', () => {
    expect(matchFill(leg(), [fill('late', 2, 1), fill('early', -2, 2)])?.id).toBe('early');
  });
});

describe('legResult', () => {
  const closedLong: LegTrade = { side: 'long', exit_at: plus(120), exit_price: 120, fee_rate_at_entry: 0.0005 };

  it('롱 — 체결 110, 공통 손절 101, 청산 120', () => {
    const r = legResult(closedLong, leg(), [fill('a', 1, 110)], 0.001);
    // 1R = 9 × 0.1 = 0.9, 가격R = 10/9, 비용R = 230 × 0.0005 / 9
    expect(r.reason).toBeNull();
    expect(r.fill?.id).toBe('a');
    expect(r.oneRUsd).toBeCloseTo(0.9, 10);
    expect(r.priceR).toBeCloseTo(10 / 9, 10);
    expect(r.costR).toBeCloseTo((230 * 0.0005) / 9, 10);
    expect(r.netR).toBeCloseTo(10 / 9 - (230 * 0.0005) / 9, 10);
  });

  it('숏 — 체결 90, 공통 손절 99, 청산 95, 진입 시점 수수료율 없으면 현재값', () => {
    const t: LegTrade = { side: 'short', exit_at: plus(60), exit_price: 95, fee_rate_at_entry: null };
    const r = legResult(t, leg({ common_stop: 99 }), [fill('a', 0, 90)], 0.001);
    // 1R = 9 × 0.1, 가격R = −5/9, 비용R = 185 × 0.001 / 9
    expect(r.reason).toBeNull();
    expect(r.priceR).toBeCloseTo(-5 / 9, 10);
    expect(r.costR).toBeCloseTo((185 * 0.001) / 9, 10);
    expect(r.netR).toBeCloseTo(-5 / 9 - 0.185 / 9, 10);
  });

  it('보유 중이면 open — R 은 비우고 1R 은 잰다', () => {
    const t: LegTrade = { side: 'long', exit_at: null, exit_price: null, fee_rate_at_entry: 0.0005 };
    const r = legResult(t, leg(), [fill('a', 0, 110)], 0.001);
    expect(r.reason).toBe('open');
    expect(r.netR).toBeNull();
    expect(r.priceR).toBeNull();
    expect(r.oneRUsd).toBeCloseTo(0.9, 10);
  });

  it('공통 손절 없으면 no_common_stop', () => {
    const r = legResult(closedLong, leg({ common_stop: null }), [fill('a', 0, 110)], 0.001);
    expect(r.reason).toBe('no_common_stop');
    expect(r.netR).toBeNull();
  });

  it('롱인데 체결가 ≤ 공통 손절이면 wrong_side', () => {
    const r = legResult(closedLong, leg({ common_stop: 110 }), [fill('a', 0, 110)], 0.001);
    expect(r.reason).toBe('wrong_side');
    expect(r.oneRUsd).toBeNull();
    expect(r.netR).toBeNull();
  });

  it('숏인데 체결가 ≥ 공통 손절이면 wrong_side', () => {
    const t: LegTrade = { side: 'short', exit_at: plus(60), exit_price: 95, fee_rate_at_entry: null };
    expect(legResult(t, leg({ common_stop: 89 }), [fill('a', 0, 90)], 0.001).reason).toBe('wrong_side');
  });

  it('매칭 체결 없으면 no_fill — 의도가로 계산하지 않는다', () => {
    const r = legResult(closedLong, leg(), [fill('a', 30, 110)], 0.001);
    expect(r.reason).toBe('no_fill');
    expect(r.fill).toBeNull();
    expect(r.oneRUsd).toBeNull();
    expect(r.netR).toBeNull();
  });
});

describe('legPoints', () => {
  it('잰 다리만 시각순 누적', () => {
    const pts = legPoints([
      { leg: { trade_id: 't2', leg_no: 1, at: plus(10) }, result: { netR: -1 } },
      { leg: { trade_id: 't1', leg_no: 1, at: plus(0) }, result: { netR: 2 } },
      { leg: { trade_id: 't3', leg_no: 1, at: plus(5) }, result: { netR: null } },
    ]);
    expect(pts.map((p) => [p.tradeId, p.r, p.cum])).toEqual([
      ['t1', 2, 2],
      ['t2', -1, 1],
    ]);
  });
});

describe('parseLegSignals', () => {
  const ok = {
    bbwPct: 0.15,
    atrRatio: 1.4,
    netGexSign: -1,
    wallDistPct: 2.1,
    depthRatio: null,
    lvnDistPct: 0.4,
    warnings: ['과열'],
    onLong: 2,
    onShort: 0,
    collectedAt: AT,
  };

  it('정상 — 그대로 읽는다(미측정 null 유지)', () => {
    expect(parseLegSignals(ok)).toEqual(ok);
  });

  it('한 칸이라도 깨지면 null', () => {
    expect(parseLegSignals({ ...ok, bbwPct: '0.15' })).toBeNull();
    expect(parseLegSignals({ ...ok, netGexSign: 2 })).toBeNull();
    expect(parseLegSignals({ ...ok, warnings: [1] })).toBeNull();
    expect(parseLegSignals({ ...ok, onLong: -1 })).toBeNull();
    expect(parseLegSignals({ ...ok, collectedAt: undefined })).toBeNull();
    expect(parseLegSignals(null)).toBeNull();
    expect(parseLegSignals([ok])).toBeNull();
  });
});

describe('parseChecklist', () => {
  const items = [
    { key: 'level', ok: null, auto: false, detail: '확인 불가' },
    { key: 'cr_zero', ok: true, auto: true, detail: 'CR 0' },
    { key: 'cost_cap', ok: false, auto: true, detail: '비용R 0.31' },
  ];

  it('정상', () => {
    expect(parseChecklist(items)).toEqual(items);
    expect(parseChecklist([])).toEqual([]);
  });

  it('줄 하나가 깨지면 null', () => {
    expect(parseChecklist([...items, { key: 'unknown', ok: true, auto: true, detail: '' }])).toBeNull();
    expect(parseChecklist([{ key: 'level', ok: 'yes', auto: false, detail: '' }])).toBeNull();
    expect(parseChecklist([{ key: 'level', ok: true, detail: '' }])).toBeNull();
    expect(parseChecklist({ key: 'level' })).toBeNull();
  });
});
