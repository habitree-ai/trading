/**
 * 손익 툴의 계산부 — 트레이딩뷰 Long/Short Position 도구가 내미는 항목들.
 *
 * 도구가 보여 주는 건 결국 셋이다: 목표까지 얼마나 먹는가, 손절까지 얼마나 물리는가,
 * 그 둘의 비(손익비)가 몇인가. 화면 좌표는 차트가 주고 여기서는 숫자만 낸다 —
 * 그래야 렌더링과 무관하게 검증할 수 있다(`measure-tool`과 같은 갈래).
 *
 * 금액은 명목가를 곱해 낸다. 무기한 계약의 손익은 `명목가 × 가격변동률`이라,
 * 이 거래에 실제로 실린 크기로 재야 "그때 얼마였나"가 나온다.
 */

import type { ChartPoint, Side } from '@/lib/domain';

export interface PositionInput {
  side: Side;
  entry: number;
  stop: number;
  target: number;
  /** 시트의 `투입` — 없으면 금액 없이 비율만 낸다 */
  notional?: number | null;
}

export interface PositionMetrics {
  side: Side;
  entry: number;
  stop: number;
  target: number;
  /** 진입가 대비 목표까지의 폭 — 항상 양수 */
  rewardPct: number;
  /** 진입가 대비 손절까지의 폭 — 항상 양수 */
  riskPct: number;
  /** 명목가 기준 이익 — 양수. 명목가가 없으면 null */
  rewardAmount: number | null;
  /** 명목가 기준 손실 — 음수. 명목가가 없으면 null */
  lossAmount: number | null;
  /** 손익비 = 보상폭 ÷ 리스크폭. 리스크가 0이면 null */
  rr: number | null;
  /** 방향과 어긋난 배치면 그 이유. 멀쩡하면 null */
  problem: string | null;
}

const PROBLEM: Record<Side, string> = {
  long: '롱은 손절이 진입보다 낮고 목표가 높아야 합니다.',
  short: '숏은 손절이 진입보다 높고 목표가 낮아야 합니다.',
};

/** 진입가가 없거나 0이면 비율을 잴 기준이 없다 — null. */
export function positionMetrics(input: PositionInput): PositionMetrics | null {
  const { side, entry, stop, target, notional = null } = input;
  if (!Number.isFinite(entry) || entry === 0) return null;
  if (!Number.isFinite(stop) || !Number.isFinite(target)) return null;

  const rewardPct = Math.abs(target - entry) / Math.abs(entry);
  const riskPct = Math.abs(entry - stop) / Math.abs(entry);

  const size = notional === null || !Number.isFinite(notional) ? null : Math.abs(notional);

  // 방향이 맞아야 이익 구간이 목표 쪽, 손실 구간이 손절 쪽에 놓인다.
  const ordered =
    side === 'long' ? stop < entry && entry < target : target < entry && entry < stop;

  return {
    side,
    entry,
    stop,
    target,
    rewardPct,
    riskPct,
    rewardAmount: size === null ? null : size * rewardPct,
    lossAmount: size === null ? null : -size * riskPct,
    rr: riskPct === 0 ? null : rewardPct / riskPct,
    problem: ordered ? null : PROBLEM[side],
  };
}

/**
 * 상자의 좌·우 끝을 쥐고 있는 점의 번호.
 *
 * 세 점은 역할(진입·손절·목표) 순서로 저장돼 있고 시각은 제각각이다. 가로 폭을 늘일
 * 때 움직여야 할 건 **지금 그 끝에 있는 점**이지 특정 역할이 아니다 — 폭을 바꿔도
 * 가격은 그대로여야 하므로 어느 점이 끌리든 뜻은 달라지지 않는다.
 */
export function edgePointIndex(
  points: readonly ChartPoint[],
  side: 'left' | 'right',
): number {
  let best = 0;
  for (let i = 1; i < points.length; i += 1) {
    const closer = side === 'left' ? points[i].t < points[best].t : points[i].t > points[best].t;
    if (closer) best = i;
  }
  return best;
}

/**
 * 찍어 둔 세 점이 이 방향과 맞는지 — 어긋나면 그 이유.
 *
 * 그리는 화면, 저장하는 서버, 끌어서 옮긴 뒤까지 같은 기준으로 봐야 한다. 한 군데라도
 * 느슨하면 뒤집힌 배치가 저장되고, 그림은 그럴싸한데 손익비가 거짓말을 한다.
 */
export function positionProblemOf(
  side: Side,
  points: readonly ChartPoint[],
): string | null {
  const [entry, stop, target] = points;
  if (!entry || !stop || !target) return '진입·손절·목표 세 지점이 모두 있어야 합니다.';

  const metrics = positionMetrics({
    side,
    entry: entry.p,
    stop: stop.p,
    target: target.p,
  });
  return metrics === null ? '가격을 읽지 못했습니다.' : metrics.problem;
}
