/**
 * 근거 없는 거래 — 뇌동매매의 흔적을 고르는 판정.
 *
 * 동기화로 들어온 거래는 숫자만 채워져 온다. 근거 칸이 빈 거래가 곧 "왜 들어갔는지 모르는
 * 거래"다. 이 판정을 대시보드 경고(REQ-0038)와 주문 화면이 같이 쓴다 — 두 화면이 다른
 * 거래를 세면 경고를 믿을 수 없게 된다.
 */
import type { Trade } from '@/lib/domain';
import { isOpenTrade } from '@/lib/metrics';

/**
 * 경고에 올리는 창(일).
 *
 * 몇 달 전 거래의 근거를 지금 적는 것은 근거가 아니라 지어낸 이야기다. 최근 것과 아직
 * 들고 있는 것만 올리고, 오래된 빈칸은 목록의 "복기 대기" 필터가 맡는다.
 */
export const RATIONALE_ALERT_DAYS = 30;

export function lacksRationale(trade: Pick<Trade, 'rationale'>): boolean {
  return (trade.rationale ?? '').trim() === '';
}

/**
 * 근거가 빈 거래 중 경고 대상 — 보유중이거나 창 안에 진입한 것. 최근 진입이 먼저.
 */
export function unjustifiedTrades(
  trades: readonly Trade[],
  nowMs: number,
  days = RATIONALE_ALERT_DAYS,
): Trade[] {
  const floor = nowMs - days * 24 * 60 * 60 * 1000;
  return trades
    .filter((t) => lacksRationale(t) && (isOpenTrade(t) || Date.parse(t.entry_at) >= floor))
    .sort((a, b) => Date.parse(b.entry_at) - Date.parse(a.entry_at) || b.seq - a.seq);
}
