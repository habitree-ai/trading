import { describe, expect, it } from 'vitest';

import {
  commonStopPrice,
  legResultR,
  legSizing,
  merTable,
  simulateZones,
  withAddTradeR,
  zonePrice,
  type MerTradeInput,
  type ZoneHit,
} from '@/lib/mer';
import type { Candle } from '@/lib/okx';

const H = 3_600_000;
const T0 = 1_000 * H;
const FEE = 0.0005;

/** 봉 i 개째(1H) — o/c 는 판정에 안 쓰므로 고가·저가만 의미 있다. */
const bar = (i: number, h: number, l: number): Candle => ({ t: T0 + i * H, o: (h + l) / 2, h, l, c: (h + l) / 2, v: 1 });

const longInput = (over: Partial<MerTradeInput> = {}): MerTradeInput => ({
  side: 'long',
  entryMs: T0 + 5 * 60_000,
  entry0: 100_000,
  stop0: 99_000,
  exitMs: T0 + 5 * H + 10 * 60_000,
  exit0: 103_000,
  feeRate: FEE,
  ...over,
});

describe('zonePrice — ① 구간 가격', () => {
  it('롱 100,000 / 손절 99,000 → +1R 101,000 · +2R 102,000', () => {
    expect(zonePrice('long', 100_000, 1_000, 1)).toBe(101_000);
    expect(zonePrice('long', 100_000, 1_000, 2)).toBe(102_000);
  });
  it('숏 대칭 → +1R 99,000 · +2R 98,000', () => {
    expect(zonePrice('short', 100_000, 1_000, 1)).toBe(99_000);
    expect(zonePrice('short', 100_000, 1_000, 2)).toBe(98_000);
  });
});

describe('commonStopPrice — ② 비용만큼 이익 쪽', () => {
  it('롱 100,100 (진입가 위)', () => {
    expect(commonStopPrice('long', 100_000, FEE)).toBeCloseTo(100_100, 6);
  });
  it('숏 99,900 (진입가 아래)', () => {
    expect(commonStopPrice('short', 100_000, FEE)).toBeCloseTo(99_900, 6);
  });
});

describe('legSizing — ③ 공통 손절 기준 1R 수량', () => {
  it('rBase 10, 추가가 101,000, 공통 손절 100,100 → qty 10/900', () => {
    const s = legSizing('long', 10, 0.02, 101_000, 100_100, FEE);
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.qty).toBeCloseTo(10 / 900, 12);
    expect(s.oneRUsd).toBeCloseTo(10, 10);
    expect(s.costR).toBeCloseTo(((101_000 + 100_100) * FEE * (10 / 900)) / 10, 12);
    expect(s.eAdd).toBeCloseTo(10 / 900 / 0.02, 10);
  });
  it('숏 대칭 — 추가가 99,000, 공통 손절 99,900', () => {
    const s = legSizing('short', 10, 0.02, 99_000, 99_900, FEE);
    expect(s?.qty).toBeCloseTo(10 / 900, 12);
  });
  it('공통 손절이 추가가보다 불리한 쪽이 아니면 null, oneE 0 이면 eAdd null', () => {
    expect(legSizing('long', 10, 0.02, 100_000, 100_100, FEE)).toBeNull();
    expect(legSizing('long', 10, 0, 101_000, 100_100, FEE)?.eAdd).toBeNull();
  });
});

describe('simulateZones — ④ 합성 봉', () => {
  it('도달 · exit_first · 도달 후 공통 손절 터치(다음 봉부터)', () => {
    const candles = [
      bar(-1, 200_000, 1), // 진입 봉 이전 — 무시
      bar(0, 100_500, 99_500),
      bar(1, 101_200, 100_300), // +1R 도달
      bar(2, 102_100, 100_600), // +2R 도달
      bar(3, 101_800, 100_050), // 공통 손절 100,100 터치
      bar(5, 102_000, 101_000), // 청산 봉
      bar(6, 110_000, 90_000), // 청산 봉 이후 — 무시
    ];
    const hits = simulateZones(longInput(), candles, '1H', [1, 2, 3]);
    expect(hits.map((h) => h.outcome)).toEqual(['reached', 'reached', 'exit_first']);
    expect(hits[0].reachedAtMs).toBe(T0 + H);
    expect(hits[0].commonStopHitAtMs).toBe(T0 + 3 * H);
    expect(hits[1].reachedAtMs).toBe(T0 + 2 * H);
    expect(hits[1].commonStopHitAtMs).toBe(T0 + 3 * H);
    expect(hits[2]).toMatchObject({ zonePx: 103_000, reachedAtMs: null, commonStopHitAtMs: null, bar: '1H' });
  });

  it('도달 전 최초 손절 → stop_first, 같은 봉에 도달·손절이 같이 있어도 stop_first', () => {
    const before = simulateZones(longInput(), [bar(0, 100_500, 98_900), bar(1, 102_000, 100_500)], '1H', [1]);
    expect(before[0].outcome).toBe('stop_first');
    const same = simulateZones(longInput(), [bar(0, 101_500, 98_900)], '1H', [1]);
    expect(same[0]).toMatchObject({ outcome: 'stop_first', reachedAtMs: null });
  });

  it('도달 봉 안의 공통 손절 터치는 세지 않는다', () => {
    const hits = simulateZones(longInput(), [bar(0, 101_500, 100_000), bar(1, 101_500, 100_800)], '1H', [1]);
    expect(hits[0]).toMatchObject({ outcome: 'reached', reachedAtMs: T0, commonStopHitAtMs: null });
  });

  it('구간마다 독립 — +1R 도달 뒤 최초 손절이 오면 +2R 은 stop_first', () => {
    const candles = [bar(0, 101_100, 100_200), bar(1, 100_000, 98_800), bar(2, 102_500, 100_000)];
    const hits = simulateZones(longInput(), candles, '1H', [1, 2]);
    expect(hits[0]).toMatchObject({ outcome: 'reached', commonStopHitAtMs: T0 + H });
    expect(hits[1].outcome).toBe('stop_first');
  });

  it('숏 대칭', () => {
    const input = longInput({ side: 'short', stop0: 101_000, exit0: 97_000 });
    const candles = [bar(0, 100_500, 99_500), bar(1, 99_700, 98_800), bar(2, 99_950, 99_200)];
    const hits = simulateZones(input, candles, '1H', [1, 2]);
    expect(hits[0]).toMatchObject({ zonePx: 99_000, outcome: 'reached', reachedAtMs: T0 + H, commonStopHitAtMs: T0 + 2 * H });
    expect(hits[1].outcome).toBe('exit_first');
  });

  it('손절폭이 없거나 봉이 없으면 빈 배열', () => {
    expect(simulateZones(longInput({ stop0: 100_000 }), [bar(0, 1, 1)], '1H')).toEqual([]);
    expect(simulateZones(longInput(), [], '1H')).toEqual([]);
  });
});

describe('legResultR — ⑤ 다리 순 R', () => {
  const reached = (commonStopHitAtMs: number | null): ZoneHit => ({
    zoneR: 1,
    zonePx: 101_000,
    outcome: 'reached',
    reachedAtMs: T0,
    commonStopHitAtMs,
    bar: '1H',
  });

  it('공통 손절 터치 → −1R − 비용R', () => {
    const costR = ((101_000 + 100_100) * FEE) / 900;
    expect(legResultR(longInput(), reached(T0 + H))).toBeCloseTo(-1 - costR, 10);
  });

  it('청산 103,000 → 2000/900 − 비용R', () => {
    const expected = 2_000 / 900 - ((101_000 + 103_000) * FEE) / 900;
    expect(legResultR(longInput(), reached(null))).toBeCloseTo(expected, 10);
  });

  it('숏 대칭 — 공통 손절 터치 → −1R − 비용R', () => {
    const input = longInput({ side: 'short', stop0: 101_000, exit0: 97_000 });
    const hit: ZoneHit = { ...reached(T0 + H), zonePx: 99_000 };
    expect(legResultR(input, hit)).toBeCloseTo(-1 - ((99_000 + 99_900) * FEE) / 900, 10);
  });

  it('reached 아니면 null', () => {
    expect(legResultR(longInput(), { ...reached(null), outcome: 'stop_first' })).toBeNull();
  });
});

describe('merTable — ⑥ 구간 판정', () => {
  const t = merTable({ 1: Array(60).fill(0.5), 1.5: Array(60).fill(0.6), 2: Array(20).fill(1) }, 0.2, { 1: { '1H': 60 } });

  it('N≥50 양수 → positive · pass, N 20 → insufficient', () => {
    expect(t.rows[0]).toMatchObject({ zoneR: 1, verdict: 'positive', pass: true, bars: { '1H': 60 } });
    expect(t.rows[1]).toMatchObject({ zoneR: 1.5, verdict: 'positive', pass: true });
    expect(t.rows[2]).toMatchObject({ zoneR: 2, verdict: 'insufficient', pass: false });
    expect(t.rows[3]).toMatchObject({ zoneR: 2.5, mer: null, deltaMer: null, pass: false });
  });

  it('ΔMER — 첫 구간은 mer0 대비, 다음은 직전 구간 대비. best = 통과 중 ΔMER 최대', () => {
    expect(t.rows[0].deltaMer).toBeCloseTo(0.3, 10);
    expect(t.rows[1].deltaMer).toBeCloseTo(0.1, 10);
    expect(t.rows[2].deltaMer).toBeCloseTo(0.4, 10);
    expect(t.best).toBe(1);
  });

  it('MER 가 mer0 이하면 엣지 확인이어도 통과 아님, mer0 null 이면 0 초과만', () => {
    expect(merTable({ 1: Array(60).fill(0.1) }, 0.2).rows[0].pass).toBe(false);
    expect(merTable({ 1: Array(60).fill(0.1) }, null).rows[0]).toMatchObject({ pass: true, deltaMer: null });
    expect(merTable({}, null).best).toBeNull();
  });
});

describe('withAddTradeR', () => {
  it('원 R + 다리 순 R 합', () => {
    expect(withAddTradeR(1.2, [0.5, -1.1])).toBeCloseTo(0.6, 10);
    expect(withAddTradeR(-1, [])).toBe(-1);
  });
});
