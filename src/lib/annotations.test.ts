import { describe, expect, it } from 'vitest';

import {
  anchorTime,
  normalizePoints,
  parsePoints,
  pointCount,
  toAnnotation,
  type AnnotationRow,
} from '@/lib/annotations';

function row(partial: Partial<AnnotationRow> = {}): AnnotationRow {
  return {
    id: 'a1',
    trade_id: 't1',
    user_id: 'u1',
    kind: 'hline',
    points: [{ t: 1_770_000_000, p: 64_200 }],
    text: '전고점',
    color: 'accent',
    created_at: '2026-08-11T00:00:00Z',
    updated_at: '2026-08-11T00:00:00Z',
    ...partial,
  };
}

describe('pointCount', () => {
  it('텍스트·수평선은 1점, 추세선·박스는 2점, 손익 툴은 3점', () => {
    expect(pointCount('text')).toBe(1);
    expect(pointCount('hline')).toBe(1);
    expect(pointCount('line')).toBe(2);
    expect(pointCount('rect')).toBe(2);
    expect(pointCount('long')).toBe(3);
    expect(pointCount('short')).toBe(3);
  });
});

describe('parsePoints', () => {
  it('점의 수가 종류와 맞아야 읽는다', () => {
    expect(parsePoints([{ t: 1, p: 2 }], 'hline')).toEqual([{ t: 1, p: 2 }]);
    expect(parsePoints([{ t: 1, p: 2 }], 'rect')).toBeNull();
  });

  it('숫자가 아니거나 유한하지 않으면 버린다', () => {
    expect(parsePoints([{ t: '1', p: 2 }], 'hline')).toBeNull();
    expect(parsePoints([{ t: Number.NaN, p: 2 }], 'hline')).toBeNull();
    expect(parsePoints([null], 'hline')).toBeNull();
    expect(parsePoints('nope', 'hline')).toBeNull();
  });
});

describe('toAnnotation', () => {
  it('정상 행은 그대로 옮긴다', () => {
    const a = toAnnotation(row());
    expect(a?.kind).toBe('hline');
    expect(a?.points).toEqual([{ t: 1_770_000_000, p: 64_200 }]);
  });

  it('모르는 종류나 깨진 좌표는 버린다 — 그 메모 하나만', () => {
    expect(toAnnotation(row({ kind: 'circle' }))).toBeNull();
    expect(toAnnotation(row({ points: [] }))).toBeNull();
  });

  it('모르는 색은 기본색으로 떨어뜨린다 — 색 때문에 메모를 잃지 않는다', () => {
    expect(toAnnotation(row({ color: 'hotpink' }))?.color).toBe('accent');
  });
});

describe('normalizePoints', () => {
  it('끄는 방향과 무관하게 이른 시각을 앞에 둔다', () => {
    expect(normalizePoints('line', [{ t: 20, p: 1 }, { t: 10, p: 2 }])).toEqual([
      { t: 10, p: 2 },
      { t: 20, p: 1 },
    ]);
  });

  it('손익 툴은 순서를 건드리지 않는다 — 세우면 진입·손절·목표가 뒤바뀐다', () => {
    const placed = [
      { t: 30, p: 100 },
      { t: 10, p: 99 },
      { t: 20, p: 102 },
    ];
    expect(normalizePoints('long', placed)).toEqual(placed);
  });
});

describe('anchorTime', () => {
  it('첫 점의 시각을 쓴다', () => {
    expect(anchorTime(toAnnotation(row())!)).toBe(1_770_000_000);
  });
});
