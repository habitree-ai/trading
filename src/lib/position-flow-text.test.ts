import { describe, expect, it } from 'vitest';

import { stageChange, stopOutcome } from '@/lib/position-flow-text';
import type { Stage } from '@/lib/position-r';

const base: Stage = {
  kind: 'entry',
  atMs: 0,
  price: 0.2937,
  qty: 2830,
  avgPx: 0.2937,
  stopPx: 0.2914,
  r: 0.65,
  e: 0.65,
  cr: 0.65,
  lockedR: 0,
  unrealizedR: 0,
  realizedR: 0,
  riskUp: false,
};
const st = (over: Partial<Stage>): Stage => ({ ...base, ...over });

describe('단계 머리 변화 문구 (REQ-0109)', () => {
  it('첫 단계는 진입 수량', () => {
    expect(stageChange(null, base)).toBe('2,830개 진입');
  });

  it('추가는 늘어난 수량만', () => {
    expect(stageChange(base, st({ kind: 'add', qty: 4500 }))).toBe('+1,670개');
  });

  it('손절 이동은 이전 → 이후 가격', () => {
    expect(stageChange(base, st({ kind: 'stop_move', stopPx: 0.2948 }))).toBe('손절 0.29140→0.29480');
  });

  it('수량과 손절이 함께 바뀌면 둘 다', () => {
    expect(stageChange(base, st({ kind: 'partial', qty: 1000, stopPx: 0.295 }))).toBe('−1,830개 · 손절 0.29140→0.29500');
  });

  it('손절을 새로 걸거나 풀면 그대로 적는다', () => {
    expect(stageChange(st({ stopPx: null }), base)).toBe('손절 0.29140');
    expect(stageChange(base, st({ kind: 'stop_move', stopPx: null }))).toBe('손절 해제');
  });

  it('「현재」 열과 바뀐 것 없는 단계는 문구 없음', () => {
    expect(stageChange(base, st({ kind: 'now' }))).toBeNull();
    expect(stageChange(base, st({ kind: 'resync' }))).toBeNull();
  });
});

describe('지금 손절되면', () => {
  it('CR 이 남아 있으면 잃는 R', () => {
    expect(stopOutcome(st({ cr: 0.05 }))).toEqual({ text: '손절되면 −0.05R', tone: 'bad' });
  });

  it('CR 0 이고 잠긴 R 이 있으면 확보한 R', () => {
    expect(stopOutcome(st({ cr: 0, lockedR: 0.26 }))).toEqual({ text: '손절돼도 +0.26R 확보', tone: 'good' });
  });

  it('둘 다 0 이면 본전, 둘 다 모르면 null', () => {
    expect(stopOutcome(st({ cr: 0, lockedR: 0 }))?.tone).toBe('flat');
    expect(stopOutcome(st({ cr: null, lockedR: null }))).toBeNull();
  });
});
