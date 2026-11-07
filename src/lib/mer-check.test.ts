import { describe, expect, it } from 'vitest';

import type { CheckKey } from '@/lib/legs';
import type { LimitTrade } from '@/lib/loss-limits';
import { accelSignals, evaluateAddChecklist, type AccelInput, type AddCheckInput } from '@/lib/mer-check';
import { merTable } from '@/lib/mer';
import type { ThresholdReport, ThresholdSummary } from '@/lib/threshold/types';

// 롱 · 기준 R 10 · 최초 진입 100 · 최초 손절 95(d₀ 5, 1E 2개) · 수수료 0.05% → 공통 손절 100.1
const passingRs = Array.from({ length: 60 }, (_, i) => (i % 3 === 2 ? -1 : 1.5));
const { rows } = merTable({ 2: passingRs, 2.5: passingRs.slice(0, 23) }, 0.1);

function report(summary: Partial<ThresholdSummary> = {}): ThresholdReport {
  return {
    symbol: 'BTC',
    collectedAt: '2026-11-07T05:00:00.000Z',
    spot: 110,
    volatility: [],
    gamma: null,
    fuel: null,
    liquidity: null,
    summary: {
      warnings: { long: [], short: [] },
      on: { long: 1, short: 0 },
      measuredCount: 4,
      measured: true,
      ...summary,
    },
    sources: { candles: 'ok', options: 'ok', derivs: 'ok', book: 'ok' },
  };
}

const base: AddCheckInput = {
  side: 'long',
  rBase: 10,
  oneE: 2,
  cr0: 1,
  qty: 2,
  avgPx: 100,
  stopPx: 100.1,
  entry0: 100,
  feeRate: 0.0005,
  addPrice: 110,
  zoneR: 2,
  merRows: rows,
  threshold: report(),
  level: 2,
  accel: [],
};

const okOf = (input: AddCheckInput, key: CheckKey) =>
  evaluateAddChecklist(input).items.find((i) => i.key === key)?.ok;

describe('evaluateAddChecklist', () => {
  it('모두 깨끗하면 8줄 예 · allOk', () => {
    const r = evaluateAddChecklist(base);
    expect(r.items.map((i) => i.key)).toEqual([
      'level',
      'cr_zero',
      'zone_passed',
      'zone_sample',
      'threshold',
      'risk_cap',
      'cost_cap',
      'no_accel',
    ]);
    expect(r.items.every((i) => i.ok === true)).toBe(true);
    expect(r.allOk).toBe(true);
    expect(r.commonStop).toBeCloseTo(100.1);
    expect(r.addQty).toBeCloseTo(10 / 9.9);
    expect(r.preview?.after.cr).toBeLessThanOrEqual(1);
  });

  it('레벨 — null 확인 불가, 1 아니오(수동 판정)', () => {
    expect(okOf({ ...base, level: null }, 'level')).toBeNull();
    const r = evaluateAddChecklist({ ...base, level: 1 });
    expect(r.items[0]).toMatchObject({ ok: false, auto: false });
    expect(r.allOk).toBe(false);
  });

  it('CR 0.3 → cr_zero 아니오, 손절 없음도 아니오', () => {
    expect(okOf({ ...base, stopPx: 98.5 }, 'cr_zero')).toBe(false);
    expect(okOf({ ...base, stopPx: null }, 'cr_zero')).toBe(false);
  });

  it('숏 — 손절이 공통 손절 이하면 예', () => {
    const short: AddCheckInput = { ...base, side: 'short', stopPx: 99.9, addPrice: 90 };
    expect(okOf(short, 'cr_zero')).toBe(true);
    expect(okOf({ ...short, stopPx: 100 }, 'cr_zero')).toBe(false);
  });

  it('구간 — 통과 아님·구간 밖 아니오, 표 없음 확인 불가', () => {
    expect(okOf({ ...base, zoneR: 1 }, 'zone_passed')).toBe(false);
    expect(okOf({ ...base, zoneR: null }, 'zone_passed')).toBe(false);
    expect(okOf({ ...base, merRows: null }, 'zone_passed')).toBeNull();
  });

  it('표본 23 → zone_sample 아니오', () => {
    const r = evaluateAddChecklist({ ...base, zoneR: 2.5, addPrice: 112.5 });
    const s = r.items.find((i) => i.key === 'zone_sample');
    expect(s?.ok).toBe(false);
    expect(s?.detail).toContain('23/50');
  });

  it('임계점 — null 확인 불가·allOk false, 경고 아니오, 미측정+켜짐 0 확인 불가', () => {
    const r = evaluateAddChecklist({ ...base, threshold: null });
    expect(r.items.find((i) => i.key === 'threshold')?.ok).toBeNull();
    expect(r.allOk).toBe(false);

    expect(okOf({ ...base, threshold: report({ warnings: { long: ['과열'], short: [] } }) }, 'threshold')).toBe(false);
    // 숏 쪽 경고는 롱 추가와 무관
    expect(okOf({ ...base, threshold: report({ warnings: { long: [], short: ['펀딩'] } }) }, 'threshold')).toBe(true);

    const partial = evaluateAddChecklist({
      ...base,
      threshold: report({ on: { long: 0, short: 0 }, measuredCount: 3, measured: false }),
    }).items.find((i) => i.key === 'threshold');
    expect(partial?.ok).toBeNull();
    expect(partial?.detail).toContain('3/4 측정');

    expect(okOf({ ...base, threshold: report({ on: { long: 0, short: 2 } }) }, 'threshold')).toBe(false);
    const partialOn = evaluateAddChecklist({ ...base, threshold: report({ measuredCount: 3, measured: false }) });
    expect(partialOn.items.find((i) => i.key === 'threshold')).toMatchObject({ ok: true, detail: '켜짐 1 · 3/4 측정' });
  });

  it('E 2.2 → risk_cap 아니오', () => {
    const r = evaluateAddChecklist({ ...base, qty: 3.4, avgPx: 100 });
    expect(r.preview?.after.e).toBeCloseTo(2.205, 2);
    expect(r.items.find((i) => i.key === 'risk_cap')?.ok).toBe(false);
  });

  it('추가분 위험 1R 초과(수동 수량) → risk_cap 아니오', () => {
    expect(okOf({ ...base, addQty: 1.5 }, 'risk_cap')).toBe(false);
  });

  it('비용 0.25R → cost_cap 아니오', () => {
    const r = evaluateAddChecklist({ ...base, addPrice: 100.5 });
    expect(r.sizing?.costR).toBeCloseTo(0.25, 2);
    expect(r.items.find((i) => i.key === 'cost_cap')?.ok).toBe(false);
  });

  it('가속 신호가 있으면 no_accel 아니오', () => {
    expect(okOf({ ...base, accel: [{ key: 'cooldown', detail: '청산 뒤 30분' }] }, 'no_accel')).toBe(false);
  });
});

describe('accelSignals', () => {
  // KST 11-07 14:00
  const nowMs = Date.parse('2026-11-07T05:00:00Z');
  const min = 60_000;
  const closed = (exitMs: number, net: number): LimitTrade => ({
    id: String(exitMs),
    seq: 1,
    symbol: 'BTC',
    exitMs,
    net,
    rBase: 10,
  });
  const clean: AccelInput = {
    nowMs,
    lastExitMs: nowMs - 120 * min,
    // 하나는 KST 전날(11-06 23:00) — 오늘에 안 센다
    entryTimesMs: [Date.parse('2026-11-06T14:00:00Z'), nowMs - 300 * min, nowMs - 200 * min],
    closed: [closed(nowMs - 120 * min, 5)],
    cashFlows: [{ kind: 'transfer', at: new Date(nowMs - 60 * min).toISOString(), amount: 50 }],
  };

  it('모두 깨끗 → 없음', () => {
    expect(accelSignals(clean)).toEqual([]);
  });

  it('청산 30분 뒤 → cooldown', () => {
    const s = accelSignals({ ...clean, lastExitMs: nowMs - 30 * min });
    expect(s.map((x) => x.key)).toEqual(['cooldown']);
  });

  it('오늘 진입 3건 → 이번이 4번째', () => {
    const s = accelSignals({ ...clean, entryTimesMs: [...clean.entryTimesMs, nowMs - 100 * min] });
    expect(s).toEqual([{ key: 'fourth_entry', detail: '오늘 4번째 진입' }]);
  });

  it('손실일 입금 → loss_day_deposit, 출금은 아님', () => {
    const lossDay = { ...clean, closed: [closed(nowMs - 120 * min, -8)] };
    expect(accelSignals(lossDay).map((x) => x.key)).toEqual(['loss_day_deposit']);
    const withdraw = {
      ...lossDay,
      cashFlows: [{ kind: 'withdrawal' as const, at: new Date(nowMs - 60 * min).toISOString(), amount: -50 }],
    };
    expect(accelSignals(withdraw)).toEqual([]);
  });

  it('체크리스트 no_accel 에 그대로 들어간다', () => {
    const accel = accelSignals({ ...clean, lastExitMs: nowMs - 30 * min });
    expect(okOf({ ...base, accel }, 'no_accel')).toBe(false);
    expect(okOf({ ...base, accel: accelSignals(clean) }, 'no_accel')).toBe(true);
  });
});
