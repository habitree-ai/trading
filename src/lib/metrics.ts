/**
 * 지표 엔진 — 구글시트 KPI 블록을 재현한 순수 함수 모듈.
 *
 * 시트 수식을 역산해 3개 탭에서 일치를 확인한 산식:
 *   이익기대치 = 승률 × 손익비
 *   손실기대치 = 패률
 *   기대치값   = 이익기대치 − 손실기대치   (R 단위 기대값)
 *
 * ⚠️ `손익비`는 시트 탭마다 수식이 달라(7.62 / 12.57 / 12.79 …) 재현이 불가능했다.
 *    표준 payoff ratio(평균수익 ÷ 평균손실)로 통일한다.
 */

import type { Book, Trade } from '@/lib/domain';

/** 표본이 없어 정의되지 않는 지표는 null로 돌려준다 — 0과 구분하기 위해. */
type Maybe = number | null;

function ratio(numerator: number, denominator: number): Maybe {
  return denominator === 0 || !Number.isFinite(denominator)
    ? null
    : numerator / denominator;
}

function mean(values: readonly number[]): Maybe {
  return values.length === 0
    ? null
    : values.reduce((a, b) => a + b, 0) / values.length;
}

/** 거래 1건에서 계산되는 파생값 — 시트의 계산 컬럼들에 대응. */
export interface TradeDerived {
  trade: Trade;
  /**
   * 계좌가 실제로 움직인 금액 = 손익 + 거래 수수료 + 펀딩비.
   * OKX가 `Realized PnL`로 부르는 값이고, `pnl`(Closed PnL)은 비용 이전 총액이다.
   * 100배 레버리지에서 수수료는 손익의 10%에 육박해 무시할 수 없다.
   */
  net: number;
  /** 시트의 `자금` — 이 거래 직전 자금 */
  equityBefore: number;
  /** 시트의 `자금` — 이 거래 직후 자금 */
  equityAfter: number;
  /** 시트의 `누적 최고치` — 여기까지의 자금 최고치 */
  peak: number;
  /** 시트의 `MDD하락률` — (자금 − 최고치) / 최고치 */
  drawdownPct: number;
  /** 시트의 `L pnl`/`W pnl`을 통합 — 손익 / 진입 직전 자금 */
  pnlPct: Maybe;
  /** 시트의 `손실율` — |진입가 − 손절가| / 진입가 */
  riskPct: Maybe;
  /** 시트의 `1차수익율`~`3차수익율` — R 배수 */
  rr: [Maybe, Maybe, Maybe];
}

/**
 * 자금 곡선을 만든다.
 *
 * `equity_after`가 입력돼 있으면 그 값이 정본(거래소 화면에서 읽은 실측치).
 * 비어 있으면 직전 자금 + 손익 − 출금으로 이어 붙인다.
 */
export function deriveTrades(book: Book, trades: readonly Trade[]): TradeDerived[] {
  const sorted = [...trades].sort(
    (a, b) => Date.parse(a.entry_at) - Date.parse(b.entry_at) || a.seq - b.seq,
  );

  let running = book.initial_capital;
  let peak = book.initial_capital;

  return sorted.map((trade) => {
    const equityBefore = trade.equity_before ?? running;
    const net = (trade.pnl ?? 0) + (trade.fee ?? 0) + (trade.funding_fee ?? 0);
    const withdrawal = trade.withdrawal ?? 0;
    const equityAfter = trade.equity_after ?? equityBefore + net - withdrawal;

    running = equityAfter;
    peak = Math.max(peak, equityAfter);

    return {
      trade,
      net,
      equityBefore,
      equityAfter,
      peak,
      drawdownPct: peak === 0 ? 0 : (equityAfter - peak) / peak,
      pnlPct: trade.pnl === null ? null : ratio(net, equityBefore),
      riskPct: riskPct(trade),
      rr: [rrFor(trade, trade.tp1_price), rrFor(trade, trade.tp2_price), rrFor(trade, trade.tp3_price)],
    };
  });
}

/** 시트의 `손실율` — 진입가 대비 손절폭. */
export function riskPct(trade: Trade): Maybe {
  const { entry_price: entry, stop_price: stop } = trade;
  if (entry === null || stop === null || entry === 0) return null;
  return Math.abs(entry - stop) / Math.abs(entry);
}

/**
 * 손익 교차검증 — 명목가와 가격 변동으로 계산한 손익이 입력한 손익과 맞는지 본다.
 *
 * OCR이 숫자를 잘못 읽거나(0↔O, 자릿수 밀림) 방향을 반대로 잡으면 여기서 걸린다.
 * 수수료·부분청산 때문에 정확히 일치하지는 않으므로 넉넉한 허용치를 둔다.
 */
export interface PnlCrossCheck {
  expected: number;
  actual: number;
  /** 어긋난 정도 — |실제 − 기대| / |기대| */
  deviation: number;
  /** 부호가 반대인가 — 방향을 잘못 읽었을 때 나타난다. */
  signFlipped: boolean;
  ok: boolean;
}

export function crossCheckPnl(input: {
  side: 'long' | 'short';
  notional: number | null;
  entry_price: number | null;
  exit_price: number | null;
  pnl: number | null;
  /** 허용 오차 비율 — 기본 25%(수수료·부분청산 여유). */
  tolerance?: number;
}): PnlCrossCheck | null {
  const { side, notional, entry_price: entry, exit_price: exit, pnl, tolerance = 0.25 } = input;
  if (notional === null || entry === null || exit === null || pnl === null) return null;
  if (entry === 0 || notional === 0) return null;

  const direction = side === 'long' ? 1 : -1;
  const expected = notional * ((exit - entry) / entry) * direction;
  if (expected === 0) return null;

  const deviation = Math.abs(pnl - expected) / Math.abs(expected);
  const signFlipped = Math.sign(pnl) !== 0 && Math.sign(pnl) !== Math.sign(expected);

  return { expected, actual: pnl, deviation, signFlipped, ok: !signFlipped && deviation <= tolerance };
}

/** 시트의 `n차수익율` — 손절폭을 1R로 본 익절가까지의 R 배수. */
function rrFor(trade: Trade, target: number | null): Maybe {
  const { entry_price: entry, stop_price: stop } = trade;
  if (entry === null || stop === null || target === null) return null;
  const risk = Math.abs(entry - stop);
  if (risk === 0) return null;
  return Math.abs(target - entry) / risk;
}

/** 시트 상단 KPI 블록에 대응하는 집계 결과. */
export interface BookMetrics {
  /** 시트의 `총거래수` — 청산 완료 건만 */
  closedCount: number;
  openCount: number;
  /** 시트의 `승` */
  wins: number;
  /** 시트의 `패` */
  losses: number;
  breakEvens: number;
  /** 시트의 `승율` */
  winRate: Maybe;
  /** 시트의 `평균수익` */
  avgWin: Maybe;
  /** 시트의 `평균손실` — 양수로 표현 */
  avgLoss: Maybe;
  /** 시트의 `손익비` — 평균수익 ÷ 평균손실 (표준 payoff ratio로 재정의) */
  payoffRatio: Maybe;
  /** 시트의 `이익기대치` = 승률 × 손익비 */
  winExpectancy: Maybe;
  /** 시트의 `손실기대치` = 패률 */
  lossExpectancy: Maybe;
  /** 시트의 `기대치값` = 이익기대치 − 손실기대치 */
  expectancy: Maybe;
  /** 총이익 ÷ 총손실 — 표준 profit factor */
  profitFactor: Maybe;
  /** 시트의 `수익누적` */
  grossProfit: number;
  /** 시트의 `손실누적` — 음수 */
  grossLoss: number;
  /** 시트의 `누적 PNL` */
  netPnl: number;
  /** 시트의 `최대수익` */
  maxWin: Maybe;
  /** 시트의 `최대손실` */
  maxLoss: Maybe;
  /** 시트의 `연속수익` */
  maxWinStreak: number;
  /** 시트의 `연속손실` */
  maxLossStreak: number;
  /** 현재 진행 중인 연승(양수)/연패(음수) */
  currentStreak: number;
  /** 시트의 `초기자금` */
  initialCapital: number;
  /** 시트의 `최종자금` */
  finalEquity: number;
  totalWithdrawal: number;
  /** 시트의 `차액` = 최종자금 − 초기자금 + 출금누계 */
  netChange: number;
  /** 시트의 `수익율` = 차액 ÷ 초기자금 */
  returnPct: Maybe;
  /** 시트의 `자금비율` = 최종자금 ÷ 초기자금 */
  capitalRatio: Maybe;
  /** 시트의 `MAX` */
  peakEquity: number;
  /** 시트의 `MIN` */
  troughEquity: number;
  /** 시트의 `MDD` — 최대 낙폭(음수) */
  maxDrawdownPct: number;
  /** 평균 거래당 리스크 */
  avgRiskPct: Maybe;
}

export function computeMetrics(book: Book, derived: readonly TradeDerived[]): BookMetrics {
  const closed = derived.filter((d) => d.trade.result !== 'open');
  const openCount = derived.length - closed.length;

  const wins = closed.filter((d) => d.trade.result === 'win');
  const losses = closed.filter((d) => d.trade.result === 'loss');
  const breakEvens = closed.filter((d) => d.trade.result === 'be');

  // 손익비·기대치도 수수료를 뺀 실제 금액으로 계산한다.
  const winPnls = wins.map((d) => d.net);
  const lossPnls = losses.map((d) => d.net);

  const avgWin = mean(winPnls);
  const avgLoss = mean(lossPnls.map(Math.abs));
  const payoffRatio = avgWin !== null && avgLoss !== null ? ratio(avgWin, avgLoss) : null;

  const decided = wins.length + losses.length;
  const winRate = ratio(wins.length, decided);
  const lossExpectancy = winRate === null ? null : 1 - winRate;
  const winExpectancy =
    winRate !== null && payoffRatio !== null ? winRate * payoffRatio : null;
  const expectancy =
    winExpectancy !== null && lossExpectancy !== null
      ? winExpectancy - lossExpectancy
      : null;

  const grossProfit = winPnls.reduce((a, b) => a + b, 0);
  const grossLoss = lossPnls.reduce((a, b) => a + b, 0);
  const netPnl = derived.reduce((a, d) => a + d.net, 0);

  const streaks = computeStreaks(closed.map((d) => d.trade.result));

  const finalEquity = derived.length > 0 ? derived[derived.length - 1].equityAfter : book.initial_capital;
  const totalWithdrawal = derived.reduce((a, d) => a + (d.trade.withdrawal ?? 0), 0);
  const netChange = finalEquity - book.initial_capital + totalWithdrawal;

  const equities = [book.initial_capital, ...derived.map((d) => d.equityAfter)];
  const riskPcts = derived.map((d) => d.riskPct).filter((v): v is number => v !== null);

  return {
    closedCount: closed.length,
    openCount,
    wins: wins.length,
    losses: losses.length,
    breakEvens: breakEvens.length,
    winRate,
    avgWin,
    avgLoss,
    payoffRatio,
    winExpectancy,
    lossExpectancy,
    expectancy,
    profitFactor: grossLoss === 0 ? null : ratio(grossProfit, Math.abs(grossLoss)),
    grossProfit,
    grossLoss,
    netPnl,
    maxWin: winPnls.length > 0 ? Math.max(...winPnls) : null,
    maxLoss: lossPnls.length > 0 ? Math.min(...lossPnls) : null,
    maxWinStreak: streaks.maxWin,
    maxLossStreak: streaks.maxLoss,
    currentStreak: streaks.current,
    initialCapital: book.initial_capital,
    finalEquity,
    totalWithdrawal,
    netChange,
    returnPct: ratio(netChange, book.initial_capital),
    capitalRatio: ratio(finalEquity, book.initial_capital),
    peakEquity: Math.max(...equities),
    troughEquity: Math.min(...equities),
    maxDrawdownPct: derived.reduce((min, d) => Math.min(min, d.drawdownPct), 0),
    avgRiskPct: mean(riskPcts),
  };
}

/** 시트의 `연속수익`/`연속손실` — 본전·보유중은 스트릭을 끊지 않고 건너뛴다. */
function computeStreaks(
  results: readonly string[],
): { maxWin: number; maxLoss: number; current: number } {
  let maxWin = 0;
  let maxLoss = 0;
  let run = 0;

  for (const result of results) {
    if (result === 'win') {
      run = run > 0 ? run + 1 : 1;
      maxWin = Math.max(maxWin, run);
    } else if (result === 'loss') {
      run = run < 0 ? run - 1 : -1;
      maxLoss = Math.max(maxLoss, -run);
    }
  }

  return { maxWin, maxLoss, current: run };
}

/* ============ 기간 집계 ============ */

/** ISO 주 시작일(월요일) 키. */
export function weekKey(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

export function yearKey(iso: string): string {
  return iso.slice(0, 4);
}

export interface PeriodBucket {
  key: string;
  pnl: number;
  wins: number;
  losses: number;
  count: number;
}

export function bucketBy(
  derived: readonly TradeDerived[],
  keyFn: (iso: string) => string,
): PeriodBucket[] {
  const map = new Map<string, PeriodBucket>();

  for (const d of derived) {
    const anchor = d.trade.exit_at ?? d.trade.entry_at;
    const key = keyFn(anchor);
    const bucket = map.get(key) ?? { key, pnl: 0, wins: 0, losses: 0, count: 0 };
    bucket.pnl += d.net;
    bucket.count += 1;
    if (d.trade.result === 'win') bucket.wins += 1;
    if (d.trade.result === 'loss') bucket.losses += 1;
    map.set(key, bucket);
  }

  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** 복기 분석용 — 감정·근거·셋업 등 임의 필드로 성과를 쪼갠다. */
export interface GroupPerformance {
  key: string;
  count: number;
  wins: number;
  losses: number;
  winRate: Maybe;
  netPnl: number;
  avgPnl: Maybe;
}

export function groupPerformance(
  derived: readonly TradeDerived[],
  field: 'setup' | 'rationale' | 'emotion' | 'symbol' | 'side',
): GroupPerformance[] {
  const map = new Map<string, TradeDerived[]>();

  for (const d of derived) {
    const raw = d.trade[field];
    const key = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : '(미기재)';
    const list = map.get(key) ?? [];
    list.push(d);
    map.set(key, list);
  }

  return [...map.entries()]
    .map(([key, list]) => {
      const wins = list.filter((d) => d.trade.result === 'win').length;
      const losses = list.filter((d) => d.trade.result === 'loss').length;
      const pnls = list.map((d) => d.net);
      const netPnl = pnls.reduce((a, b) => a + b, 0);
      return {
        key,
        count: list.length,
        wins,
        losses,
        winRate: ratio(wins, wins + losses),
        netPnl,
        avgPnl: mean(pnls),
      };
    })
    .sort((a, b) => a.netPnl - b.netPnl);
}
