import { describe, expect, it } from 'vitest';

import { buildFlow, mergeFills, sameSnapshot, type FlowFill, type FlowSnapshot, type Stage } from '@/lib/position-r';

/** 한 시간 — 60초 안의 같은 역할 체결은 묶이므로 단계 사이를 넉넉히 둔다. */
const H = 3_600_000;

const pick = (s: Stage) => ({
  kind: s.kind,
  e: s.e,
  cr: s.cr,
  lockedR: s.lockedR,
  unrealizedR: s.unrealizedR,
  realizedR: s.realizedR,
});
const close = (a: number | null, b: number) => {
  expect(a).not.toBeNull();
  expect(a as number).toBeCloseTo(b, 9);
};

describe('책 표 3-6 — 1R 100만 원, 10만 원에 100주(손절 9만)', () => {
  // 손절은 포지션당 하나(OKX)라 3단계 CR 1 은 손절 10.5만(평단 11만 × 200주 기준), 4단계 CR 0 은 손절 13만으로 둔다.
  const fills: FlowFill[] = [
    { atMs: H * 1, role: 'open', price: 100_000, qty: 100 },
    { atMs: H * 3, role: 'open', price: 120_000, qty: 100 },
    { atMs: H * 4, role: 'close', price: 140_000, qty: 100 },
    { atMs: H * 5, role: 'close', price: 130_000, qty: 100 },
  ];
  const snapshots: FlowSnapshot[] = [
    { atMs: H * 2, qty: 100, avgPx: 100_000, markPx: 110_000, stopPx: 100_000 },
    { atMs: H * 3, qty: 200, avgPx: 110_000, markPx: 120_000, stopPx: 105_000 },
    { atMs: H * 4, qty: 100, avgPx: 110_000, markPx: 140_000, stopPx: 130_000 },
  ];
  const flow = buildFlow({ side: 'long', rBase: 1_000_000, stop0: 90_000, fills, snapshots });
  const byKind = flow.stages.map((s) => s.kind);

  it('단계 순서 — 체결이 먼저, 같은 순간의 손절 이동이 뒤', () => {
    expect(byKind).toEqual(['entry', 'stop_move', 'add', 'stop_move', 'partial', 'stop_move', 'close']);
  });

  it('책의 5단계 열과 같다 (E 1·1·2·1·0 / CR 1·0·1·0·0 / 미실현 0·1·2·3·0 / 누적 확정 0·0·0·3·5)', () => {
    const book = [0, 1, 3, 5, 6].map((i) => pick(flow.stages[i]));
    const want = [
      [1, 1, 0, 0],
      [1, 0, 1, 0],
      [2, 1, 2, 0],
      [1, 0, 3, 3],
      [0, 0, 0, 5],
    ];
    book.forEach((s, i) => {
      close(s.e, want[i][0]);
      close(s.cr, want[i][1]);
      close(s.unrealizedR, want[i][2]);
      close(s.realizedR, want[i][3]);
    });
  });

  it('R 은 처음 정한 1R 로 고정 — 모든 단계 1', () => {
    for (const s of flow.stages) close(s.r, 1);
  });

  it('손절을 못 올린 채 추가하면 CR 2 — 위험 증가 표시', () => {
    const add = flow.stages[2];
    close(add.cr, 2);
    expect(add.riskUp).toBe(true);
    expect(flow.maxCr).toBeCloseTo(2, 9);
    expect(flow.maxE).toBeCloseTo(2, 9);
  });

  it('4단계: 손절 13만이 평단 11만 위 → CR 0, 잠긴 R 2', () => {
    close(flow.stages[5].lockedR, 2);
  });
});

describe('명세 예시 ③ — 기준 R 10, BTC 롱 100,000, 손절 99,000 (1E = 0.01)', () => {
  const flow = buildFlow({
    side: 'long',
    rBase: 10,
    stop0: 99_000,
    fills: [
      { atMs: H * 1, role: 'open', price: 100_000, qty: 0.01 },
      { atMs: H * 4, role: 'open', price: 102_000, qty: 0.01 },
      { atMs: H * 6, role: 'close', price: 105_000, qty: 0.01 },
      { atMs: H * 7, role: 'close', price: 103_000, qty: 0.01 },
    ],
    snapshots: [
      { atMs: H * 2, qty: 0.01, avgPx: 100_000, markPx: 101_000, stopPx: 99_500 },
      { atMs: H * 3, qty: 0.01, avgPx: 100_000, markPx: 101_500, stopPx: 100_000 },
      // 추가 직전에 손절을 101,000(추가 후 평단)으로 — 추가 순간 CR 이 0 으로 유지된다
      { atMs: H * 4 - 60_000, qty: 0.01, avgPx: 100_000, markPx: 102_000, stopPx: 101_000 },
      { atMs: H * 5, qty: 0.02, avgPx: 101_000, markPx: 104_000, stopPx: 103_000 },
    ],
  });

  it('1E = 0.01', () => close(flow.oneE, 0.01));

  it('표와 같다 — 진입 CR1 · 손절 올림 0.5/+1.0 · 본전 0/+1.5 · 손절 올림 잠긴 4/E2/+6 · 절반 익절 잠긴 2/+4/확정 4 · 청산 확정 6', () => {
    const s = flow.stages;
    expect(s.map((x) => x.kind)).toEqual([
      'entry',
      'stop_move',
      'stop_move',
      'stop_move',
      'add',
      'stop_move',
      'partial',
      'close',
    ]);
    close(s[0].cr, 1);
    close(s[1].cr, 0.5);
    close(s[1].unrealizedR, 1);
    close(s[2].cr, 0);
    close(s[2].unrealizedR, 1.5);
    close(s[4].e, 2); // 추가 뒤 손절을 평단 101,000 으로
    close(s[4].cr, 0);
    close(s[5].lockedR, 4);
    close(s[5].unrealizedR, 6);
    close(s[6].e, 1);
    close(s[6].lockedR, 2);
    close(s[6].unrealizedR, 4);
    close(s[6].realizedR, 4);
    close(s[7].realizedR, 6);
    close(s[7].e, 0);
  });

  it('최대 CR 1, 최대 E 2, 가격 기준 확정 +60 USDT', () => {
    expect(flow.maxCr).toBeCloseTo(1, 9);
    expect(flow.maxE).toBeCloseTo(2, 9);
    expect(flow.realizedUsd).toBeCloseTo(60, 9);
  });
});

describe('숏·현재 열·예외', () => {
  it('지금 보유 중인 #2 ONDO 숏 — 0.3906 진입, 손절 0.399, 1,140개, 현재가 0.388', () => {
    const flow = buildFlow({
      side: 'short',
      rBase: 10,
      stop0: 0.399,
      fills: [{ atMs: H * 1, role: 'open', price: 0.3906, qty: 1140 }],
      snapshots: [],
      now: { atMs: H * 9, price: 0.388, qty: 1140, avgPx: 0.3906, stopPx: 0.399 },
    });
    expect(flow.stages.map((s) => s.kind)).toEqual(['entry', 'now']);
    const now = flow.stages[1];
    close(now.cr, 0.9576);
    close(now.e, 0.9576);
    close(now.r, 0.9576);
    close(now.unrealizedR, ((0.3906 - 0.388) * 1140) / 10);
  });

  it('손절을 넓히면 「손절 확대」 + 위험 증가', () => {
    const flow = buildFlow({
      side: 'long',
      rBase: 10,
      stop0: 99,
      fills: [{ atMs: H * 1, role: 'open', price: 100, qty: 10 }],
      snapshots: [{ atMs: H * 2, qty: 10, avgPx: 100, markPx: 99.5, stopPx: 98 }],
    });
    expect(flow.stages[1].kind).toBe('stop_widen');
    close(flow.stages[1].cr, 2);
    expect(flow.stages[1].riskUp).toBe(true);
  });

  it('최초 손절이 없으면 R·E 를 잴 수 없다, 손절이 생기면 CR 은 잰다', () => {
    const flow = buildFlow({
      side: 'long',
      rBase: 10,
      stop0: null,
      fills: [{ atMs: H * 1, role: 'open', price: 100, qty: 10 }],
      snapshots: [{ atMs: H * 2, qty: 10, avgPx: 100, markPx: 101, stopPx: 99 }],
    });
    expect(flow.stages[0].r).toBeNull();
    expect(flow.stages[0].e).toBeNull();
    expect(flow.stages[0].cr).toBeNull();
    close(flow.stages[1].cr, 1);
  });

  it('변화 없는 스냅샷은 단계를 만들지 않는다', () => {
    const flow = buildFlow({
      side: 'long',
      rBase: 10,
      stop0: 99,
      fills: [{ atMs: H * 1, role: 'open', price: 100, qty: 10 }],
      snapshots: [
        { atMs: H * 2, qty: 10, avgPx: 100, markPx: 101, stopPx: 99 },
        { atMs: H * 3, qty: 10, avgPx: 100, markPx: 102, stopPx: 99 },
      ],
    });
    expect(flow.stages).toHaveLength(1);
  });

  it('체결 기록이 없으면 첫 스냅샷이 진입', () => {
    const flow = buildFlow({
      side: 'long',
      rBase: 10,
      stop0: 99,
      fills: [],
      snapshots: [{ atMs: H * 2, qty: 10, avgPx: 100, markPx: 100.5, stopPx: 99 }],
    });
    expect(flow.stages[0].kind).toBe('entry');
    close(flow.stages[0].e, 1);
  });

  it('잇단 같은 역할 체결은 한 단계로 묶는다', () => {
    const m = mergeFills([
      { atMs: 0, role: 'open', price: 100, qty: 1 },
      { atMs: 500, role: 'open', price: 102, qty: 1 },
      { atMs: 120_000, role: 'open', price: 104, qty: 1 },
    ]);
    expect(m).toHaveLength(2);
    expect(m[0].price).toBe(101);
    expect(m[0].qty).toBe(2);
  });
});

describe('sameSnapshot — 동기화가 새 줄을 남길지', () => {
  const base = { qty: 1140, avgPx: 0.3906, stopPx: 0.399 };
  it('처음이면 남긴다, 같으면 남기지 않는다', () => {
    expect(sameSnapshot(null, base)).toBe(false);
    expect(sameSnapshot(base, { ...base })).toBe(true);
  });
  it('손절·수량·평단 중 하나라도 바뀌면 남긴다, 손절이 사라져도 남긴다', () => {
    expect(sameSnapshot(base, { ...base, stopPx: 0.395 })).toBe(false);
    expect(sameSnapshot(base, { ...base, qty: 570 })).toBe(false);
    expect(sameSnapshot(base, { ...base, avgPx: 0.392 })).toBe(false);
    expect(sameSnapshot(base, { ...base, stopPx: null })).toBe(false);
  });
});
