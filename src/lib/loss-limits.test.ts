import { describe, expect, it } from 'vitest';

import {
  breachHistory,
  daySums,
  kstDayKey,
  limitStatus,
  openRiskOf,
  periodBaseEquity,
  periodEnd,
  periodStart,
  periodStatus,
  streakStatus,
  type LimitTrade,
} from '@/lib/loss-limits';

/** KST 시각 문자열 → ms. */
const k = (s: string) => Date.parse(`${s}+09:00`);
let seq = 0;
const tr = (at: string, net: number, rBase: number | null = 10): LimitTrade => ({
  id: `t${++seq}`,
  seq,
  symbol: 'X',
  exitMs: k(at),
  net,
  rBase,
});

describe('기간 경계 — KST 달력', () => {
  it('일요일 23:59 와 월요일 00:00 은 다른 주', () => {
    expect(periodStart('week', k('2026-11-01T23:59'))).toBe(k('2026-10-26T00:00'));
    expect(periodStart('week', k('2026-11-02T00:00'))).toBe(k('2026-11-02T00:00'));
    expect(periodEnd('week', k('2026-11-02T00:00'))).toBe(k('2026-11-09T00:00'));
  });
  it('UTC 로는 전날이어도 KST 날짜를 따른다', () => {
    // 2026-11-02 15:30 UTC = 11-03 00:30 KST
    const ms = Date.parse('2026-11-02T15:30:00Z');
    expect(kstDayKey(ms)).toBe('2026-11-03');
    expect(periodStart('day', ms)).toBe(k('2026-11-03T00:00'));
  });
  it('월·분기·연', () => {
    const ms = k('2026-11-15T12:00');
    expect(periodStart('month', ms)).toBe(k('2026-11-01T00:00'));
    expect(periodEnd('month', ms)).toBe(k('2026-12-01T00:00'));
    expect(periodStart('quarter', ms)).toBe(k('2026-10-01T00:00'));
    expect(periodEnd('quarter', ms)).toBe(k('2027-01-01T00:00'));
    expect(periodStart('year', ms)).toBe(k('2026-01-01T00:00'));
    expect(periodEnd('year', k('2026-12-31T23:59'))).toBe(k('2027-01-01T00:00'));
  });
});

describe('기준 자금 — 최신 잔액에서 기간 실현 손익을 되돌린다', () => {
  const trades = [tr('2026-11-02T10:00', -10), tr('2026-11-02T20:00', -5), tr('2026-11-03T01:00', -3)];
  it('스냅샷이 기간 시작보다 늦으면 그 사이 청산분을 뺀다', () => {
    const cash = { atMs: k('2026-11-02T21:00'), amount: 85 };
    expect(periodBaseEquity(k('2026-11-02T00:00'), cash, trades, 0)).toBe(100);
  });
  it('스냅샷이 기간 시작보다 이르면 그 사이 청산분을 더한다', () => {
    const cash = { atMs: k('2026-11-02T21:00'), amount: 85 };
    // 11-03 시작 — 스냅샷(11-02 21:00) 뒤 시작 전 청산은 없다. 11-03 01:00 은 기간 안이라 손대지 않는다
    expect(periodBaseEquity(k('2026-11-03T00:00'), cash, trades, 0)).toBe(85);
    const early = { atMs: k('2026-11-02T09:00'), amount: 100 };
    expect(periodBaseEquity(k('2026-11-03T00:00'), early, trades, 0)).toBe(85);
  });
  it('스냅샷이 없으면 북 초기자금', () => {
    expect(periodBaseEquity(0, null, trades, 42)).toBe(42);
  });
});

describe('기간 상태 — R 한도와 % 상한 중 먼저 닿는 쪽', () => {
  it('기준 R 이 자금 10% 면 % 상한이 먼저 걸린다 (지금 계좌)', () => {
    const now = k('2026-11-03T12:00');
    const cash = { atMs: now, amount: 94 };
    const s = periodStatus('day', now, [], 10, cash, 0, 0);
    expect(s.limitRUsd).toBe(20);
    expect(s.limitPctUsd).toBeCloseTo(5.64, 10);
    expect(s.binding).toBe('pct');
    expect(s.stopUsd).toBeCloseTo(5.64, 10);
  });
  it('기준 R 이 자금 2% 면 R 한도가 먼저 걸린다', () => {
    const now = k('2026-11-03T12:00');
    const s = periodStatus('day', now, [], 2, { atMs: now, amount: 100 }, 0, 0);
    expect(s.binding).toBe('r');
    expect(s.stopUsd).toBe(4);
  });
  it('손절 한 번(−1R = −10)이면 % 상한(−5.64)을 넘어 도달', () => {
    const now = k('2026-11-03T12:00');
    const trades = [tr('2026-11-03T10:00', -10)];
    const s = periodStatus('day', now, trades, 10, { atMs: now, amount: 84 }, 0, 0);
    expect(s.baseEquity).toBe(94);
    expect(s.pnlR).toBe(-1);
    expect(s.breached).toBe(true);
    expect(s.remainingUsd).toBe(0);
  });
  it('R 한도로 도달 — % 상한은 넉넉', () => {
    const now = k('2026-11-03T12:00');
    const trades = [tr('2026-11-03T10:00', -2, 2), tr('2026-11-03T11:00', -2, 2)];
    const s = periodStatus('day', now, trades, 2, { atMs: now, amount: 1000 }, 0, 0);
    expect(s.pnlR).toBe(-2);
    expect(s.breached).toBe(true);
  });
  it('열린 위험이 남은 금액보다 크면 경고, 이미 도달했으면 경고하지 않는다', () => {
    const now = k('2026-11-03T12:00');
    const s = periodStatus('week', now, [], 10, { atMs: now, amount: 100 }, 0, 15);
    expect(s.remainingUsd).toBe(12);
    expect(s.openRiskExceeds).toBe(true);
    const ok = periodStatus('week', now, [], 10, { atMs: now, amount: 100 }, 0, 9);
    expect(ok.openRiskExceeds).toBe(false);
  });
  it('기준 R 없는 과거 거래는 현재 기준 R 로 환산하고 추정으로 센다', () => {
    const now = k('2026-11-03T12:00');
    const s = periodStatus('day', now, [tr('2026-11-03T10:00', -5, null)], 10, null, 1000, 0);
    expect(s.pnlR).toBe(-0.5);
    expect(s.estimated).toBe(1);
  });
});

describe('연속 손실', () => {
  it('같은 날 2연패 → 당일 정지, 그 뒤 이겨도 유지', () => {
    const now = k('2026-11-03T23:00');
    const s = streakStatus(
      [tr('2026-11-03T09:00', -1), tr('2026-11-03T10:00', -1), tr('2026-11-03T11:00', 5)],
      now,
      10,
    );
    expect(s.dayStopped).toBe(true);
    expect(s.dayStopAtMs).toBe(k('2026-11-03T10:00'));
    expect(s.lossStreak).toBe(0);
  });
  it('어제 패 + 오늘 패 1번은 당일 정지가 아니다', () => {
    const s = streakStatus([tr('2026-11-02T22:00', -1), tr('2026-11-03T09:00', -1)], k('2026-11-03T12:00'), 10);
    expect(s.dayStopped).toBe(false);
    expect(s.lossStreak).toBe(2);
  });
  it('날을 넘긴 4연패 → 축소, 이익 1건이면 해제, 본전은 끊지 않는다', () => {
    const four = [
      tr('2026-10-01T10:00', -1),
      tr('2026-10-02T10:00', -1),
      tr('2026-10-03T10:00', 0),
      tr('2026-10-04T10:00', -1),
      tr('2026-10-05T10:00', -1),
    ];
    expect(streakStatus(four, k('2026-10-06T10:00'), 10).shrink).toBe(true);
    const won = [...four, tr('2026-10-06T10:00', 1)];
    expect(streakStatus(won, k('2026-10-07T10:00'), 10).shrink).toBe(false);
  });
  it('손실일 3일 연속 → 마지막 손실일 다음 날부터 7일 휴식, 거래 없는 날은 끊지 않는다', () => {
    const t = [tr('2026-10-01T10:00', -1), tr('2026-10-02T10:00', -1), tr('2026-10-04T10:00', -1)];
    const s = streakStatus(t, k('2026-10-05T10:00'), 10);
    expect(s.lossDayStreak).toBe(3);
    expect(s.coolUntilMs).toBe(k('2026-10-12T00:00'));
    expect(s.cooling).toBe(true);
    expect(streakStatus(t, k('2026-10-12T00:00'), 10).cooling).toBe(false);
  });
  it('냉각 중 이익일이 나도 냉각은 풀리지 않는다', () => {
    const t = [
      tr('2026-10-01T10:00', -1),
      tr('2026-10-02T10:00', -1),
      tr('2026-10-03T10:00', -1),
      tr('2026-10-05T10:00', 3),
    ];
    const s = streakStatus(t, k('2026-10-06T10:00'), 10);
    expect(s.lossDayStreak).toBe(0);
    expect(s.cooling).toBe(true);
  });
});

/** 실제 10/21~11/02 청산(R 배수 × 10 USDT) — 11-02 기획 때 SQL 로 뽑은 값. */
const REAL: [string, number][] = [
  ['2026-10-21T01:33', -0.647],
  ['2026-10-21T02:23', 2.341],
  ['2026-10-21T07:23', -0.412],
  ['2026-10-22T05:35', 0.061],
  ['2026-10-22T07:18', -1.069],
  ['2026-10-23T09:49', 0.743],
  ['2026-10-23T18:30', 0.313],
  ['2026-10-23T18:57', -0.134],
  ['2026-10-23T20:00', -1.226],
  ['2026-10-23T23:16', -1.56],
  ['2026-10-23T23:31', -1.026],
  ['2026-10-24T04:19', -1.07],
  ['2026-10-24T15:03', -0.038],
  ['2026-10-24T17:52', 1.614],
  ['2026-10-24T18:03', -1.407],
  ['2026-10-24T21:17', -1.108],
  ['2026-10-24T23:08', -1.086],
  ['2026-10-25T17:28', -1.214],
  ['2026-10-25T20:48', -1.182],
  ['2026-10-25T21:25', -1.715],
  ['2026-10-26T21:39', 1.955],
  ['2026-10-26T22:38', -1.151],
  ['2026-10-26T22:57', -0.87],
  ['2026-10-26T23:58', -1.459],
  ['2026-10-27T00:14', -1.031],
  ['2026-10-27T00:21', -1.158],
  ['2026-10-27T00:36', -1.141],
  ['2026-10-27T19:21', 1.234],
  ['2026-10-27T20:59', -1.568],
  ['2026-10-27T21:20', -1.177],
  ['2026-10-27T22:33', -1.13],
  ['2026-10-27T23:01', -1.135],
  ['2026-10-27T23:03', -1.169],
  ['2026-10-27T23:13', -1.088],
  ['2026-10-28T21:51', -1.148],
  ['2026-10-30T05:01', 0.495],
  ['2026-10-30T10:31', -0.765],
  ['2026-10-30T18:22', -0.06],
  ['2026-10-30T22:30', -1.294],
  ['2026-10-31T20:05', -0.653],
  ['2026-11-01T05:13', 0.182],
  ['2026-11-01T14:26', -1.054],
  ['2026-11-02T01:10', -1.189],
  ['2026-11-02T15:26', -1.135],
  ['2026-11-02T19:00', -1.111],
  ['2026-11-02T21:56', -1.182],
];
const real = REAL.map(([at, r]) => tr(at, r * 10));

describe('실데이터 — 11-03 05:04 KST 기준', () => {
  const now = k('2026-11-03T05:04');

  it('손실일 11일 연속(10/22~11/02), 5연패, 냉각은 11-10 00:00 까지', () => {
    const s = streakStatus(real, now, 10);
    expect(s.lossDayStreak).toBe(11);
    expect(s.lastLossDay).toBe('2026-11-02');
    expect(s.lossStreak).toBe(5);
    expect(s.shrink).toBe(true);
    expect(s.dayStopped).toBe(false); // 11-03 은 아직 거래 없음
    expect(s.coolUntilMs).toBe(k('2026-11-10T00:00'));
    expect(s.cooling).toBe(true);
  });

  it('예전 북까지 넣으면: 냉각이 먼저, 재개는 분기·연 한도 때문에 2027-01-01 — 화면이 활성 북만 넣는 이유', () => {
    const st = limitStatus({
      trades: real,
      nowMs: now,
      rBaseNow: 10,
      cash: { atMs: k('2026-11-02T22:00'), amount: 94.78 },
      fallbackCapital: 0,
      openRisks: [{ symbol: 'ONDO', riskUsd: 9.58 }],
    });
    expect(st.state).toBe('cool');
    expect(st.resumeMs).toBe(k('2027-01-01T00:00'));
    // 11-02 는 월요일 — 이번 주에 4건 −4.617R 이 들어 있다
    expect(st.periods.find((p) => p.period === 'week')?.breached).toBe(true);
    const month = st.periods.find((p) => p.period === 'month');
    // 11월: 11-01 2건 + 11-02 4건 = (0.182 − 1.054 − 1.189 − 1.135 − 1.111 − 1.182) R
    expect(month?.pnlR).toBeCloseTo(-5.489, 3);
    expect(month?.breached).toBe(true); // −54.9 USDT ≤ −20% × (94.78 + 54.89)
    const day = st.periods.find((p) => p.period === 'day');
    expect(day?.trades).toBe(0);
    expect(day?.openRiskExceeds).toBe(true); // 손절 9.58 > 일 상한 남은 금액
  });

  it('활성 북(11-02 시작)만: #1 ONDO −11.91 하나 → 매매 가능, 단 보유 손절 시 주·일 한도 초과 경고', () => {
    const st = limitStatus({
      trades: [tr('2026-11-02T21:56', -11.907279)],
      nowMs: now,
      rBaseNow: 10,
      cash: { atMs: k('2026-11-02T22:00'), amount: 94.78 },
      fallbackCapital: 3.85,
      openRisks: [{ symbol: 'ONDO', riskUsd: 9.58 }],
    });
    expect(st.state).toBe('ok');
    expect(st.resumeMs).toBeNull();
    const week = st.periods.find((p) => p.period === 'week');
    expect(week?.baseEquity).toBeCloseTo(106.687, 3);
    expect(week?.breached).toBe(false); // −11.91 > −12% × 106.69 = −12.80
    expect(week?.remainingUsd).toBeCloseTo(0.895, 3);
    expect(week?.openRiskExceeds).toBe(true);
    // 월: 남은 = 20% × 106.69 − 11.91 = 9.43 < 9.58 — 보유가 손절되면 이달도 끝난다
    const month = st.periods.find((p) => p.period === 'month');
    expect(month?.remainingUsd).toBeCloseTo(9.43, 3);
    expect(month?.openRiskExceeds).toBe(true);
  });

  it('11-02 일별 합계 −4.617R', () => {
    const d = daySums(real, 10).find((x) => x.day === '2026-11-02');
    expect(d?.r).toBeCloseTo(-4.617, 3);
    expect(d?.n).toBe(4);
  });

  it('한도 도달 이력 — 10/27 은 일 −2R 을 넘긴 뒤에도 더 거래했다', () => {
    const h = breachHistory(real, 10);
    const d27 = h.find((b) => b.kind === 'day' && b.period === '2026-10-27');
    expect(d27).toBeDefined();
    expect(d27?.after).toBe(8);
    expect(d27?.totalR).toBeCloseTo(-9.363, 3);
    const two = h.find((b) => b.kind === 'two_losses' && b.period === '2026-11-02');
    expect(two?.atMs).toBe(k('2026-11-02T15:26'));
    expect(two?.after).toBe(2);
    expect(h[0].atMs).toBeGreaterThanOrEqual(h[h.length - 1].atMs);
  });
});

describe('openRiskOf', () => {
  it('숏 ONDO — 진입 0.3906, 손절 0.399, 수량 1,140 → 9.58', () => {
    expect(openRiskOf('short', 0.3906, 1140, 0.399)).toBeCloseTo(9.576, 3);
  });
  it('손절이 이익 쪽이면 0, 없으면 null', () => {
    expect(openRiskOf('long', 100, 1, 101)).toBe(0);
    expect(openRiskOf('long', 100, 1, null)).toBeNull();
  });
});
