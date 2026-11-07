/**
 * 추가 진입 다리 — 기록 원문 읽기와 다리별 결과 R(REQ-0102).
 *
 * 다리 행(trade_legs)은 추가를 결정한 순간의 판단이고, 체결(trade_fills)은 사실이다. 둘은 시각 근접(±10분)으로
 * 잇는다(사람이 고른 fill_id 가 있으면 그것). 결과 R 은 **체결가**로만 잰다 — 체결을 못 찾은 다리를
 * 의도가로 계산하면 실제로 안 한 추가가 성적에 섞인다.
 *
 * 다리 R 의 위험 기준은 공통 손절이다: 1R = dir·(체결가 − 공통 손절)·수량.
 * 가격R = dir·(청산가 − 체결가)·수량 ÷ 1R, 비용R = (체결가 + 청산가)·수수료율·수량 ÷ 1R, 순 R = 가격R − 비용R.
 * 청산가는 거래의 exit_price(가중평균) 근사다 — 다리만의 청산 체결은 구분할 수 없다.
 */
import type { Side, Trade, TradeFill, TradeLeg } from '@/lib/domain';
import { cumulativeR } from '@/lib/edge';

/** 다리 기록 순간의 임계점 지표 원값 — 측정 못 한 칸은 null(0 아님). */
export interface LegSignals {
  /** 판정 봉 BB폭 백분위(0~1) */
  bbwPct: number | null;
  /** ATR(5) ÷ ATR(50) */
  atrRatio: number | null;
  /** 현재가 근처 순 감마 부호(가정 부호) */
  netGexSign: -1 | 0 | 1 | null;
  /** 진행 방향 다음 옵션 벽까지 거리(%) */
  wallDistPct: number | null;
  /** 위 매도 깊이 ÷ 아래 매수 깊이 */
  depthRatio: number | null;
  /** 진행 방향 가장 가까운 유동성 공백까지 거리(%) */
  lvnDistPct: number | null;
  /** 켜진 경고 이름들 */
  warnings: string[];
  /** 롱으로 켜진 임계점 수 */
  onLong: number;
  /** 숏으로 켜진 임계점 수 */
  onShort: number;
  collectedAt: string;
}

export type CheckKey =
  | 'level'
  | 'cr_zero'
  | 'zone_passed'
  | 'zone_sample'
  | 'threshold'
  | 'risk_cap'
  | 'cost_cap'
  | 'no_accel';

const CHECK_KEYS: readonly CheckKey[] = [
  'level',
  'cr_zero',
  'zone_passed',
  'zone_sample',
  'threshold',
  'risk_cap',
  'cost_cap',
  'no_accel',
];

/** 추가 체크리스트 한 줄 — ok null 은 "확인 불가"(예 아님). */
export interface CheckItem {
  key: CheckKey;
  ok: boolean | null;
  /** 앱이 판정했나(false 면 사람이 고른 값) */
  auto: boolean;
  detail: string;
}

const numOrNull = (v: unknown): number | null | undefined =>
  v === null ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** jsonb 에서 읽은 지표 원값 — 칸 하나가 깨졌으면 통째로 버린다(틀린 숫자보다 빈 칸). */
export function parseLegSignals(raw: unknown): LegSignals | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;

  const bbwPct = numOrNull(s.bbwPct);
  const atrRatio = numOrNull(s.atrRatio);
  const wallDistPct = numOrNull(s.wallDistPct);
  const depthRatio = numOrNull(s.depthRatio);
  const lvnDistPct = numOrNull(s.lvnDistPct);
  if (
    bbwPct === undefined ||
    atrRatio === undefined ||
    wallDistPct === undefined ||
    depthRatio === undefined ||
    lvnDistPct === undefined
  )
    return null;

  const g = s.netGexSign;
  if (!(g === null || g === -1 || g === 0 || g === 1)) return null;

  if (!Array.isArray(s.warnings) || !s.warnings.every((w): w is string => typeof w === 'string')) return null;
  if (!isCount(s.onLong) || !isCount(s.onShort)) return null;
  if (typeof s.collectedAt !== 'string') return null;

  return {
    bbwPct,
    atrRatio,
    netGexSign: g,
    wallDistPct,
    depthRatio,
    lvnDistPct,
    warnings: [...s.warnings],
    onLong: s.onLong,
    onShort: s.onShort,
    collectedAt: s.collectedAt,
  };
}

/** jsonb 에서 읽은 체크리스트 — 줄 하나가 깨졌으면 통째로 버린다. */
export function parseChecklist(raw: unknown): CheckItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CheckItem[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const c = item as Record<string, unknown>;
    const key = CHECK_KEYS.find((k) => k === c.key);
    if (key === undefined) return null;
    if (!(c.ok === null || typeof c.ok === 'boolean')) return null;
    if (typeof c.auto !== 'boolean' || typeof c.detail !== 'string') return null;
    out.push({ key, ok: c.ok, auto: c.auto, detail: c.detail });
  }
  return out;
}

/** 다리와 체결을 잇는 시각 허용폭 — 기록 버튼을 누른 때와 실제 체결이 몇 분 어긋나도 같은 추가로 본다. */
export const LEG_FILL_TOLERANCE_MS = 600_000;

export type LegLike = Pick<TradeLeg, 'trade_id' | 'leg_no' | 'at' | 'qty' | 'common_stop' | 'fill_id'>;
export type LegFill = Pick<TradeFill, 'id' | 'trade_id' | 'role' | 'filled_at' | 'price'>;

/**
 * 다리의 체결 — 사람이 고른 fill_id 가 있으면 그것, 없으면 같은 거래의 진입 체결 중
 * 다리 시각과 가장 가까운 것(±toleranceMs 안). 같은 거리면 먼저 온 체결.
 */
export function matchFill<F extends LegFill>(
  leg: Pick<LegLike, 'trade_id' | 'at' | 'fill_id'>,
  fills: readonly F[],
  toleranceMs = LEG_FILL_TOLERANCE_MS,
): F | null {
  if (leg.fill_id) {
    const pinned = fills.find((f) => f.id === leg.fill_id);
    if (pinned) return pinned;
  }
  const at = Date.parse(leg.at);
  if (!Number.isFinite(at)) return null;

  let best: F | null = null;
  let bestGap = Infinity;
  for (const f of fills) {
    if (f.role !== 'open' || f.trade_id !== leg.trade_id) continue;
    const t = Date.parse(f.filled_at);
    if (!Number.isFinite(t)) continue;
    const gap = Math.abs(t - at);
    if (gap > toleranceMs) continue;
    if (gap < bestGap || (gap === bestGap && best !== null && t < Date.parse(best.filled_at))) {
      best = f;
      bestGap = gap;
    }
  }
  return best;
}

/** R 을 못 잰 이유 — open 보유 중 / no_common_stop 공통 손절 없음 / wrong_side 공통 손절이 이익 쪽 / no_fill 체결 미연결. */
export type LegUnmeasuredReason = 'open' | 'no_common_stop' | 'wrong_side' | 'no_fill';

export const LEG_UNMEASURED_LABEL: Record<LegUnmeasuredReason, string> = {
  open: '보유 중',
  no_common_stop: '공통 손절 없음',
  wrong_side: '공통 손절이 이익 쪽',
  no_fill: '체결 미연결',
};

export interface LegResult {
  legNo: number;
  /** 다리 1R(USDT) — 체결·공통 손절이 있으면 보유 중이어도 잰다 */
  oneRUsd: number | null;
  costR: number | null;
  priceR: number | null;
  netR: number | null;
  fill: LegFill | null;
  reason: LegUnmeasuredReason | null;
}

export type LegTrade = Pick<Trade, 'side' | 'exit_at' | 'exit_price' | 'fee_rate_at_entry'>;

const dirOf = (side: Side): 1 | -1 => (side === 'long' ? 1 : -1);

/**
 * 다리 1개의 결과 R. 수수료율은 거래에 찍힌 진입 시점 값(fee_rate_at_entry), 없으면 feeRateNow.
 * 이유(reason)가 있으면 가격·비용·순 R 은 null 이다.
 */
export function legResult(
  trade: LegTrade,
  leg: LegLike,
  fills: readonly LegFill[],
  feeRateNow: number,
): LegResult {
  const fill = matchFill(leg, fills);
  const dir = dirOf(trade.side);
  const stop = leg.common_stop;
  const px = fill?.price ?? null;

  const risk = px !== null && stop !== null ? dir * (px - stop) : null;
  const oneRUsd = risk !== null && risk > 0 ? risk * leg.qty : null;

  const base = { legNo: leg.leg_no, oneRUsd, costR: null, priceR: null, netR: null, fill };
  if (trade.exit_at === null || trade.exit_price === null) return { ...base, reason: 'open' };
  if (stop === null) return { ...base, reason: 'no_common_stop' };
  if (px === null) return { ...base, reason: 'no_fill' };
  if (oneRUsd === null) return { ...base, reason: 'wrong_side' };

  const exit = trade.exit_price;
  const feeRate = trade.fee_rate_at_entry ?? feeRateNow;
  const priceR = (dir * (exit - px) * leg.qty) / oneRUsd;
  const costR = ((px + exit) * feeRate * leg.qty) / oneRUsd;
  return { ...base, priceR, costR, netR: priceR - costR, reason: null };
}

/** 누적 다리 R 곡선의 점 하나. */
export interface LegPoint {
  /** 다리 기록 시각(ms) */
  t: number;
  tradeId: string;
  legNo: number;
  r: number;
  cum: number;
}

/** 순 R 을 잰 다리만 기록 시각순으로 모아 누적 곡선 점으로. */
export function legPoints(
  rows: readonly { leg: Pick<TradeLeg, 'trade_id' | 'leg_no' | 'at'>; result: Pick<LegResult, 'netR'> }[],
): LegPoint[] {
  const measured = rows
    .flatMap(({ leg, result }) => {
      const t = Date.parse(leg.at);
      return result.netR !== null && Number.isFinite(t)
        ? [{ t, tradeId: leg.trade_id, legNo: leg.leg_no, r: result.netR }]
        : [];
    })
    .sort((a, b) => a.t - b.t || a.legNo - b.legNo);
  const cum = cumulativeR(measured.map((p) => p.r));
  return measured.map((p, i) => ({ ...p, cum: cum[i] }));
}
