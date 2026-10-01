/**
 * 무포지션(REQ-0087) — 포지션이 없는 상태를 내가 선택해서 드는 포지션으로 다룬다.
 *
 * 시작은 사람이 누른 시각(`flat_sessions.started_at`)이고, 끝은 저장하지 않는다. 시작 뒤 처음
 * 포지션이 생긴 시각이 끝이고 그 거래는 OKX 동기화가 넣는다 — 그래서 끝은 볼 때마다 거래에서 계산한다.
 */

import type { FlatSession, Trade } from '@/lib/domain';
import { IMPULSE } from '@/lib/impulse';
import { isOpenTrade, type TradeDerived } from '@/lib/metrics';

/** 무포지션 구간을 끝낸 진입 */
export interface FlatEnd {
  endMs: number;
  endedBy: Trade;
}

/**
 * 무포지션 구간의 끝 — 시작 이후 포지션과 겹치는 첫 시각. 아직 겹친 거래가 없으면 null.
 *
 * 시작 뒤의 진입만 보면 안 된다. 동기화가 늦어 시작을 누를 때 이미 들고 있던 포지션은 진입이
 * 시작보다 앞이다 — 그 구간은 무포지션이 아니었으므로 길이 0 으로 끝낸다.
 */
export function flatEnd(startMs: number, trades: readonly Trade[]): FlatEnd | null {
  let best: FlatEnd | null = null;
  for (const t of trades) {
    const overlaps = t.exit_at === null || isOpenTrade(t) || Date.parse(t.exit_at) > startMs;
    if (!overlaps) continue;
    const endMs = Math.max(Date.parse(t.entry_at), startMs);
    if (best === null || endMs < best.endMs) best = { endMs, endedBy: t };
  }
  return best;
}

export type FlatState =
  /** 포지션 보유 중 — `endedFlat` 은 지금 들고 있는 진입이 끝낸 무포지션(있었다면) */
  | { kind: 'holding'; open: Trade[]; endedFlat: (FlatEnd & { startMs: number }) | null }
  /** 무포지션 보유 중 */
  | { kind: 'flat'; startMs: number }
  /** 포지션도 없고 무포지션도 시작하지 않았다 — 시작을 눌러야 한다 */
  | { kind: 'idle' };

/** 지금 무엇을 들고 있는가 — `latest` 는 그 북에서 가장 최근에 누른 시작 */
export function flatState(latest: FlatSession | null, trades: readonly Trade[]): FlatState {
  const startMs = latest === null ? null : Date.parse(latest.started_at);
  const end = startMs === null ? null : flatEnd(startMs, trades);

  const open = trades.filter(isOpenTrade);
  if (open.length > 0) {
    const mine =
      startMs !== null && end !== null && end.endMs > startMs && open.some((t) => t.id === end.endedBy.id);
    return { kind: 'holding', open, endedFlat: mine ? { ...end, startMs } : null };
  }
  if (startMs !== null && end === null) return { kind: 'flat', startMs };
  return { kind: 'idle' };
}

/** 재진입 실측의 한쪽 — 청산 60분 안에 다시 들어간 거래들, 또는 넘겨서 들어간 거래들 */
export interface ReentryBucket {
  count: number;
  wins: number;
  losses: number;
  /** 순손익 합계(`net`) */
  net: number;
  /** 승 ÷ (승 + 패) — 본전은 분모에서 뺀다(`computeMetrics` 와 같은 잣대) */
  winRate: number | null;
  /** 건당 평균 순손익 */
  avgNet: number | null;
}

export interface ReentryStats {
  /** 직전 청산 뒤 60분 안에 들어간 거래 */
  quick: ReentryBucket;
  /** 60분을 넘겨 들어간 거래 */
  waited: ReentryBucket;
}

/** 이보다 적은 쪽이 있으면 두 묶음의 차이를 읽지 않는다 */
export const REENTRY_MIN_SAMPLE = 5;

function bucket(rows: readonly TradeDerived[]): ReentryBucket {
  const wins = rows.filter((d) => d.result === 'win').length;
  const losses = rows.filter((d) => d.result === 'loss').length;
  const net = rows.reduce((a, d) => a + d.net, 0);
  return {
    count: rows.length,
    wins,
    losses,
    net,
    winRate: wins + losses === 0 ? null : wins / (wins + losses),
    avgNet: rows.length === 0 ? null : net / rows.length,
  };
}

/**
 * 기다린 진입과 안 기다린 진입의 실제 성과 — 이 북의 청산된 거래로만 잰다.
 *
 * 경계는 60분 규칙(docs/repeatable §2.2) 그대로다. 기산점이 없는 거래(북의 첫 거래)는 어느 쪽도 아니다.
 * 결과가 규칙과 반대로 나와도 그대로 돌려준다 — 보여 줄지 말지는 화면이 정하지 않는다.
 */
export function reentryStats(derived: readonly TradeDerived[]): ReentryStats {
  const closed = derived.filter((d) => d.result !== 'open' && d.sinceLastExitMs !== null);
  return {
    quick: bucket(closed.filter((d) => (d.sinceLastExitMs as number) < IMPULSE.baseWaitMs)),
    waited: bucket(closed.filter((d) => (d.sinceLastExitMs as number) >= IMPULSE.baseWaitMs)),
  };
}
