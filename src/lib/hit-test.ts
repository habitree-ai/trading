/**
 * 메모를 집는 판정 — 커서가 어느 도형의 어디를 짚었는가.
 *
 * 화면 좌표로 옮기는 건 차트가 하고, 여기서는 그 좌표만 놓고 판단한다. 렌더링과
 * 떼어 놓아야 "가까이 갔는데 안 잡힌다"를 눈이 아니라 테스트로 잡을 수 있다.
 *
 * 판정은 두 바퀴 돈다. 먼저 모든 도형의 **점**을 보고, 없으면 **몸통**을 본다.
 * 한 바퀴로 끝내면 위에 겹친 도형의 몸통이 아래 도형의 점을 가로채, 끝점을 집으려는데
 * 도형 전체가 끌려가는 일이 생긴다.
 */

import { isPositionKind, type AnnotationKind } from '@/lib/domain';

/** 점을 집었다고 볼 거리(px) — 손가락으로도 집히게 넉넉히 둔다. */
export const HANDLE_HIT = 8;
/** 선·테두리를 집었다고 볼 거리(px). */
export const LINE_HIT = 6;
/** 텍스트 메모는 점 하나뿐이라 조금 더 넓게 연다. */
export const TEXT_HIT = 14;

export interface Point2D {
  x: number;
  y: number;
}

export interface HitShape {
  id: string;
  kind: AnnotationKind;
  /** 화면 좌표로 옮긴 좌표들 — 저장 순서 그대로 */
  xy: readonly Point2D[];
  /** 가로로 뻗는 종류(손익 툴)가 차지하는 x 범위 */
  span?: { left: number; right: number };
}

/**
 * 무엇을 집었는가.
 *
 * 점 번호이거나, 도형 전체(`body`)이거나, 손익 툴 상자의 좌·우 가장자리다.
 * 가장자리는 가로 폭만 늘이고 줄인다 — 값(가격)은 그대로 둔다.
 */
export type HitTarget = number | 'body' | 'left' | 'right';

export interface AnnotationHit {
  id: string;
  target: HitTarget;
}

function near(a: Point2D, x: number, y: number, r: number): boolean {
  return Math.abs(a.x - x) <= r && Math.abs(a.y - y) <= r;
}

/** 선분까지의 거리 — 추세선 위를 짚었는지 보는 데 쓴다. */
export function distanceToSegment(a: Point2D, b: Point2D, x: number, y: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;

  // 두 끝이 같은 자리면 선분이 아니라 점이다.
  if (lengthSq === 0) return Math.hypot(x - a.x, y - a.y);

  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSq));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

/** 이 도형에서 집힌 자리 — 점 번호이거나 가장자리. 없으면 null. */
function handleAt(shape: HitShape, x: number, y: number): HitTarget | null {
  const { kind, xy } = shape;

  if (isPositionKind(kind)) {
    const span = shape.span;
    if (!span) return null;

    /*
     * 가장자리가 값보다 먼저다.
     *
     * 모서리에서는 둘 다 걸리는데, 거기서 잡히길 기대하는 건 폭 조절이다 — 값은
     * 상자 안 어디서든 집히지만 가장자리는 그 선 위에서만 집힌다.
     */
    const ys = xy.map((p) => p.y);
    const inBand = y >= Math.min(...ys) - HANDLE_HIT && y <= Math.max(...ys) + HANDLE_HIT;
    if (inBand) {
      if (Math.abs(x - span.left) <= HANDLE_HIT) return 'left';
      if (Math.abs(x - span.right) <= HANDLE_HIT) return 'right';
    }

    // 세 값은 가격이다 — 상자 안이라면 가로 어디서든 그 높이를 집을 수 있다.
    if (x < span.left - HANDLE_HIT || x > span.right + HANDLE_HIT) return null;
    for (let i = 0; i < xy.length; i += 1) {
      if (Math.abs(xy[i].y - y) <= HANDLE_HIT) return i;
    }
    return null;
  }

  // 수평선도 마찬가지로 높이만 뜻이 있다. 몸통과 점이 같으므로 몸통 쪽에서 받는다.
  if (kind === 'hline') return null;

  const radius = kind === 'text' ? TEXT_HIT : HANDLE_HIT;
  for (let i = 0; i < xy.length; i += 1) {
    if (near(xy[i], x, y, radius)) return i;
  }
  return null;
}

/** 이 도형의 몸통을 집었는가. */
function bodyAt(shape: HitShape, x: number, y: number): boolean {
  const { kind, xy } = shape;
  const [a, b] = xy;
  if (!a) return false;

  if (kind === 'hline') return Math.abs(a.y - y) <= LINE_HIT;
  if (kind === 'text') return near(a, x, y, TEXT_HIT);
  if (kind === 'line') return b !== undefined && distanceToSegment(a, b, x, y) <= LINE_HIT;

  if (kind === 'rect') {
    if (!b) return false;
    return (
      x >= Math.min(a.x, b.x) - LINE_HIT &&
      x <= Math.max(a.x, b.x) + LINE_HIT &&
      y >= Math.min(a.y, b.y) - LINE_HIT &&
      y <= Math.max(a.y, b.y) + LINE_HIT
    );
  }

  if (isPositionKind(kind)) {
    const span = shape.span;
    if (!span || x < span.left || x > span.right) return false;
    const ys = xy.map((p) => p.y);
    return y >= Math.min(...ys) && y <= Math.max(...ys);
  }

  return false;
}

/**
 * 커서가 짚은 것 — 위에 그려진 것부터 본다.
 *
 * 목록의 뒤쪽이 나중에 그려져 위에 얹히므로, 뒤에서부터 훑어야 눈에 보이는 것이 잡힌다.
 */
export function resolveHit(
  shapes: readonly HitShape[],
  x: number,
  y: number,
): AnnotationHit | null {
  for (let i = shapes.length - 1; i >= 0; i -= 1) {
    const target = handleAt(shapes[i], x, y);
    if (target !== null) return { id: shapes[i].id, target };
  }
  for (let i = shapes.length - 1; i >= 0; i -= 1) {
    if (bodyAt(shapes[i], x, y)) return { id: shapes[i].id, target: 'body' };
  }
  return null;
}

/**
 * 점을 끌 때 시각까지 함께 움직이는가.
 *
 * 수평선과 손익 툴의 값은 가격이다 — 세로로 끄는 동안 시각까지 딸려 가면 상자가
 * 옆으로 기어간다. 몸통을 끌 때는 둘 다 움직인다(도형을 통째로 옮기는 것이므로).
 */
export function handleMovesTime(kind: AnnotationKind): boolean {
  return !isPositionKind(kind) && kind !== 'hline';
}
