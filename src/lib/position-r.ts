/**
 * 포지션 흐름 — 책 표 3-6 처럼 단계마다 R·E·CR·잠긴 R·미실현·누적 확정이 어떻게 바뀌는지 (REQ-0090).
 *
 * 정본 명세: Claude Docs 「R·트레이딩 엣지·CR·E 서비스 반영 명세」 계산 예시 ③.
 * 책 표 3-5: R = 처음 감수한 위험(고정) · CR = 지금 남아 있는 위험 · E = 현재 포지션의 크기.
 *
 * 재료는 두 가지다. 체결(진입·추가·부분 청산·청산 — 정확한 시각)과 동기화 스냅샷(수량·평단·시세·손절 —
 * 동기화 시각). 계산값은 저장하지 않는다 — 식을 고쳐도 기록을 다시 쓸 필요가 없게.
 *
 * - 1E 수량 = 기준 R ÷ 최초 손절폭 d₀ (d₀ = |첫 진입가 − 최초 손절|)
 * - E = 현재 수량 ÷ 1E 수량
 * - CR = (평단 − 현재 손절) × 수량 ÷ 기준 R, 음수면 0 (숏은 부호 반대). 음수 몫은 잠긴 R
 *   — OKX 는 포지션당 손절이 하나라 평균단가 식으로 잰다(손절이 하나면 랏별 합과 같다, 명세)
 * - 미실현 = (가격 − 평단) × 수량 ÷ 기준 R
 * - 누적 확정 = 청산 체결의 (청산가 − 평단) × 수량 합 ÷ 기준 R — **가격만**(책 정의). 수수료는 화면이 따로 보인다
 */
import type { Side } from '@/lib/domain';

type Maybe = number | null;

export interface FlowFill {
  atMs: number;
  role: 'open' | 'close';
  price: number;
  /** 코인 수량 */
  qty: number;
}

export interface FlowSnapshot {
  atMs: number;
  /** 코인 수량 */
  qty: number;
  avgPx: number;
  /** 동기화 순간 시세 — 없으면 null */
  markPx: Maybe;
  /** 그 순간 걸려 있던 손절 — 없으면 null */
  stopPx: Maybe;
}

export type StageKind = 'entry' | 'add' | 'stop_move' | 'stop_widen' | 'partial' | 'close' | 'resync' | 'now';

export const STAGE_LABEL: Record<StageKind, string> = {
  entry: '진입',
  add: '추가',
  stop_move: '손절 이동',
  stop_widen: '손절 확대',
  partial: '부분 청산',
  close: '청산',
  resync: '수량 변화',
  now: '현재',
};

export interface Stage {
  kind: StageKind;
  atMs: number;
  /** 그 단계의 가격 — 체결가, 스냅샷 시세, 현재가 */
  price: Maybe;
  /** 단계 뒤 상태 */
  qty: number;
  avgPx: number;
  stopPx: Maybe;
  /** 최초 위험 ÷ 기준 R — 진입 때 정해져 바뀌지 않는다 */
  r: Maybe;
  e: Maybe;
  cr: Maybe;
  lockedR: Maybe;
  unrealizedR: Maybe;
  realizedR: number;
  /** 이 단계에서 CR 이 진입 때보다 커졌나(위험 증가) */
  riskUp: boolean;
}

export interface FlowInput {
  side: Side;
  /** 진입 시점 기준 R(USDT) */
  rBase: number;
  /** 최초 손절 — 없으면 E·R 을 잴 수 없다 */
  stop0: Maybe;
  fills: readonly FlowFill[];
  snapshots: readonly FlowSnapshot[];
  /** 「현재」 열 — 보유 중일 때만. 가격이 없으면 미실현을 비운다 */
  now?: { atMs: number; price: Maybe; qty: number; avgPx: number; stopPx: Maybe } | null;
}

export interface Flow {
  stages: Stage[];
  /** 1E 수량 */
  oneE: Maybe;
  maxCr: Maybe;
  maxE: Maybe;
  /** 가격 기준 확정 손익(USDT) */
  realizedUsd: number;
}

const EPS = 1e-9;
/** 같은 역할의 체결이 이 시간 안에 이어지면 한 단계로 묶는다 — 주문 하나가 여러 체결로 쪼개진다. */
const MERGE_MS = 60_000;

/** 체결을 시간순으로 놓고, 같은 역할의 잇단 체결은 묶는다(가중 평균가). */
export function mergeFills(fills: readonly FlowFill[]): FlowFill[] {
  const out: FlowFill[] = [];
  for (const f of [...fills].sort((a, b) => a.atMs - b.atMs)) {
    const last = out[out.length - 1];
    if (last && last.role === f.role && f.atMs - last.atMs <= MERGE_MS) {
      const qty = last.qty + f.qty;
      out[out.length - 1] = { ...last, price: (last.price * last.qty + f.price * f.qty) / qty, qty };
    } else {
      out.push({ ...f });
    }
  }
  return out;
}

const near = (a: Maybe, b: Maybe, tol: number) =>
  a === null || b === null ? a === b : Math.abs(a - b) <= tol * Math.max(1, Math.abs(a));

export function buildFlow(input: FlowInput): Flow {
  const { side, rBase, stop0 } = input;
  const dir = side === 'long' ? 1 : -1;
  const fills = mergeFills(input.fills.filter((f) => f.qty > 0 && f.price > 0));
  const firstOpen = fills.find((f) => f.role === 'open') ?? null;
  const entry0 = firstOpen?.price ?? input.snapshots[0]?.avgPx ?? input.now?.avgPx ?? null;
  const d0 = entry0 !== null && stop0 !== null ? dir * (entry0 - stop0) : null;
  const oneE = d0 !== null && d0 > 0 ? rBase / d0 : null;

  let qty = 0;
  let avg = 0;
  let stop: Maybe = stop0;
  let realizedUsd = 0;
  let rFixed: Maybe = null;
  let cr0: Maybe = null;
  const stages: Stage[] = [];

  const push = (kind: StageKind, atMs: number, price: Maybe) => {
    const crRaw = stop === null || qty <= EPS ? (qty <= EPS ? 0 : null) : (dir * (avg - stop) * qty) / rBase;
    const cr = crRaw === null ? null : Math.max(0, crRaw);
    if (kind === 'entry') {
      rFixed = cr;
      cr0 = cr;
    }
    stages.push({
      kind,
      atMs,
      price,
      qty,
      avgPx: avg,
      stopPx: stop,
      r: rFixed,
      e: oneE === null ? null : qty / oneE,
      cr,
      lockedR: crRaw === null ? null : Math.max(0, -crRaw),
      unrealizedR: price === null || qty <= EPS ? (qty <= EPS ? 0 : null) : (dir * (price - avg) * qty) / rBase,
      realizedR: realizedUsd / rBase,
      riskUp: cr !== null && cr0 !== null && cr > cr0 + 1e-6,
    });
  };

  type Ev = { atMs: number; order: number; fill?: FlowFill; snap?: FlowSnapshot };
  const events: Ev[] = [
    ...fills.map((f) => ({ atMs: f.atMs, order: 0, fill: f })),
    ...input.snapshots.map((s) => ({ atMs: s.atMs, order: 1, snap: s })),
  ].sort((a, b) => a.atMs - b.atMs || a.order - b.order);

  for (const ev of events) {
    if (ev.fill) {
      const f = ev.fill;
      if (f.role === 'open') {
        const first = qty <= EPS;
        avg = first ? f.price : (avg * qty + f.price * f.qty) / (qty + f.qty);
        qty += f.qty;
        push(first && stages.length === 0 ? 'entry' : 'add', f.atMs, f.price);
      } else {
        const q = Math.min(f.qty, qty);
        realizedUsd += dir * (f.price - avg) * q;
        qty = Math.max(0, qty - q);
        push(qty <= EPS ? 'close' : 'partial', f.atMs, f.price);
      }
      continue;
    }
    const s = ev.snap!;
    if (stages.length === 0) {
      // 체결 기록이 없는 포지션 — 첫 스냅샷을 진입으로 본다.
      qty = s.qty;
      avg = s.avgPx;
      if (s.stopPx !== null && stop === null) stop = s.stopPx;
      push('entry', s.atMs, s.markPx ?? s.avgPx);
      continue;
    }
    const qtyChanged = !near(s.qty, qty, 1e-6) || !near(s.avgPx, avg, 1e-6);
    const stopChanged = !near(s.stopPx, stop, 1e-9);
    if (!qtyChanged && !stopChanged) continue;
    const prevRisk = stop === null ? null : dir * (avg - stop);
    if (qtyChanged) {
      qty = s.qty;
      avg = s.avgPx;
    }
    stop = s.stopPx;
    const nextRisk = stop === null ? null : dir * (avg - stop);
    const kind: StageKind = qtyChanged
      ? 'resync'
      : prevRisk !== null && nextRisk !== null && nextRisk > prevRisk + EPS
        ? 'stop_widen'
        : 'stop_move';
    push(kind, s.atMs, s.markPx);
  }

  if (input.now) {
    const n = input.now;
    if (!near(n.qty, qty, 1e-6) || !near(n.avgPx, avg, 1e-6)) {
      qty = n.qty;
      avg = n.avgPx;
    }
    stop = n.stopPx;
    if (stages.length === 0) push('entry', n.atMs, n.price ?? n.avgPx);
    push('now', n.atMs, n.price);
  }

  const crs = stages.map((s) => s.cr).filter((v): v is number => v !== null);
  const es = stages.map((s) => s.e).filter((v): v is number => v !== null);
  return {
    stages,
    oneE,
    maxCr: crs.length > 0 ? Math.max(...crs) : null,
    maxE: es.length > 0 ? Math.max(...es) : null,
    realizedUsd,
  };
}

/** 직전 스냅샷과 수량·평단·손절이 모두 같은가 — 같으면 동기화가 새 줄을 남기지 않는다(시세만 다른 건 단계가 아니다). */
export function sameSnapshot(
  prev: Pick<FlowSnapshot, 'qty' | 'avgPx' | 'stopPx'> | null,
  next: Pick<FlowSnapshot, 'qty' | 'avgPx' | 'stopPx'>,
): boolean {
  if (prev === null) return false;
  return near(prev.qty, next.qty, 1e-6) && near(prev.avgPx, next.avgPx, 1e-6) && near(prev.stopPx, next.stopPx, 1e-9);
}
