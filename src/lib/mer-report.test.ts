import { describe, expect, it } from 'vitest';

import type { MerZoneHit } from '@/lib/domain';
import { MER_ZONES_R } from '@/lib/mer';
import {
  buildMerReport,
  firstEntry,
  hitToInput,
  merCandidate,
  openGroupCount,
  type MerReportTrade,
} from '@/lib/mer-report';

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse('2026-10-01T00:00:00Z');
const M = 60_000;

describe('merCandidate — 시뮬 대상', () => {
  const base = { side: 'long' as const, exit_at: iso(T0), exit_price: 101, entry_price: 100, stop_px_0: 99 };
  it('청산 + 위험 쪽 최초 손절이면 대상', () => expect(merCandidate(base)).toBe(true));
  it('보유 중(청산 시각 없음)은 제외', () => expect(merCandidate({ ...base, exit_at: null })).toBe(false));
  it('최초 손절 없음은 제외', () => expect(merCandidate({ ...base, stop_px_0: null })).toBe(false));
  it('이익 쪽 손절(롱인데 진입가 위)은 제외', () => expect(merCandidate({ ...base, stop_px_0: 100.5 })).toBe(false));
  it('숏은 손절이 위여야 대상', () => {
    expect(merCandidate({ ...base, side: 'short', stop_px_0: 101 })).toBe(true);
    expect(merCandidate({ ...base, side: 'short' })).toBe(false);
  });
});

describe('firstEntry — 첫 진입 체결 묶음', () => {
  const trade = { entry_price: 105, entry_at: iso(T0) };
  it('1분 안 잇단 체결은 가중평균, 그 뒤 추가는 빼고 첫 묶음만', () => {
    const e = firstEntry(trade, [
      { role: 'open', filled_at: iso(T0), price: 100, amount: 100 }, // 1 코인
      { role: 'open', filled_at: iso(T0 + 30_000), price: 102, amount: 306 }, // 3 코인
      { role: 'open', filled_at: iso(T0 + 60 * M), price: 110, amount: 110 },
    ]);
    expect(e?.fromFills).toBe(true);
    expect(e?.px).toBeCloseTo((100 * 1 + 102 * 3) / 4, 9);
    expect(e?.atMs).toBe(T0);
  });
  it('체결 없으면 거래 진입가', () => {
    expect(firstEntry(trade, [])).toEqual({ px: 105, atMs: T0, fromFills: false });
  });
  it('수량 모르는 진입 체결이 있으면 거래 진입가로(틀린 가중평균보다)', () => {
    const e = firstEntry(trade, [{ role: 'open', filled_at: iso(T0), price: 100, amount: null }]);
    expect(e?.fromFills).toBe(false);
    expect(e?.px).toBe(105);
  });
});

describe('openGroupCount — 실제 추가 여부', () => {
  it('1분 넘게 떨어진 진입 체결은 다른 묶음, 청산 체결은 세지 않음', () => {
    expect(
      openGroupCount([
        { role: 'open', filled_at: iso(T0), price: 1 },
        { role: 'open', filled_at: iso(T0 + 10_000), price: 1 },
        { role: 'close', filled_at: iso(T0 + 2 * M), price: 1 },
        { role: 'open', filled_at: iso(T0 + 5 * M), price: 1 },
      ]),
    ).toBe(2);
  });
});

const hitRow = (tradeId: string, zone: number, over: Partial<MerZoneHit> = {}): MerZoneHit => ({
  id: `${tradeId}-${zone}`,
  user_id: 'u',
  trade_id: tradeId,
  zone_r: zone,
  sim_version: 1,
  bar: '1m',
  entry_at: iso(T0),
  entry_px: 100,
  stop_px: 99,
  common_stop_px: 100.1,
  fee_rate: 0,
  zone_px: 100 + zone,
  outcome: 'exit_first',
  reached_at: null,
  common_stop_hit_at: null,
  exit_at: iso(T0 + 60 * M),
  exit_px: 104,
  computed_at: iso(T0),
  ...over,
});

const trade = (id: string, over: Partial<MerReportTrade> = {}): MerReportTrade => ({
  id,
  book_id: 'b1',
  side: 'long',
  entry_price: 100,
  notional: 1000, // 10 코인
  pnl: 40,
  fee: 0,
  funding_fee: 0,
  realized_pnl: 40,
  exit_at: iso(T0 + 60 * M),
  result: 'win',
  stop_px_0: 99,
  stop_px_0_source: 'plan',
  r_base_at_entry: null,
  fee_rate_at_entry: 0,
  ...over,
});

describe('hitToInput — 관측 행 읽기', () => {
  it('구간 밖 zone_r·모르는 봉·도달인데 도달 시각 없음은 null', () => {
    expect(hitToInput('long', hitRow('a', 1.25))).toBeNull();
    expect(hitToInput('long', hitRow('a', 1, { bar: '2m' }))).toBeNull();
    expect(hitToInput('long', hitRow('a', 1, { outcome: 'reached' }))).toBeNull();
  });
});

describe('buildMerReport — 조립', () => {
  // 거래 a: +1R 도달(수수료 0, 공통 손절 100) → 청산 104 → 다리 R = (104−101)/(101−100) = 3
  const fee0 = { fee_rate: 0, common_stop_px: 100 };
  const hits: MerZoneHit[] = [
    ...MER_ZONES_R.map((z) =>
      z === 1 ? hitRow('a', z, { ...fee0, outcome: 'reached', reached_at: iso(T0 + 5 * M) }) : hitRow('a', z, fee0),
    ),
    ...MER_ZONES_R.map((z) => hitRow('b', z, { ...fee0, outcome: 'stop_first', bar: '5m' })),
    hitRow('other-user-trade', 1, fee0),
    hitRow('a', 1.25, fee0),
  ];
  const trades = [trade('a', { stop_px_0_source: 'okx_last' }), trade('b', { book_id: 'b2', pnl: -10, realized_pnl: -10, result: 'loss' })];
  const report = buildMerReport(trades, hits, { a: 2, b: 1 });

  it('표본·북별·봉·추정 손절·실제 추가', () => {
    expect(report.sampleTrades).toBe(2);
    expect(report.byBook).toEqual({ b1: 1, b2: 1 });
    expect(report.bars).toEqual({ '1m': 1, '5m': 1 });
    expect(report.estimated).toBe(1);
    expect(report.actualAdds).toBe(1);
    expect(report.invalidHits).toBe(1);
  });

  it('MER₀ = 같은 표본의 거래 R 엣지 — a +4R(40/10), b −1R → 평균 +1.5R', () => {
    expect(report.mer0N).toBe(2);
    expect(report.mer0).toBeCloseTo(1.5, 9);
  });

  it('구간 +1R 다리 R 3, 나머지 구간 표본 0 · 표본 부족이라 추가 자리 없음', () => {
    const z1 = report.rows.find((r) => r.zoneR === 1);
    expect(z1?.stats.n).toBe(1);
    expect(z1?.mer).toBeCloseTo(3, 9);
    expect(z1?.verdict).toBe('insufficient');
    expect(report.rows.filter((r) => r.zoneR !== 1).every((r) => r.stats.n === 0)).toBe(true);
    expect(report.best).toBeNull();
    expect(report.withAdd).toBeNull();
  });

  it('범위 밖 거래의 관측은 쓰지 않는다', () => {
    const only = buildMerReport([trades[1]], hits, {});
    expect(only.sampleTrades).toBe(1);
    expect(only.rows.every((r) => r.stats.n === 0)).toBe(true);
  });

  it('통과 구간이 있으면 그 구간 도달 거래의 원래 R vs 추가 포함 R', () => {
    // 60건이 모두 +1R 도달·다리 R 3, 거래 R +4 → 엣지 확인·MER 3 > MER₀? MER₀ 4 라 통과 못 함.
    // 거래 R 을 +1(10/10)로 낮춰 MER₀ 1 < MER 3 이 되게 한다.
    const many = Array.from({ length: 60 }, (_, i) => trade(`t${i}`, { pnl: 10, realized_pnl: 10 }));
    const manyHits = many.map((t) => hitRow(t.id, 1, { ...fee0, outcome: 'reached', reached_at: iso(T0 + 5 * M) }));
    const r = buildMerReport(many, manyHits, {});
    expect(r.best).toBe(1);
    expect(r.withAdd?.n).toBe(60);
    expect(r.withAdd?.original).toBeCloseTo(1, 9);
    expect(r.withAdd?.withAdd).toBeCloseTo(4, 9);
  });
});
