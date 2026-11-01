/**
 * 거래별 R — 손익을 "그 거래가 진입 때 건 위험"으로 나눠 위험 대비 결과로 바꾼다(REQ-0089).
 *
 * 정본 명세: Claude Docs 「R·트레이딩 엣지·CR·E 서비스 반영 명세」(2026-11-01).
 * R 은 두 층이다. 기준 R 은 사용자가 정한 금액(계좌의 위험 단위)이고, 최초 위험은
 * 최초 손절폭 × 진입 수량(그 거래가 실제로 건 위험)이다.
 *
 * 진입 수량은 **거래 전체**의 진입 수량, 손절폭은 평균 진입가 기준이다(11-01 사용자 결정). 첫 랏만
 * 분모로 두면 나중에 크게 더 산 거래가 −10R 대로 부풀어(Repeatable 39건) 엣지가 −3.6R 로 뒤틀린다.
 * 명세의 10/17 대입 숫자(121건·−0.37R)도 이 방식으로 계산된 값이다.
 *
 * - R 배수 = 순손익 ÷ 최초 위험 — 엣지의 재료. 분모는 **가격만**(책 정의). 비용은 비용R 로 분리
 * - 위험 배수 = (최초 손절폭 + 예상 왕복 비용) × 최초 수량 ÷ 기준 R — 1R 수량(비용 포함 사이징)대로
 *   들어가면 정확히 1.0 이 되도록 **비용을 넣는다**(11-01 사용자 결정)
 * - 최초 손절은 진입 순간 고정값(`stop_px_0`) — 손절을 옮겨도 분모는 바뀌지 않는다
 */
import type { Side, StopSource, Trade, TradeFill } from '@/lib/domain';
import { netOf } from '@/lib/metrics';

type Maybe = number | null;

/** R 계산에 필요한 거래 칸만. */
export type RTrade = Pick<
  Trade,
  | 'side'
  | 'entry_price'
  | 'notional'
  | 'pnl'
  | 'fee'
  | 'funding_fee'
  | 'realized_pnl'
  | 'exit_at'
  | 'result'
  | 'stop_px_0'
  | 'stop_px_0_source'
  | 'r_base_at_entry'
  | 'fee_rate_at_entry'
>;

export type RFill = Pick<TradeFill, 'role' | 'filled_at' | 'price' | 'amount'>;

/** R 을 잴 수 없는 이유. */
export type RUnmeasuredReason = 'no_stop' | 'stop_wrong_side' | 'no_qty';

export const R_UNMEASURED_LABEL: Record<RUnmeasuredReason, string> = {
  no_stop: '최초 손절 없음',
  stop_wrong_side: '손절이 이익 쪽(옮겨진 손절)',
  no_qty: '진입 수량 불명',
};

export interface EntrySize {
  /** 평균 진입가 */
  price: number;
  /** 진입 수량 합계 */
  qty: number;
}

const pos = (v: Maybe | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v) && v > 0;

/**
 * 진입 크기 — 평균 진입가와 진입 수량 합계.
 *
 * 청산 거래는 거래의 진입가·명목가(`notional ÷ entry_price`)를 쓴다 — 명세 숫자가 이 값이고, 체결 기록은
 * 빠진 건이 있어 거래 행과 어긋나기도 한다(Repeatable 29건). 보유 중인 OKX 거래의 명목가는 **남은**
 * 물량이라(부분청산 후 줄어든다) 진입 체결 합계를 먼저 쓴다.
 */
export function entrySizeOf(
  trade: Pick<RTrade, 'entry_price' | 'notional'>,
  fills: readonly RFill[],
  open: boolean,
): EntrySize | null {
  const fromTrade = (): EntrySize | null => {
    const { entry_price: entry, notional } = trade;
    if (!pos(entry) || notional === null || !Number.isFinite(notional) || notional === 0) return null;
    return { price: entry, qty: Math.abs(notional) / entry };
  };
  if (!open) return fromTrade();

  const opens = fills.filter((f) => f.role === 'open' && pos(f.price) && pos(f.amount));
  if (opens.length === 0) return fromTrade();
  const qty = opens.reduce((a, f) => a + (f.amount as number) / f.price, 0);
  const amount = opens.reduce((a, f) => a + (f.amount as number), 0);
  return { price: amount / qty, qty };
}

/** 최초 손절폭 — 롱 진입가 − 손절가, 숏 손절가 − 진입가. 위험 쪽이면 양수다. */
export function stopDistance(side: Side, entry: number, stop: number): number {
  return side === 'long' ? entry - stop : stop - entry;
}

export interface TradeR {
  /** 이 거래가 엣지 표본에 들어가는가 — 청산됐고 최초 위험이 있다 */
  measurable: boolean;
  /** 잴 수 없는 이유 — 최초 위험을 못 구한 경우만. 보유 중은 이유가 아니다 */
  reason: RUnmeasuredReason | null;
  closed: boolean;
  entry0: Maybe;
  qty0: Maybe;
  stop0: Maybe;
  /** 최초 손절의 출처 — `okx_last` 는 추정(마지막 거래소 손절)이라 화면이 따로 센다 */
  stop0Source: StopSource | null;
  /** 최초 손절폭 × 진입 수량 (USDT) */
  initialRisk: Maybe;
  /** 기준 R 의 몇 배를 걸었나 — 예상 왕복 비용 포함. 기준 R 스냅샷이 없으면 null */
  riskMultiple: Maybe;
  /** 순손익 ÷ 최초 위험. 보유 중이면 null */
  rMultiple: Maybe;
  /** 가격손익 ÷ 최초 위험 */
  priceR: Maybe;
  /** 비용(수수료 + 낸 펀딩 − 받은 펀딩 + 그 밖의 차이) ÷ 최초 위험. 낸 비용이면 양수 */
  costR: Maybe;
  /** 순손익 ÷ 기준 R. 기준 R 스냅샷이 없으면 null */
  baseRPnl: Maybe;
}

/** 보유 중인가 — `metrics.isOpenTrade` 와 같은 판정. */
function isOpen(trade: Pick<RTrade, 'result' | 'exit_at' | 'pnl'>): boolean {
  return trade.result === 'open' || trade.exit_at === null || trade.pnl === null;
}

export function tradeR(trade: RTrade, fills: readonly RFill[] = []): TradeR {
  const closed = !isOpen(trade);
  const empty: TradeR = {
    measurable: false,
    reason: null,
    closed,
    entry0: null,
    qty0: null,
    stop0: trade.stop_px_0,
    stop0Source: trade.stop_px_0_source,
    initialRisk: null,
    riskMultiple: null,
    rMultiple: null,
    priceR: null,
    costR: null,
    baseRPnl: null,
  };

  const net = closed ? netOf(trade) : null;
  const rBase = pos(trade.r_base_at_entry) ? trade.r_base_at_entry : null;
  if (net !== null && rBase !== null) empty.baseRPnl = net / rBase;

  if (!pos(trade.stop_px_0)) return { ...empty, reason: 'no_stop' };
  const lot = entrySizeOf(trade, fills, !closed);
  if (lot === null) return { ...empty, reason: 'no_qty' };

  const d0 = stopDistance(trade.side, lot.price, trade.stop_px_0);
  const base = { ...empty, entry0: lot.price, qty0: lot.qty };
  if (!(d0 > 0)) return { ...base, reason: 'stop_wrong_side' };

  const initialRisk = d0 * lot.qty;
  const feeRate = trade.fee_rate_at_entry !== null && trade.fee_rate_at_entry >= 0 ? trade.fee_rate_at_entry : 0;
  const roundTripCost = (lot.price + trade.stop_px_0) * feeRate;
  const riskMultiple = rBase !== null ? ((d0 + roundTripCost) * lot.qty) / rBase : null;

  const out: TradeR = { ...base, initialRisk, riskMultiple, measurable: closed };
  if (net === null) return out;

  const pricePnl = trade.pnl ?? 0;
  return {
    ...out,
    rMultiple: net / initialRisk,
    priceR: pricePnl / initialRisk,
    costR: (pricePnl - net) / initialRisk,
  };
}

/**
 * 설정 화면 입력 → 기준 R 이력 행 값. 수수료율은 % 로 받는다(0.05 → 0.0005).
 * DB 제약(amount > 0, 0 ≤ fee_rate < 1%)과 같은 범위를 먼저 막아 오류 문구를 사람 말로 낸다.
 */
export function parseRBaseInput(
  amountText: string,
  feePctText: string,
): { amount: number; feeRate: number } | { error: string } {
  const amount = Number(amountText.trim().replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return { error: '기준 R 은 0보다 큰 금액(USDT)이어야 합니다.' };
  const feePct = Number(feePctText.trim());
  if (feePctText.trim() === '' || !Number.isFinite(feePct) || feePct < 0 || feePct >= 1) {
    return { error: '수수료율은 0 이상 1% 미만(예 0.05)이어야 합니다.' };
  }
  return { amount, feeRate: feePct / 100 };
}
