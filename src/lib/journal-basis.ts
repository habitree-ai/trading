import type { JournalBasis, JournalBasisChange, Trade, TradeFill } from '@/lib/domain';
import { activeTargetPrices } from '@/lib/exit-plan';

/**
 * 포지션 추가 기록의 기준(basis) — 스냅샷을 뜨고, 직전과 견주고, 추가 진입 체결을 고른다.
 *
 * 폼이 미리보기로 그리는 것과 서버 액션이 저장하는 것이 같은 함수를 거쳐야 "화면에 뜬 변경
 * 내용"과 "저장된 변경 내용"이 어긋나지 않는다. DB 도 화면도 모른다 — 순수 함수만.
 */

/** 진입 기록이 있는 거래 — 근거·복기·감정 중 하나가 적혀 있거나 사진이 붙어 있으면 기록이다. */
export function hasPositionRecord(trade: Trade): boolean {
  return (
    [trade.rationale, trade.review, trade.emotion].some((v) => (v ?? '').trim() !== '') ||
    trade.image_paths.length > 0
  );
}

/** 지금 거래 행의 수치를 기준으로 뜬다. 체결·변경은 부르는 쪽이 채운다. */
export function snapshotBasis(trade: Trade): JournalBasis {
  return {
    entry_price: trade.entry_price,
    notional: trade.notional,
    leverage: trade.leverage,
    stop_price: trade.okx_stop_price ?? trade.stop_price,
    tp_prices: activeTargetPrices(trade),
    unrealized_pnl: trade.unrealized_pnl,
    fill: null,
    changes: null,
  };
}

/** 견주는 항목과 화면 라벨 — 평가손익은 시세 따라 늘 다르니 "변경"으로 치지 않는다. */
const COMPARED: { label: string; pick: (b: JournalBasis) => number | null }[] = [
  { label: '진입가', pick: (b) => b.entry_price },
  { label: '투입', pick: (b) => b.notional },
  { label: 'Lv', pick: (b) => b.leverage },
  { label: '손절', pick: (b) => b.stop_price },
  { label: 'TP1', pick: (b) => b.tp_prices[0] ?? null },
  { label: 'TP2', pick: (b) => b.tp_prices[1] ?? null },
  { label: 'TP3', pick: (b) => b.tp_prices[2] ?? null },
];

/**
 * 직전 기록의 스냅샷과 지금을 견줘 달라진 항목만.
 *
 * 직전이 없으면 빈 배열이다 — 동기화가 거래 행을 덮어쓰므로 진입 시점 값은 되짚을 수 없다.
 * 그때는 "지금 값"만 스냅샷으로 남고, 무엇이 바뀌었는지는 사람이 내용에 적는다.
 */
export function diffBasis(prev: JournalBasis | null, cur: JournalBasis): JournalBasisChange[] {
  if (prev === null) return [];
  const changes: JournalBasisChange[] = [];
  for (const { label, pick } of COMPARED) {
    const from = pick(prev);
    const to = pick(cur);
    if (from === to) continue;
    changes.push({ label, from, to });
  }
  return changes;
}

/**
 * 추가 진입 후보 — 첫 진입 체결을 뺀 나머지 진입 체결, 오래된 것부터.
 *
 * 첫 체결은 진입 기록(거래 행)의 몫이다. 청산 체결은 "추가 진입"이 아니다.
 */
export function addOnFills(fills: readonly TradeFill[]): TradeFill[] {
  return fills
    .filter((f) => f.role === 'open')
    .sort((a, b) => a.filled_at.localeCompare(b.filled_at))
    .slice(1);
}

/** 체결 하나를 기준에 실을 모양으로. */
export function fillBasis(fill: TradeFill): NonNullable<JournalBasis['fill']> {
  return { filled_at: fill.filled_at, price: fill.price, amount: fill.amount };
}

/** jsonb 에서 읽은 값이 기준 모양인지 — 칸 하나가 깨졌으면 통째로 버린다(틀린 숫자보다 빈 칸). */
export function parseBasis(raw: unknown): JournalBasis | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const numOrNull = (v: unknown): number | null | undefined =>
    v === null ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  const entry_price = numOrNull(b.entry_price);
  const notional = numOrNull(b.notional);
  const leverage = numOrNull(b.leverage);
  const stop_price = numOrNull(b.stop_price);
  const unrealized_pnl = numOrNull(b.unrealized_pnl);
  if ([entry_price, notional, leverage, stop_price, unrealized_pnl].some((v) => v === undefined)) return null;

  if (!Array.isArray(b.tp_prices)) return null;
  const tp_prices = b.tp_prices.map(numOrNull);
  if (tp_prices.some((v) => v === undefined)) return null;

  let fill: JournalBasis['fill'] = null;
  if (b.fill !== null && b.fill !== undefined) {
    if (typeof b.fill !== 'object') return null;
    const f = b.fill as Record<string, unknown>;
    const price = numOrNull(f.price);
    const amount = numOrNull(f.amount);
    if (typeof f.filled_at !== 'string' || price === null || price === undefined || amount === undefined) return null;
    fill = { filled_at: f.filled_at, price, amount };
  }

  let changes: JournalBasis['changes'] = null;
  if (b.changes !== null && b.changes !== undefined) {
    if (!Array.isArray(b.changes)) return null;
    changes = [];
    for (const item of b.changes) {
      if (typeof item !== 'object' || item === null) return null;
      const c = item as Record<string, unknown>;
      const from = numOrNull(c.from);
      const to = numOrNull(c.to);
      if (typeof c.label !== 'string' || from === undefined || to === undefined) return null;
      changes.push({ label: c.label, from, to });
    }
  }

  return {
    entry_price: entry_price as number | null,
    notional: notional as number | null,
    leverage: leverage as number | null,
    stop_price: stop_price as number | null,
    tp_prices: tp_prices as (number | null)[],
    unrealized_pnl: unrealized_pnl as number | null,
    fill,
    changes,
  };
}
