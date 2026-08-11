import { describe, expect, it } from 'vitest';

import {
  distanceToSegment,
  handleMovesTime,
  resolveHit,
  type HitShape,
} from '@/lib/hit-test';

const line: HitShape = {
  id: 'line',
  kind: 'line',
  xy: [
    { x: 100, y: 100 },
    { x: 200, y: 200 },
  ],
};

const rect: HitShape = {
  id: 'rect',
  kind: 'rect',
  xy: [
    { x: 300, y: 100 },
    { x: 400, y: 200 },
  ],
};

const hline: HitShape = { id: 'hline', kind: 'hline', xy: [{ x: 50, y: 400 }] };

const text: HitShape = { id: 'text', kind: 'text', xy: [{ x: 500, y: 300 }] };

/** 진입 200 / 손절 300 / 목표 100, 상자는 x 600~800 */
const position: HitShape = {
  id: 'pos',
  kind: 'long',
  xy: [
    { x: 600, y: 200 },
    { x: 700, y: 300 },
    { x: 800, y: 100 },
  ],
  span: { left: 600, right: 800 },
};

describe('distanceToSegment', () => {
  it('선분 위의 점은 0', () => {
    expect(distanceToSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, 5, 0)).toBe(0);
  });

  it('선분 밖으로 나가면 가까운 끝까지의 거리', () => {
    expect(distanceToSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, 13, 4)).toBeCloseTo(5, 10);
  });

  it('두 끝이 같으면 점까지의 거리', () => {
    expect(distanceToSegment({ x: 0, y: 0 }, { x: 0, y: 0 }, 3, 4)).toBe(5);
  });
});

describe('resolveHit', () => {
  it('끝점을 짚으면 그 점 번호를 준다', () => {
    expect(resolveHit([line], 202, 198)).toEqual({ id: 'line', target: 1 });
  });

  it('선 위를 짚으면 몸통', () => {
    expect(resolveHit([line], 150, 150)).toEqual({ id: 'line', target: 'body' });
  });

  it('멀면 아무것도 안 잡힌다', () => {
    expect(resolveHit([line], 150, 40)).toBeNull();
  });

  it('박스는 안쪽 어디를 짚어도 몸통', () => {
    expect(resolveHit([rect], 350, 150)).toEqual({ id: 'rect', target: 'body' });
  });

  it('박스 모서리는 점으로 잡힌다', () => {
    expect(resolveHit([rect], 301, 101)).toEqual({ id: 'rect', target: 0 });
  });

  it('수평선은 가로 어디서든, 높이만 맞으면 잡힌다', () => {
    expect(resolveHit([hline], 1200, 403)).toEqual({ id: 'hline', target: 'body' });
    expect(resolveHit([hline], 1200, 420)).toBeNull();
  });

  it('텍스트는 점 둘레를 넉넉히 연다 — 점 하나뿐이라 좁으면 못 집는다', () => {
    expect(resolveHit([text], 510, 292)).toEqual({ id: 'text', target: 0 });
  });

  it('손익 툴은 상자 안에서 높이로 값을 집는다', () => {
    // 진입(200) 높이를 상자 왼쪽 끝에서 집는다 — 점이 찍힌 x(600)와 멀어도 된다.
    expect(resolveHit([position], 780, 201)).toEqual({ id: 'pos', target: 0 });
    expect(resolveHit([position], 780, 299)).toEqual({ id: 'pos', target: 1 });
    expect(resolveHit([position], 780, 102)).toEqual({ id: 'pos', target: 2 });
  });

  it('손익 툴의 빈 구간은 몸통', () => {
    expect(resolveHit([position], 700, 250)).toEqual({ id: 'pos', target: 'body' });
  });

  it('상자 밖은 잡히지 않는다', () => {
    expect(resolveHit([position], 900, 200)).toBeNull();
  });

  /*
   * 겹쳤을 때가 이 함수의 핵심이다.
   *
   * 박스 몸통이 추세선 끝점을 덮고 있어도 끝점이 이긴다 — 한 바퀴로 판정하면
   * 끝점을 집으려는데 박스가 통째로 끌려간다.
   */
  it('겹치면 몸통보다 점이 먼저다', () => {
    const cover: HitShape = {
      id: 'cover',
      kind: 'rect',
      xy: [
        { x: 150, y: 150 },
        { x: 260, y: 260 },
      ],
    };
    expect(resolveHit([line, cover], 200, 200)).toEqual({ id: 'line', target: 1 });
  });

  it('몸통끼리 겹치면 위에 그린 것이 잡힌다', () => {
    const cover: HitShape = {
      id: 'cover',
      kind: 'rect',
      xy: [
        { x: 100, y: 100 },
        { x: 260, y: 260 },
      ],
    };
    expect(resolveHit([rect, cover], 180, 180)).toEqual({ id: 'cover', target: 'body' });
  });
});

describe('handleMovesTime', () => {
  it('가격만 뜻이 있는 종류는 시각을 붙잡아 둔다', () => {
    expect(handleMovesTime('hline')).toBe(false);
    expect(handleMovesTime('long')).toBe(false);
    expect(handleMovesTime('short')).toBe(false);
  });

  it('나머지는 두 축 모두 움직인다', () => {
    expect(handleMovesTime('line')).toBe(true);
    expect(handleMovesTime('rect')).toBe(true);
    expect(handleMovesTime('text')).toBe(true);
  });
});
