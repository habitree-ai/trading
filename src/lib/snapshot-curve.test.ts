import { describe, expect, it } from 'vitest';

import type { EquityPoint } from '@/components/charts';
import { dailySnapshots, mergeSnapshotLine } from '@/lib/snapshot-curve';

const KST = (day: string, time: string) => `${day}T${time}:00+09:00`;
const ms = (iso: string) => Date.parse(iso);

function point(t: number, equity: number, extra: Partial<EquityPoint> = {}): EquityPoint {
  return {
    t,
    label: `p${t}`,
    equity,
    performance: equity,
    withdrawn: 0,
    withdrawnStep: 0,
    drawdown: 0,
    pnl: null,
    ...extra,
  };
}

describe('dailySnapshots — 한국 시간 하루에 마지막 건, 시작일 전은 제외', () => {
  it('하루 여러 건이면 마지막 건만 남고 시각순이다', () => {
    const daily = dailySnapshots(
      [
        { at: KST('2026-08-25', '10:00'), equity: 100 },
        { at: KST('2026-08-25', '23:00'), equity: 120 },
        { at: KST('2026-08-25', '15:00'), equity: 110 },
        { at: KST('2026-08-26', '09:00'), equity: 130 },
      ],
      '2026-08-25',
    );
    expect(daily.map((d) => [d.day, d.equity])).toEqual([
      ['2026-08-25', 120],
      ['2026-08-26', 130],
    ]);
  });

  it('시작일 전 스냅샷은 버린다 — UTC 로는 전날이어도 한국 시간으로 당일이면 남긴다', () => {
    const daily = dailySnapshots(
      [
        { at: '2026-08-24T12:00:00Z', equity: 90 }, // 08-24 21:00 KST → 제외
        { at: '2026-08-24T21:55:00Z', equity: 95 }, // 08-25 06:55 KST → 포함
      ],
      '2026-08-25',
    );
    expect(daily.map((d) => d.equity)).toEqual([95]);
  });
});

describe('mergeSnapshotLine — 곡선 행에 스냅샷 선을 얹는다', () => {
  const start = ms(KST('2026-08-25', '09:00'));
  const trade1 = ms(KST('2026-08-25', '18:00'));
  const trade2 = ms(KST('2026-08-27', '12:00'));
  const curve = [point(start, 100), point(trade1, 110, { pnl: 10 }), point(trade2, 105, { pnl: -5 })];

  it('스냅샷 행은 직전 장부값을 그대로 물고, 손익·출금은 비운다', () => {
    const rows = mergeSnapshotLine(curve, [
      { t: ms(KST('2026-08-25', '23:00')), day: '2026-08-25', equity: 111 },
    ]);
    const snap = rows.find((r) => r.snapshot === 111)!;
    expect(snap.equity).toBe(110);
    expect(snap.performance).toBe(110);
    expect(snap.pnl).toBeNull();
    expect(snap.withdrawnStep).toBe(0);
    expect(rows.map((r) => r.t)).toEqual([start, trade1, snap.t, trade2]);
  });

  it('이어진 날 사이의 거래 행에는 보간값을 넣어 선이 끊기지 않는다', () => {
    const a = { t: ms(KST('2026-08-26', '20:00')), day: '2026-08-26', equity: 100 };
    const b = { t: ms(KST('2026-08-27', '20:00')), day: '2026-08-27', equity: 200 };
    const rows = mergeSnapshotLine(curve, [a, b]);
    // trade2 (08-27 12:00) 는 a·b 사이 2/3 지점.
    const mid = rows.find((r) => r.t === trade2)!;
    expect(mid.snapshot).toBeCloseTo(100 + (200 - 100) * (2 / 3), 6);
  });

  it('달력상 이어지지 않는 날 사이는 빈 행으로 끊고, 그 사이 거래 행도 비운다', () => {
    const a = { t: ms(KST('2026-08-25', '23:00')), day: '2026-08-25', equity: 111 };
    const b = { t: ms(KST('2026-08-28', '23:00')), day: '2026-08-28', equity: 130 };
    const rows = mergeSnapshotLine(curve, [a, b]);
    const mid = rows.find((r) => r.t === trade2)!;
    expect(mid.snapshot).toBeNull();
    // b 바로 앞에 snapshot=null 인 끊는 행이 있다.
    const bi = rows.findIndex((r) => r.snapshot === 130);
    expect(rows[bi - 1].snapshot).toBeNull();
    expect(rows[bi - 1].t).toBe(b.t - 1);
  });

  it('곡선 첫 행보다 앞선 스냅샷은 버린다', () => {
    const rows = mergeSnapshotLine(curve, [
      { t: start - 3_600_000, day: '2026-08-25', equity: 99 },
    ]);
    expect(rows.every((r) => r.snapshot === null)).toBe(true);
    expect(rows).toHaveLength(curve.length);
  });

  it('거래 행과 같은 시각의 스냅샷은 그 행에 얹는다', () => {
    const rows = mergeSnapshotLine(curve, [{ t: trade1, day: '2026-08-25', equity: 109 }]);
    expect(rows).toHaveLength(curve.length);
    expect(rows[1].snapshot).toBe(109);
    expect(rows[1].pnl).toBe(10);
  });
});
