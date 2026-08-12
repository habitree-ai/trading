/**
 * 차트 메모의 되돌리기 기록.
 *
 * 되돌리려면 "무엇을 했는가"가 아니라 **"그 전에 무엇이었는가"**를 들고 있어야 한다.
 * 옮긴 좌표, 고치기 전 라벨, 지워진 메모 통째 — 되돌릴 때 필요한 건 전부 이전 값이다.
 *
 * 기록은 화면에만 산다. 새로고침하면 사라지고, 다른 사람이 같은 메모를 고쳐도 모른다 —
 * 트레이딩뷰의 되돌리기도 같은 범위다. 서버까지 이력을 남기려면 표가 하나 더 필요한데,
 * 그리다 만 선을 무르는 데 그만한 무게를 얹을 이유가 없다.
 */

import { ANNOTATION_KIND_LABEL, type ChartPoint, type TradeAnnotation } from '@/lib/domain';

export type AnnotationChange =
  /** 새로 그렸다 — 되돌리기는 지우기 */
  | { type: 'create'; id: string; kind: TradeAnnotation['kind'] }
  /** 지웠다 — 되돌리기는 그 메모를 통째로 되살리기 */
  | { type: 'delete'; before: TradeAnnotation }
  /** 옮겼다 — 되돌리기는 이전 좌표로 */
  | { type: 'move'; id: string; kind: TradeAnnotation['kind']; before: ChartPoint[] }
  /** 라벨을 고쳤다 */
  | { type: 'text'; id: string; kind: TradeAnnotation['kind']; before: string | null }
  /** 잠갔거나 풀었다 */
  | { type: 'lock'; id: string; kind: TradeAnnotation['kind']; before: boolean };

/**
 * 들고 있을 기록의 수.
 *
 * 한 거래를 복기하며 긋고 지우는 횟수를 넉넉히 덮는다. 여기 담기는 건 좌표 몇 개와
 * 짧은 글이라 쌓여도 무겁지 않다.
 */
export const UNDO_LIMIT = 50;

export function pushChange(
  stack: readonly AnnotationChange[],
  change: AnnotationChange,
  limit = UNDO_LIMIT,
): AnnotationChange[] {
  return [...stack, change].slice(-limit);
}

function kindOf(change: AnnotationChange): TradeAnnotation['kind'] {
  return change.type === 'delete' ? change.before.kind : change.kind;
}

/**
 * 무엇을 무른 건지 한 줄 — 눌렀는데 아무 말이 없으면 먹었는지 알 수 없다.
 *
 * 문구를 모두 `~를 되돌렸습니다`로 맞춘 건 조사 때문이다. 종류 이름을 목적어로 쓰면
 * 받침에 따라 `을`/`를`이 갈려(박스**를**, 수평선**을**) 조사 고르는 코드가 따로 붙는다.
 * 되돌린 것은 도형이 아니라 **동작**이므로 이쪽이 뜻도 더 맞는다.
 */
export function describeUndo(change: AnnotationChange): string {
  const kind = ANNOTATION_KIND_LABEL[kindOf(change)];

  switch (change.type) {
    case 'create':
      return `${kind} 추가를 되돌렸습니다.`;
    case 'delete':
      return `${kind} 삭제를 되돌렸습니다.`;
    case 'move':
      return `${kind} 이동을 되돌렸습니다.`;
    case 'text':
      return `${kind} 라벨을 되돌렸습니다.`;
    case 'lock':
      return `${kind} 잠금을 되돌렸습니다.`;
  }
}
