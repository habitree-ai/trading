import { describe, expect, it } from 'vitest';

import { describeUndo, pushChange, type AnnotationChange } from '@/lib/annotation-history';
import type { TradeAnnotation } from '@/lib/domain';

const line: AnnotationChange = { type: 'create', id: 'a1', kind: 'line' };

function change(i: number): AnnotationChange {
  return { type: 'create', id: `a${i}`, kind: 'line' };
}

describe('pushChange', () => {
  it('뒤에 쌓는다 — 마지막 것이 먼저 되돌아간다', () => {
    const stack = pushChange(pushChange([], change(1)), change(2));
    expect(stack.map((c) => (c.type === 'create' ? c.id : ''))).toEqual(['a1', 'a2']);
  });

  it('상한을 넘으면 오래된 것부터 버린다', () => {
    let stack: AnnotationChange[] = [];
    for (let i = 0; i < 5; i += 1) stack = pushChange(stack, change(i), 3);

    expect(stack).toHaveLength(3);
    expect(stack.map((c) => (c.type === 'create' ? c.id : ''))).toEqual(['a2', 'a3', 'a4']);
  });

  it('원래 배열을 건드리지 않는다', () => {
    const before: AnnotationChange[] = [line];
    pushChange(before, change(9));
    expect(before).toHaveLength(1);
  });
});

describe('describeUndo', () => {
  const annotation: TradeAnnotation = {
    id: 'a1',
    trade_id: 't1',
    user_id: 'u1',
    kind: 'rect',
    points: [
      { t: 1, p: 2 },
      { t: 3, p: 4 },
    ],
    text: null,
    color: 'accent',
    locked: false,
    created_at: '2026-08-12T00:00:00Z',
    updated_at: '2026-08-12T00:00:00Z',
  };

  it('무엇을 물렀는지 종류까지 말한다', () => {
    expect(describeUndo(line)).toBe('추세선 추가를 되돌렸습니다.');
    expect(describeUndo({ type: 'delete', before: annotation })).toBe('박스 삭제를 되돌렸습니다.');
    expect(describeUndo({ type: 'move', id: 'a1', kind: 'long', before: [] })).toBe(
      '롱 손익 이동을 되돌렸습니다.',
    );
  });

  /*
   * 조사가 갈리는 자리를 남기지 않았는지 — 받침 있는 이름과 없는 이름을 함께 본다.
   * `박스을`처럼 어긋난 문구가 끼어들면 여기서 걸린다.
   */
  it('받침에 상관없이 문구가 자연스럽다', () => {
    for (const kind of ['text', 'hline', 'rect', 'short'] as const) {
      expect(describeUndo({ type: 'lock', id: 'a1', kind, before: false })).toMatch(
        /잠금을 되돌렸습니다\.$/,
      );
    }
  });
});
