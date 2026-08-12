/**
 * 차트 메모의 좌표 해석 — DB의 jsonb와 화면 사이를 잇는 순수 함수 모듈.
 *
 * 좌표를 jsonb로 두는 이유: 종류마다 점의 수가 다르다(수평선 1점, 박스 2점). 열로
 * 펴면 쓰지 않는 칸이 절반이 되고, 종류를 하나 더할 때마다 스키마가 흔들린다.
 *
 * 대신 형태 검증이 앱 몫이 된다. 한 건이 깨졌다고 차트 전체를 비우지 않도록,
 * 읽지 못한 메모만 버리고 나머지는 그대로 그린다 — OKX 응답을 다루는 방식과 같다.
 */

import type { AnnotationColor, AnnotationKind, ChartPoint, TradeAnnotation } from '@/lib/domain';
import { ANNOTATION_COLORS, ANNOTATION_KINDS, isPositionKind } from '@/lib/domain';

/** 종류마다 필요한 점의 수 — 저장할 때와 읽을 때가 같은 기준을 봐야 한다. */
export function pointCount(kind: AnnotationKind): 1 | 2 | 3 {
  if (kind === 'text' || kind === 'hline') return 1;
  return isPositionKind(kind) ? 3 : 2;
}

export function isAnnotationKind(value: unknown): value is AnnotationKind {
  return typeof value === 'string' && (ANNOTATION_KINDS as string[]).includes(value);
}

export function isAnnotationColor(value: unknown): value is AnnotationColor {
  return typeof value === 'string' && (ANNOTATION_COLORS as string[]).includes(value);
}

/** 좌표 배열을 읽는다 — 점의 수나 형태가 어긋나면 null. */
export function parsePoints(raw: unknown, kind: AnnotationKind): ChartPoint[] | null {
  if (!Array.isArray(raw) || raw.length !== pointCount(kind)) return null;

  const out: ChartPoint[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const { t, p } = item as { t?: unknown; p?: unknown };
    if (typeof t !== 'number' || typeof p !== 'number') return null;
    if (!Number.isFinite(t) || !Number.isFinite(p)) return null;
    out.push({ t, p });
  }
  return out;
}

/** DB 행의 모양 — 이 모듈이 `Database` 타입에 묶이지 않도록 필요한 칸만 적는다. */
export interface AnnotationRow {
  id: string;
  trade_id: string;
  user_id: string;
  kind: string;
  points: unknown;
  text: string | null;
  color: string;
  locked: boolean;
  created_at: string;
  updated_at: string;
}

/** 읽을 수 없는 행은 null — 부르는 쪽이 걸러 낸다. */
export function toAnnotation(row: AnnotationRow): TradeAnnotation | null {
  if (!isAnnotationKind(row.kind)) return null;
  const points = parsePoints(row.points, row.kind);
  if (points === null) return null;

  return {
    id: row.id,
    trade_id: row.trade_id,
    user_id: row.user_id,
    kind: row.kind,
    points,
    text: row.text,
    // 모르는 색은 기본값으로 떨어뜨린다 — 색 하나 때문에 메모를 버릴 이유는 없다.
    color: isAnnotationColor(row.color) ? row.color : 'accent',
    locked: row.locked,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 저장 직전 좌표 다듬기.
 *
 * 박스와 추세선은 어느 방향으로 끌든 같은 도형이다. 시각이 이른 점을 앞에 두면
 * 목록에 찍히는 "언제"가 끄는 방향에 따라 달라지지 않는다.
 *
 * 손익 툴만 예외다 — `[진입, 손절, 목표]`라는 순서 자체가 뜻이라 세우면 역할이 뒤바뀐다.
 */
export function normalizePoints(
  kind: AnnotationKind,
  points: readonly ChartPoint[],
): ChartPoint[] {
  if (isPositionKind(kind)) return [...points];
  return [...points].sort((a, b) => a.t - b.t);
}

/** 색 토큰 → 화면 클래스 — 차트에 그린 색과 도구 버튼·목록의 점 색을 맞춘다. */
export const ANNOTATION_DOT_CLASS: Record<AnnotationColor, string> = {
  accent: 'bg-accent',
  profit: 'bg-profit',
  loss: 'bg-loss',
  beta: 'bg-beta',
};

/** 메모가 가리키는 시각 — 목록을 시간순으로 세울 때 쓴다. */
export function anchorTime(annotation: TradeAnnotation): number {
  return annotation.points[0]?.t ?? 0;
}
