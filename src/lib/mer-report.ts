/**
 * MER 탭의 집계 — 시뮬 관측값(mer_zone_hits)·거래·체결을 화면 한 장 분량으로 만든다(REQ-0102).
 *
 * 시뮬 대상 고르기(merCandidate)·첫 진입가(firstEntry)는 시뮬 액션과 탭이 같이 써서
 * "미계산 n건"과 실제로 돌리는 대상이 어긋나지 않게 한다.
 * 다리 R·MER 은 저장하지 않고 여기서 매번 계산한다(0044 원칙).
 */
import type { MerZoneHit, Trade, TradeFill } from '@/lib/domain';
import { edgeStats } from '@/lib/edge';
import {
  legResultR,
  merTable,
  MER_ZONES_R,
  withAddTradeR,
  type MerTradeInput,
  type MerZoneRow,
  type ZoneHit,
  type ZoneR,
} from '@/lib/mer';
import { BARS, type Bar } from '@/lib/okx';
import { mergeFills } from '@/lib/position-r';
import { stopDistance, tradeR, type RTrade } from '@/lib/r-multiple';

type Maybe = number | null;

const pos = (v: Maybe | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v) && v > 0;

export type MerCandidateTrade = Pick<Trade, 'side' | 'exit_at' | 'exit_price' | 'entry_price' | 'stop_px_0'>;

/**
 * 시뮬 대상인가 — 청산(청산 시각·청산가)되고 최초 손절이 있고, 그 손절이 진입가보다 위험 쪽인 거래.
 * 이익 쪽 손절(옮겨진 손절이 최초 손절로 잡힌 과거 거래)은 d₀ 가 음수라 구간을 못 정한다 — 뺀다(함정 2).
 * 여기서는 거래 행의 평균 진입가로 거른다. 첫 체결 기준 재확인은 액션이 한다.
 */
export function merCandidate(t: MerCandidateTrade): boolean {
  if (t.exit_at === null || !Number.isFinite(Date.parse(t.exit_at))) return false;
  if (!pos(t.exit_price) || !pos(t.stop_px_0) || !pos(t.entry_price)) return false;
  return stopDistance(t.side, t.entry_price, t.stop_px_0) > 0;
}

export type EntryFill = Pick<TradeFill, 'role' | 'filled_at' | 'price' | 'amount'>;

/** 진입 체결 → 묶음(1분 안에 잇단 체결은 한 주문). 수량(USDT 금액 ÷ 가격)을 모르는 체결이 하나라도 있으면 null. */
function openGroups(fills: readonly EntryFill[]) {
  const opens = fills.filter((f) => f.role === 'open');
  if (opens.length === 0) return [];
  const flow = opens.map((f) => ({
    atMs: Date.parse(f.filled_at),
    role: 'open' as const,
    price: f.price,
    qty: pos(f.amount) && pos(f.price) ? f.amount / f.price : NaN,
  }));
  if (flow.some((f) => !Number.isFinite(f.atMs) || !(f.qty > 0))) return null;
  return mergeFills(flow);
}

/**
 * 첫 진입 — 첫 진입 체결 묶음의 가중평균가·시각(함정 3). 체결이 없거나 수량을 모르면 거래 행의
 * 진입가·진입 시각으로 대신하고 `fromFills: false`.
 */
export function firstEntry(
  trade: Pick<Trade, 'entry_price' | 'entry_at'>,
  fills: readonly EntryFill[],
): { px: number; atMs: number; fromFills: boolean } | null {
  const groups = openGroups(fills);
  if (groups && groups.length > 0) return { px: groups[0].price, atMs: groups[0].atMs, fromFills: true };
  const atMs = Date.parse(trade.entry_at);
  if (!pos(trade.entry_price) || !Number.isFinite(atMs)) return null;
  return { px: trade.entry_price, atMs, fromFills: false };
}

/** 진입 체결 묶음 수 — 2 이상이면 실제로 추가 진입을 한 거래. 수량을 몰라도 묶음 수는 시각만으로 센다. */
export function openGroupCount(fills: readonly Pick<TradeFill, 'role' | 'filled_at' | 'price'>[]): number {
  const flow = fills
    .filter((f) => f.role === 'open')
    .map((f) => ({ atMs: Date.parse(f.filled_at), role: 'open' as const, price: f.price, qty: 1 }))
    .filter((f) => Number.isFinite(f.atMs));
  return mergeFills(flow).length;
}

const isZone = (v: number): v is ZoneR => (MER_ZONES_R as readonly number[]).includes(v);
const isBar = (v: string): v is Bar => (BARS as readonly string[]).includes(v);
const msOrNull = (iso: string | null): Maybe | undefined => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
};

/** 관측 행 → 계산 입력. 칸 하나라도 이상하면 null(틀린 숫자보다 빈 칸). */
export function hitToInput(
  side: Trade['side'],
  h: MerZoneHit,
): { input: MerTradeInput; hit: ZoneHit } | null {
  if (!isZone(h.zone_r) || !isBar(h.bar)) return null;
  const entryMs = Date.parse(h.entry_at);
  const exitMs = Date.parse(h.exit_at);
  const reachedAtMs = msOrNull(h.reached_at);
  const commonStopHitAtMs = msOrNull(h.common_stop_hit_at);
  if (!Number.isFinite(entryMs) || !Number.isFinite(exitMs)) return null;
  if (reachedAtMs === undefined || commonStopHitAtMs === undefined) return null;
  if (!pos(h.entry_px) || !pos(h.stop_px) || !pos(h.exit_px) || !pos(h.zone_px)) return null;
  if (!(Number.isFinite(h.fee_rate) && h.fee_rate >= 0)) return null;
  if (h.outcome === 'reached' && reachedAtMs === null) return null;
  return {
    input: {
      side,
      entryMs,
      entry0: h.entry_px,
      stop0: h.stop_px,
      exitMs,
      exit0: h.exit_px,
      feeRate: h.fee_rate,
    },
    hit: {
      zoneR: h.zone_r,
      zonePx: h.zone_px,
      outcome: h.outcome,
      reachedAtMs,
      commonStopHitAtMs,
      bar: h.bar,
    },
  };
}

export type MerReportTrade = Pick<Trade, 'id' | 'book_id' | 'side'> & RTrade & Pick<Trade, 'stop_px_0_source'>;

export interface WithAddCompare {
  zoneR: ZoneR;
  /** 그 구간에 닿아 다리 R 을 잰 거래 중 거래 R 도 잰 것 */
  n: number;
  original: Maybe;
  withAdd: Maybe;
}

export interface MerReport {
  /** 관측이 있는 거래 수(표본 거래) */
  sampleTrades: number;
  /** 북 id → 표본 거래 수 */
  byBook: Record<string, number>;
  /** 봉 → 표본 거래 수 */
  bars: Record<string, number>;
  /** 최초 손절이 추정(okx_last)인 표본 거래 수 */
  estimated: number;
  /** 진입 체결 묶음이 2개 이상(실제 추가가 있던) 표본 거래 수 */
  actualAdds: number;
  /** 첫 진입 MER — 같은 표본 거래들의 거래 R 엣지 */
  mer0: Maybe;
  /** MER₀ 를 잰 거래 수 */
  mer0N: number;
  rows: MerZoneRow[];
  best: ZoneR | null;
  /** 읽지 못해 뺀 관측 행 수 */
  invalidHits: number;
  /** 추가 포함 vs 없음 — 추가 자리가 없으면 null */
  withAdd: WithAddCompare | null;
}

const mean = (xs: readonly number[]): Maybe => (xs.length === 0 ? null : xs.reduce((a, x) => a + x, 0) / xs.length);

/**
 * MER 표 조립. `trades` 는 표본 범위(전체 북 또는 활성 북)의 거래 — 관측 중 이 거래에 속한 것만 쓴다.
 * `openGroupsByTrade` 는 거래 id → 진입 체결 묶음 수(실제 추가 여부).
 */
export function buildMerReport(
  trades: readonly MerReportTrade[],
  hits: readonly MerZoneHit[],
  openGroupsByTrade: Readonly<Record<string, number>>,
): MerReport {
  const byId = new Map(trades.map((t) => [t.id, t]));
  const byZone: Partial<Record<ZoneR, number[]>> = {};
  const barsByZone: Partial<Record<ZoneR, Record<string, number>>> = {};
  const tradeBar = new Map<string, string>();
  const legByTradeZone = new Map<string, number>();
  let invalidHits = 0;

  for (const h of hits) {
    const trade = byId.get(h.trade_id);
    if (!trade) continue;
    const parsed = hitToInput(trade.side, h);
    if (!parsed) {
      invalidHits += 1;
      continue;
    }
    tradeBar.set(trade.id, h.bar);
    const r = legResultR(parsed.input, parsed.hit);
    if (r === null || !Number.isFinite(r)) continue;
    const z = parsed.hit.zoneR;
    (byZone[z] ??= []).push(r);
    const bars = (barsByZone[z] ??= {});
    bars[h.bar] = (bars[h.bar] ?? 0) + 1;
    legByTradeZone.set(`${trade.id}|${z}`, r);
  }

  const sample = [...tradeBar.keys()].flatMap((id) => {
    const t = byId.get(id);
    return t ? [t] : [];
  });
  const byBook: Record<string, number> = {};
  const bars: Record<string, number> = {};
  for (const t of sample) {
    byBook[t.book_id] = (byBook[t.book_id] ?? 0) + 1;
    const b = tradeBar.get(t.id) as string;
    bars[b] = (bars[b] ?? 0) + 1;
  }

  const tradeRs = new Map<string, number>();
  for (const t of sample) {
    const r = tradeR(t);
    if (r.measurable && r.rMultiple !== null && Number.isFinite(r.rMultiple)) tradeRs.set(t.id, r.rMultiple);
  }
  const mer0 = edgeStats([...tradeRs.values()]).edge;

  const { rows, best } = merTable(byZone, mer0, barsByZone);

  let withAdd: WithAddCompare | null = null;
  if (best !== null) {
    const original: number[] = [];
    const added: number[] = [];
    for (const t of sample) {
      const leg = legByTradeZone.get(`${t.id}|${best}`);
      const r0 = tradeRs.get(t.id);
      if (leg === undefined || r0 === undefined) continue;
      original.push(r0);
      added.push(withAddTradeR(r0, [leg]));
    }
    withAdd = { zoneR: best, n: original.length, original: mean(original), withAdd: mean(added) };
  }

  return {
    sampleTrades: sample.length,
    byBook,
    bars,
    estimated: sample.filter((t) => t.stop_px_0_source === 'okx_last').length,
    actualAdds: sample.filter((t) => (openGroupsByTrade[t.id] ?? 0) >= 2).length,
    mer0,
    mer0N: tradeRs.size,
    rows,
    best,
    invalidHits,
    withAdd,
  };
}
