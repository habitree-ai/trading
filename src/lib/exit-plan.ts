/**
 * 분할 청산 — 계획과 실적.
 *
 * 계획은 손으로 적은 손절·TP1~3 가격과 비중에서, 실적은 청산 체결에서 만든다. 둘을 한 모듈에
 * 두는 이유는 산식(가격폭·금액·증거금 대비·R)이 같아야 한 화면에 나란히 놓였을 때 비교가 되기
 * 때문이다. 순수 함수만 — DB도 화면도 모른다.
 *
 * 분모는 둘이다. 금액은 명목가 × 가격폭 × 비중(손익 툴 관례), 수익률은 금액 ÷ 증거금(표의
 * 손익률 관례). 100배 레버리지면 100배 차이가 나므로 화면은 둘을 다른 열에 두고 라벨로 밝힌다.
 *
 * "사다리"라는 말은 쓰지 않는다 — 이 저장소에서 사다리는 승격 사다리(리스크 단계)를 뜻한다.
 */

import type { Side, Trade, TradeFill } from '@/lib/domain';
import { PROBLEM } from '@/lib/position-tool';

const EPS = 1e-6;

/** 화면에 선 값이 어디서 왔는지 — 거래소에 걸려 있던 값이면 'okx', 손으로 적은 계획이면 'plan'. */
export type LevelSource = 'plan' | 'okx';
/** 비중이 어디서 왔는지 — 적은 값 / 셋 다 비어 균등 / 다른 단만 적혀 0. */
export type ShareSource = 'explicit' | 'even' | 'zero';
export type ExitMode = 'plan' | 'plan-with-actual' | 'actual-with-plan';

export interface StopLeg {
  price: number;
  source: LevelSource;
  /** 거래소 값이 섰을 때 옆에 적을 계획값. 계획이 섰으면 null */
  planPrice: number | null;
  /** 진입가 대비 손절까지의 폭 — 양수 */
  riskPct: number | null;
  /** 명목가 기준 손실 — 음수 */
  lossAmount: number | null;
  /** 증거금 대비 — 음수 */
  returnPct: number | null;
  problem: string | null;
}

export interface PlanStep {
  n: 1 | 2 | 3;
  price: number;
  /** TP1만 거래소 값이 될 수 있다 — 거래소 익절은 하나뿐이다 */
  source: LevelSource;
  planPrice: number | null;
  /** 0~1 */
  share: number;
  shareSource: ShareSource;
  /** 진입가 대비 폭 — 부호 있음. 반대쪽이면 음수 */
  movePct: number | null;
  /** 명목가 × 폭 × 비중 */
  amount: number | null;
  /** 금액 ÷ 증거금 */
  returnPct: number | null;
  /** 폭 ÷ 계획 손절폭 — 부호 있음 */
  r: number | null;
  problem: string | null;
}

export interface ExitPlan {
  entry: number | null;
  stop: StopLeg | null;
  /** R을 무엇 기준으로 쟀는지 — 계획 손절이 없을 때만 거래소 최종 손절로 대신한다 */
  rBasis: LevelSource | null;
  steps: PlanStep[];
  shareSum: number | null;
  shareProblem: string | null;
  orderProblem: string | null;
  total: { amount: number | null; returnPct: number | null; blendedR: number | null };
}

export interface PositionSize {
  /** 원래 진입 수량(계약 × 승수). 명목가 ÷ 진입가와 같은 단위 */
  qty: number | null;
  /** 원래 진입 명목가 */
  notional: number | null;
  source: 'open_fills' | 'notional' | 'notional+closed' | null;
}

export interface ActualStep {
  /** 1부터 — 청산 주문 순서 */
  n: number;
  /** 그 차수 첫 체결 시각 */
  at: string;
  fillCount: number;
  /** 수량 가중 평균 체결가. 금액이 비면 단순 평균 */
  price: number;
  qty: number | null;
  /** 원래 진입 수량 대비 */
  share: number | null;
  movePct: number | null;
  /** 가격손익 — 비용 전 */
  pnl: number | null;
  /** 그 차수 체결 수수료 합 */
  fee: number | null;
  returnPct: number | null;
  r: number | null;
  /** 체결 금액을 모르는 건이 섞였거나 청산가 한 점으로 되짚은 값 */
  estimated: boolean;
}

export interface ExitActual {
  source: 'fills' | 'exit_price';
  steps: ActualStep[];
  entryQty: number | null;
  entryQtySource: PositionSize['source'];
  closedShare: number | null;
  /** 아직 들고 있는 몫 — 닫힌 거래는 0 */
  remainingShare: number | null;
  pnlTotal: number | null;
  closeFeeTotal: number | null;
  estimated: boolean;
}

/** 한 거래의 청산 계획·실적을 화면이 한 번에 받는 묶음. */
export interface ExitSummary {
  open: boolean;
  size: PositionSize;
  plan: ExitPlan;
  actual: ExitActual | null;
  mode: ExitMode;
}

/* ── 공통 ─────────────────────────────────────────────────── */

function validPrice(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

/** 캡쳐 경로는 금액을 모르면 0을 넣는다 — 0은 '없음'으로 읽는다. */
function validAmount(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

function entryOf(trade: Pick<Trade, 'entry_price'>): number | null {
  return validPrice(trade.entry_price) ? trade.entry_price : null;
}

function directionOf(side: Side): 1 | -1 {
  return side === 'long' ? 1 : -1;
}

function absNotional(value: number | null): number | null {
  return value === null || !Number.isFinite(value) || value === 0 ? null : Math.abs(value);
}

/** 증거금 — `marginOf`(metrics)와 같은 산식. 여기서는 원래 크기의 명목가를 넣는다. */
export function marginFor(notional: number | null, leverage: number | null): number | null {
  if (notional === null) return null;
  const lever = leverage === null || leverage === 0 ? 1 : Math.abs(leverage);
  return notional / lever;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

function fmtPct(share: number): string {
  return String(Math.round(share * 1000) / 10);
}

/* ── 계획 ─────────────────────────────────────────────────── */

/**
 * 활성 TP 가격 — 계획과 폼 경고가 같은 판정을 쓰기 위한 한 곳.
 *
 * TP1 자리는 거래소에 걸려 있던 익절이 먼저다. 손으로 적지 않았어도 거래소에 걸었으면
 * 그 단은 살아 있다 — 비중만 적은 거래에서 폼과 카드가 다른 말을 하지 않게.
 */
export function activeTargetPrices(
  trade: Pick<Trade, 'tp1_price' | 'tp2_price' | 'tp3_price' | 'okx_tp_price'>,
): [number | null, number | null, number | null] {
  const pick = (v: number | null): number | null => (v !== null && Number.isFinite(v) ? v : null);
  return [pick(trade.okx_tp_price ?? trade.tp1_price), pick(trade.tp2_price), pick(trade.tp3_price)];
}

export interface ResolvedShares {
  /** 가격 없는 단은 null */
  shares: [number | null, number | null, number | null];
  sources: [ShareSource | null, ShareSource | null, ShareSource | null];
  sum: number | null;
  problem: string | null;
}

/**
 * 비중 확정 — 셋 다 비면 가격 있는 TP 수로 균등, 하나라도 적혀 있으면 빈 칸은 0.
 *
 * 정규화하지 않는다. 합이 100이 아니면 그대로 두고 문구만 낸다 — 50/20을 나중에 마저
 * 적으려던 사람에게 균등이 조용히 들어가면 안 된다. 가격 없는 단의 비중은 무시한다.
 */
export function resolveShares(
  prices: readonly (number | null)[],
  pcts: readonly (number | null)[],
): ResolvedShares {
  const active = [0, 1, 2].filter((i) => prices[i] !== null && prices[i] !== undefined);
  const shares: ResolvedShares['shares'] = [null, null, null];
  const sources: ResolvedShares['sources'] = [null, null, null];
  if (active.length === 0) return { shares, sources, sum: null, problem: null };

  const explicit = active.filter((i) => pcts[i] !== null && pcts[i] !== undefined);
  for (const i of active) {
    if (explicit.length === 0) {
      shares[i] = 1 / active.length;
      sources[i] = 'even';
    } else if (explicit.includes(i)) {
      shares[i] = (pcts[i] as number) / 100;
      sources[i] = 'explicit';
    } else {
      shares[i] = 0;
      sources[i] = 'zero';
    }
  }

  const sum = active.reduce((a, i) => a + (shares[i] ?? 0), 0);
  let problem: string | null = null;
  if (sum > 1 + EPS) problem = `비율 합이 ${fmtPct(sum)}% 로 100% 를 넘습니다`;
  else if (sum < 1 - EPS)
    problem = `비율 합이 ${fmtPct(sum)}% 입니다 — 나머지 ${fmtPct(1 - sum)}% 는 계획에 없습니다`;

  return { shares, sources, sum, problem };
}

/**
 * 폼 경고 — 저장을 막지 않는다. 범위 밖만 서버가 따로 거른다.
 * 값은 폼 문자열을 숫자로 바꾼 것이라 % 단위 그대로 받는다.
 */
export function checkTpSplit(input: {
  prices: readonly (number | null)[];
  pcts: readonly (number | null)[];
}): string | null {
  const { prices, pcts } = input;
  for (let i = 0; i < 3; i += 1) {
    const pct = pcts[i] ?? null;
    if (pct === null) continue;
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return `TP${i + 1} 비율은 0 초과 100 이하여야 합니다`;
    }
    if (prices[i] === null || prices[i] === undefined) {
      return `TP${i + 1} 은 가격이 없는데 비율만 있습니다`;
    }
  }
  return resolveShares(prices, pcts).problem;
}

function qtyOf(fill: Pick<TradeFill, 'price' | 'amount'>): number | null {
  return validAmount(fill.amount) && validPrice(fill.price) ? fill.amount / fill.price : null;
}

/**
 * 원래 진입 크기.
 *
 * 열린 OKX 거래의 `notional`은 **남은** 물량이다(map.ts toOpenUpdate가 매 동기화마다
 * `avgPx × |pos|`로 덮어쓴다). 부분청산 뒤에 그대로 쓰면 계획 금액이 줄어들고 청산 비중은
 * 부풀어 오른다 — 절반을 덜어낸 거래가 "100% 청산"으로 보인다. 닫힌 OKX 거래의 `notional`은
 * 총량이라 정확하고, 수기·캡쳐 거래는 폼의 '투입'이 원래 크기다.
 */
export function positionSize(
  trade: Pick<Trade, 'entry_price' | 'notional' | 'okx_pos_id'>,
  fills: readonly TradeFill[],
  open: boolean,
): PositionSize {
  const entry = entryOf(trade);
  const notional = absNotional(trade.notional);
  if (entry === null) return { qty: null, notional, source: null };

  const opens = fills.filter((f) => f.role === 'open');
  const openQtys = opens.map(qtyOf);
  const fromOpenFills =
    opens.length > 0 && openQtys.every((q) => q !== null)
      ? openQtys.reduce<number>((a, q) => a + (q as number), 0)
      : null;

  // 닫힌 거래와 수기 거래는 notional 이 원래 크기다. 체결은 없을 때의 대안일 뿐이다 —
  // 체결은 커서 이후만 받아 진입분이 일부만 남아 있을 수 있다.
  if (!open || trade.okx_pos_id === null) {
    if (notional !== null) return { qty: notional / entry, notional, source: 'notional' };
    if (fromOpenFills !== null) {
      return { qty: fromOpenFills, notional: fromOpenFills * entry, source: 'open_fills' };
    }
    return { qty: null, notional: null, source: null };
  }

  // 열린 OKX 거래 — 진입 체결이 다 있으면 그것이 원래 크기다(열린 포지션은 개설 시각까지 되짚어 받는다).
  if (fromOpenFills !== null) {
    return { qty: fromOpenFills, notional: fromOpenFills * entry, source: 'open_fills' };
  }
  if (notional === null) return { qty: null, notional: null, source: null };

  const closeQtys = fills.filter((f) => f.role === 'close').map(qtyOf);
  if (closeQtys.some((q) => q === null)) {
    // 덜어낸 양을 모르면 되돌릴 수 없다 — 남은 크기 그대로 두고 화면이 "보유분 기준"이라 밝힌다.
    return { qty: null, notional, source: null };
  }
  const qty = notional / entry + closeQtys.reduce<number>((a, q) => a + (q as number), 0);
  return { qty, notional: qty * entry, source: 'notional+closed' };
}

function stepProblem(side: Side, price: number, movePct: number | null): string | null {
  if (!validPrice(price)) return '가격이 0 이하입니다';
  if (movePct !== null && movePct < 0) return PROBLEM[side];
  return null;
}

/** 손으로 적은 손절·TP와 비중에서 계획을 세운다. `size`가 없으면 거래 행의 명목가를 쓴다. */
export function buildExitPlan(trade: Trade, size?: PositionSize | null): ExitPlan {
  const entry = entryOf(trade);
  const d = directionOf(trade.side);
  const notional = size?.notional ?? absNotional(trade.notional);
  const margin = marginFor(notional, trade.leverage);

  // 손절 — 거래소에 걸려 있던 값이 먼저 선다. 계획은 옆에 남긴다.
  let stop: StopLeg | null = null;
  const stopPrice = trade.okx_stop_price ?? trade.stop_price;
  if (stopPrice !== null && Number.isFinite(stopPrice)) {
    const source: LevelSource = trade.okx_stop_price !== null ? 'okx' : 'plan';
    const riskPct = entry === null ? null : Math.abs(entry - stopPrice) / entry;
    const lossAmount = riskPct === null || notional === null ? null : -riskPct * notional;
    let problem: string | null = null;
    if (!validPrice(stopPrice)) problem = '가격이 0 이하입니다';
    else if (entry !== null && d * (stopPrice - entry) >= 0) problem = PROBLEM[trade.side];
    stop = {
      price: stopPrice,
      source,
      planPrice: source === 'okx' ? trade.stop_price : null,
      riskPct,
      lossAmount,
      returnPct: ratio(lossAmount, margin),
      problem,
    };
  }

  // R의 기준은 계획 손절이다. 거래소 값은 마지막에 등록된 것이라 진입 당시 리스크가 아니다 —
  // 계획이 없을 때만 그것으로 대신하고 기준을 남긴다.
  const rBasisPrice = trade.stop_price ?? trade.okx_stop_price;
  const rBasis: LevelSource | null =
    trade.stop_price !== null ? 'plan' : trade.okx_stop_price !== null ? 'okx' : null;
  const riskPlanRaw =
    entry !== null && rBasisPrice !== null && validPrice(rBasisPrice)
      ? Math.abs(entry - rBasisPrice) / entry
      : null;
  const riskPlan = riskPlanRaw === null || riskPlanRaw === 0 ? null : riskPlanRaw;

  const prices = activeTargetPrices(trade);
  const resolved = resolveShares(prices, [trade.tp1_pct, trade.tp2_pct, trade.tp3_pct]);

  const steps: PlanStep[] = [];
  for (const i of [0, 1, 2] as const) {
    const price = prices[i];
    if (price === null) continue;
    const source: LevelSource = i === 0 && trade.okx_tp_price !== null ? 'okx' : 'plan';
    const share = resolved.shares[i] ?? 0;
    const movePct = entry === null ? null : (d * (price - entry)) / entry;
    const amount = movePct === null || notional === null ? null : movePct * notional * share;
    steps.push({
      n: (i + 1) as 1 | 2 | 3,
      price,
      source,
      planPrice: source === 'okx' ? trade.tp1_price : null,
      share,
      shareSource: resolved.sources[i] ?? 'zero',
      movePct,
      amount,
      returnPct: ratio(amount, margin),
      r: movePct === null || riskPlan === null ? null : movePct / riskPlan,
      problem: stepProblem(trade.side, price, movePct),
    });
  }

  // 순서 — 롱은 TP1 < TP2 < TP3, 숏은 그 반대여야 차수가 뜻을 갖는다.
  let orderProblem: string | null = null;
  for (let i = 1; i < steps.length; i += 1) {
    if (d * (steps[i].price - steps[i - 1].price) <= 0) {
      orderProblem = 'TP 순서가 뒤바뀌었습니다';
      break;
    }
  }

  const amounts = steps.map((s) => s.amount);
  const returns = steps.map((s) => s.returnPct);
  const weightedR = steps.map((s) => (s.r === null ? null : s.share * s.r));

  return {
    entry,
    stop,
    rBasis,
    steps,
    shareSum: resolved.sum,
    shareProblem: resolved.problem,
    orderProblem,
    total: {
      amount: sumOrNull(amounts),
      returnPct: sumOrNull(returns),
      blendedR: sumOrNull(weightedR),
    },
  };
}

/* ── 실적 ─────────────────────────────────────────────────── */

/**
 * 청산 체결을 사람이 보는 '차수'로 묶는다 — 한 주문이 여러 체결로 쪼개져도 한 차수다.
 *
 * 순서는 각 묶음의 첫 체결 시각. 주문번호가 없는 체결(캡쳐 경로)은 낱개가 한 차수다.
 * 차트의 청산 마커도 이 함수를 써서 번호가 어긋나지 않게 한다.
 */
export function groupCloseFills(fills: readonly TradeFill[]): TradeFill[][] {
  const groups = new Map<string, TradeFill[]>();
  for (const fill of fills) {
    if (fill.role !== 'close') continue;
    const key = fill.order_no ?? `fill:${fill.id}`;
    const group = groups.get(key);
    if (group) group.push(fill);
    else groups.set(key, [fill]);
  }
  const startMs = (group: TradeFill[]) =>
    Math.min(...group.map((f) => Date.parse(f.filled_at)));
  return [...groups.values()]
    .map((group) => [...group].sort((a, b) => Date.parse(a.filled_at) - Date.parse(b.filled_at)))
    .sort((a, b) => startMs(a) - startMs(b) || a[0].id.localeCompare(b[0].id));
}

/**
 * 청산 체결에서 실적을 만든다.
 *
 * 체결에는 손익이 없다 — 가격과 금액뿐이다. 그래서 손익은 평균 진입가 대비로 되짚은
 * **추정**이고, 장부의 실현손익(realized_pnl)과는 수수료·펀딩비·ADL만큼 어긋난다.
 * 그 값은 여기서 읽지 않는다 — 부분청산 확정분이 이미 그 안에 있어, 여기서 또 더하면
 * 같은 돈이 두 번 잡힌다. 대조는 화면 몫이다.
 */
export function buildExitActual(
  trade: Trade,
  fills: readonly TradeFill[],
  open: boolean,
  size: PositionSize,
): ExitActual | null {
  const entry = entryOf(trade);
  const d = directionOf(trade.side);
  const margin = marginFor(size.notional, trade.leverage);
  const stopBasis = trade.stop_price ?? trade.okx_stop_price;
  const riskPlanRaw =
    entry !== null && stopBasis !== null && validPrice(stopBasis)
      ? Math.abs(entry - stopBasis) / entry
      : null;
  const riskPlan = riskPlanRaw === null || riskPlanRaw === 0 ? null : riskPlanRaw;

  const describe = (input: {
    n: number;
    at: string;
    fillCount: number;
    price: number;
    qty: number | null;
    fee: number | null;
    estimated: boolean;
  }): ActualStep => {
    const movePct = entry === null ? null : (d * (input.price - entry)) / entry;
    const pnl = entry === null || input.qty === null ? null : d * (input.price - entry) * input.qty;
    return {
      ...input,
      share: ratio(input.qty, size.qty),
      movePct,
      pnl,
      returnPct: ratio(pnl, margin),
      r: movePct === null || riskPlan === null ? null : movePct / riskPlan,
    };
  };

  const groups = groupCloseFills(fills);
  let source: ExitActual['source'] = 'fills';
  let steps: ActualStep[];

  if (groups.length === 0) {
    if (open || !validPrice(trade.exit_price)) return null;
    // 체결이 없는 닫힌 거래 — 청산가 한 점이 유일한 근거다. 수수료는 진입분과 섞여 있어 넣지 않는다.
    source = 'exit_price';
    steps = [
      describe({
        n: 1,
        at: trade.exit_at ?? trade.entry_at,
        fillCount: 1,
        price: trade.exit_price,
        qty: size.qty,
        fee: null,
        estimated: true,
      }),
    ];
  } else {
    steps = groups.map((group, index) => {
      const qtys = group.map(qtyOf);
      const complete = qtys.every((q) => q !== null);
      const qty = complete ? qtys.reduce((a, q) => a + (q as number), 0) : null;
      const price =
        complete && qty !== null && qty > 0
          ? group.reduce((a, f) => a + (f.amount as number), 0) / qty
          : group.reduce((a, f) => a + f.price, 0) / group.length;
      return describe({
        n: index + 1,
        at: group[0].filled_at,
        fillCount: group.length,
        price,
        qty,
        fee: sumOrNull(group.map((f) => f.fee)),
        estimated: !complete,
      });
    });
  }

  const closedShare = sumOrNull(steps.map((s) => s.share));
  return {
    source,
    steps,
    entryQty: size.qty,
    entryQtySource: size.source,
    closedShare,
    remainingShare: !open ? 0 : closedShare === null ? null : Math.max(0, 1 - closedShare),
    pnlTotal: sumOrNull(steps.map((s) => s.pnl)),
    closeFeeTotal: sumOrNull(steps.map((s) => s.fee)),
    estimated: source === 'exit_price' || steps.some((s) => s.estimated),
  };
}

/** 어느 쪽을 앞세울지 — 들고 있으면 계획, 닫혔으면 실적. 부분청산이 있으면 둘 다. */
export function exitMode(open: boolean, actual: ExitActual | null): ExitMode {
  if (!open) return 'actual-with-plan';
  return actual === null || actual.steps.length === 0 ? 'plan' : 'plan-with-actual';
}

/**
 * 단계 하나 — 이미 체결된 몫이면 실현값, 아직이면 등록된 TP 가격 기준 예상치.
 *
 * 살아 있는 거래를 볼 때 "1차는 얼마 벌었고 2차는 얼마를 기대하나"가 한 줄씩 이어져야
 * 한다. 계획과 실적을 따로 두면 그 이야기가 두 표로 갈린다.
 */
export interface ExitStage {
  /** 1부터 — 체결된 차수가 먼저, 그 뒤가 예상 */
  n: number;
  kind: 'filled' | 'expected' | 'empty';
  /** 예상 단계가 어느 TP 가격에서 왔는지. 체결·빈 단계는 null */
  tp: 1 | 2 | 3 | null;
  price: number | null;
  share: number | null;
  /** 진입가 대비 수익률 — 부호 있음 */
  movePct: number | null;
  /** 수익금 — 체결이면 실현(가격손익), 예상이면 명목가 × 폭 × 비중 */
  pnl: number | null;
  /** 증거금 대비 */
  returnPct: number | null;
  r: number | null;
  at: string | null;
  estimated: boolean;
  source: LevelSource | null;
  problem: string | null;
}

const EMPTY_STAGE = {
  tp: null,
  price: null,
  share: null,
  movePct: null,
  pnl: null,
  returnPct: null,
  r: null,
  at: null,
  estimated: false,
  source: null,
  problem: null,
} as const;

/**
 * 체결된 차수 뒤에 남은 계획을 이어 붙인다.
 *
 * 체결 수만큼 계획의 앞 단을 소진한 것으로 본다 — 1차가 체결됐으면 다음 예상은 TP2 다.
 * 들고 있는 거래는 세 자리를 늘 채운다(빈 단은 `empty`). 닫힌 거래는 체결만 남긴다 —
 * 이미 끝난 거래에 예상치는 없다.
 */
export function mergeStages(summary: ExitSummary): ExitStage[] {
  const filled = summary.actual?.steps ?? [];
  const stages: ExitStage[] = filled.map((s) => ({
    n: s.n,
    kind: 'filled',
    tp: null,
    price: s.price,
    share: s.share,
    movePct: s.movePct,
    pnl: s.pnl,
    returnPct: s.returnPct,
    r: s.r,
    at: s.at,
    estimated: s.estimated,
    source: null,
    problem: null,
  }));
  if (!summary.open) return stages;

  for (const p of summary.plan.steps.slice(filled.length)) {
    stages.push({
      n: stages.length + 1,
      kind: 'expected',
      tp: p.n,
      price: p.price,
      share: p.share,
      movePct: p.movePct,
      pnl: p.amount,
      returnPct: p.returnPct,
      r: p.r,
      at: null,
      estimated: false,
      source: p.source,
      problem: p.problem,
    });
  }
  while (stages.length < 3) stages.push({ n: stages.length + 1, kind: 'empty', ...EMPTY_STAGE });
  return stages;
}

/** 화면이 부르는 한 줄 — 크기·계획·실적·모드를 한 번에. 체결을 안 넘기면 실적은 청산가 폴백만. */
export function summarizeExits(
  trade: Trade,
  fills: readonly TradeFill[],
  open: boolean,
): ExitSummary {
  const size = positionSize(trade, fills, open);
  const actual = buildExitActual(trade, fills, open, size);
  return {
    open,
    size,
    plan: buildExitPlan(trade, size),
    actual,
    mode: exitMode(open, actual),
  };
}
