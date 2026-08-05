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

import type { Book, CashFlow, Trade, TradeResult } from '@/lib/domain';
import { DISPLAY_TZ } from '@/lib/format';

/** 표본이 없어 정의되지 않는 지표는 null로 돌려준다 — 0과 구분하기 위해. */
type Maybe = number | null;

function ratio(numerator: number, denominator: Maybe): Maybe {
  return denominator === null || denominator === 0 || !Number.isFinite(denominator)
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
   * 승패 — 저장된 `trade.result`가 아니라 실현손익(`net`) 부호로 정한다.
   * 저장값은 '보유중'인지를 가리는 데만 쓴다.
   */
  result: TradeResult;
  /**
   * 계좌가 실제로 움직인 금액 — 거래소의 `realized_pnl`, 없으면 손익+수수료+펀딩비.
   * `pnl`(Closed PnL)은 비용 이전 총액이다.
   * 100배 레버리지에서 수수료는 손익의 10%에 육박해 무시할 수 없다.
   */
  net: number;
  /** 시트의 `자금` — 이 거래 직전 자금. 입출금(이체)까지 반영한 실제 잔액 기준 */
  equityBefore: number;
  /** 시트의 `자금` — 이 거래 직후 자금. 입출금(이체)까지 반영한 실제 잔액 기준 */
  equityAfter: number;
  /**
   * 시트의 `누적 최고치` — 자금 곡선의 최고치.
   *
   * 이체가 있으면 고점도 그 금액만큼 함께 옮긴다. 그래야 입금이 낙폭을 지우지도,
   * 출금이 없던 낙폭을 만들지도 않는다.
   */
  peak: number;
  /** 시트의 `MDD하락률` — (자금 − 최고치) / 최고치 */
  drawdownPct: number;
  /**
   * 이 거래까지 거래계좌에서 빠져나간 돈의 누계 — 항상 양수.
   *
   * 자금 곡선을 실제로 내리는 건 거래계좌 이체(음수 `transfer`)와 시트의 `출금`뿐이다.
   * 온체인 출금은 자금계좌에서 나가므로 여기 세지 않는다 — 곡선과 시점이 어긋난다.
   */
  withdrawnTotal: number;
  /**
   * 이 거래까지의 누적 실현손익 — 넣고 뺀 돈을 걷어낸 매매 성과.
   *
   * 자금 곡선은 입금이 들어오면 올라가고 출금하면 내려간다. 그 곡선만 보면 잘 벌어서
   * 오른 건지 돈을 더 넣어서 오른 건지 구분되지 않는다. 이 값으로 그린 곡선이
   * 수익율·MDD 지표와 기준이 같은 성과 곡선이다.
   */
  netTotal: number;
  /** 증거금 — 투입 ÷ 레버리지. 이 거래에 실제로 묶인 돈이자 손익률의 분모 */
  margin: Maybe;
  /** 시트의 `L pnl`/`W pnl`을 통합 — 실현손익 / 증거금 */
  pnlPct: Maybe;
  /** 시트의 `손실율` — |진입가 − 손절가| / 진입가 */
  riskPct: Maybe;
  /** 시트의 `1차수익율`~`3차수익율` — R 배수 */
  rr: [Maybe, Maybe, Maybe];
}

/**
 * 계좌가 실제로 움직인 금액.
 *
 * 거래소가 준 실현손익이 정본이다. 없을 때만(수기 입력 경로) 손익·수수료·펀딩비로
 * 되짚는데, 그 셋에는 청산 수수료·ADL이 실리지 않아 근사값이다.
 */
function netOf(trade: Trade): number {
  if (trade.realized_pnl !== null) return trade.realized_pnl;
  return (trade.pnl ?? 0) + (trade.fee ?? 0) + (trade.funding_fee ?? 0);
}

/**
 * 승패 — 수수료·펀딩비를 뺀 실현손익으로 정한다.
 *
 * 저장된 `result`는 '보유중'인지만 보고, 부호는 여기서 다시 매긴다. 총손익으로 재면
 * 계좌가 줄어든 거래가 '승'으로 남아 승률·기대치가 부풀고, 같은 줄의 손익률과
 * 배지가 서로 다른 말을 한다.
 */
function resultOf(trade: Trade, net: number): TradeResult {
  if (trade.result === 'open' || trade.exit_at === null || trade.pnl === null) return 'open';
  return net > 0 ? 'win' : net < 0 ? 'loss' : 'be';
}

/**
 * 거래계좌 잔액을 움직이는 흐름만 시간순으로 추린다.
 *
 * 온체인 입금·출금은 자금계좌에 먼저 닿는다 — 거래계좌로 이체되기 전까지는
 * 자금 곡선과 무관하다. 셋을 한 덩어리로 더하면 곡선이 실제와 어긋난다.
 */
function sortedTransfers(flows: readonly CashFlow[]): CashFlow[] {
  return flows
    .filter((f) => f.kind === 'transfer')
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * 자금 곡선을 만든다.
 *
 * `equity_after`가 입력돼 있으면 그 값이 정본(거래소 화면에서 읽은 실측치).
 * 비어 있으면 직전 자금 + 손익 − 출금으로 이어 붙이고, 그 사이에 일어난 이체를 더한다.
 *
 * 낙폭은 이 곡선(=거래소 잔액)에서 재되, 이체가 있으면 고점을 같은 금액만큼 옮긴다.
 * 매매분만 따로 떼어 낸 곡선에서 재 봤더니, 초기자금이 0인 북에서는 0에 가까운
 * 고점으로 낙폭을 나누게 돼 −846% 같은 값이 나왔다.
 */
export function deriveTrades(
  book: Book,
  trades: readonly Trade[],
  flows: readonly CashFlow[] = [],
): TradeDerived[] {
  const sorted = [...trades].sort(
    (a, b) => Date.parse(a.entry_at) - Date.parse(b.entry_at) || a.seq - b.seq,
  );
  const transfers = sortedTransfers(flows);

  let running = book.initial_capital;
  let peak = book.initial_capital;
  let nextTransfer = 0;
  let withdrawnTotal = 0;
  let netTotal = 0;

  return sorted.map((trade) => {
    // 진입 시각을 경계로 이체를 반영한다 — 거래 도중에 들어온 돈이 그 거래의
    // '진입 직전 자금'을 흐트러뜨리지 않도록, 그건 다음 거래에서 잡는다.
    const entryMs = Date.parse(trade.entry_at);
    while (nextTransfer < transfers.length && Date.parse(transfers[nextTransfer].at) <= entryMs) {
      const { amount } = transfers[nextTransfer];
      running += amount;
      // 나간 이체만 출금으로 센다 — 들어온 이체까지 더하면 왕복이 출금으로 잡힌다.
      if (amount < 0) withdrawnTotal -= amount;
      // 고점도 같은 금액만큼 옮긴다 — 넣고 뺀 돈은 매매 성과가 아니다.
      peak = Math.max(peak + amount, 0);
      nextTransfer += 1;
    }

    const equityBefore = trade.equity_before ?? running;
    const net = netOf(trade);
    const withdrawal = trade.withdrawal ?? 0;
    const equityAfter = trade.equity_after ?? equityBefore + net - withdrawal;

    running = equityAfter;
    peak = Math.max(peak, running);
    withdrawnTotal += withdrawal;
    netTotal += net;

    const margin = marginOf(trade);

    return {
      trade,
      result: resultOf(trade, net),
      net,
      equityBefore,
      equityAfter,
      peak,
      drawdownPct: peak <= 0 ? 0 : (running - peak) / peak,
      withdrawnTotal,
      netTotal,
      margin,
      pnlPct: trade.pnl === null ? null : ratio(net, margin),
      riskPct: riskPct(trade),
      rr: [rrFor(trade, trade.tp1_price), rrFor(trade, trade.tp2_price), rrFor(trade, trade.tp3_price)],
    };
  });
}

/**
 * 증거금 — 이 거래에 실제로 묶인 돈.
 *
 * 손익률의 분모다. 자금(계좌 잔고)을 분모로 쓰면 두 가지가 어긋난다:
 * 자금은 다른 거래의 손익까지 섞인 값이라 같은 거래도 순서에 따라 비율이 달라지고,
 * 초기자금보다 큰 손실이 쌓여 자금 곡선이 음수로 내려가면 부호까지 통째로 뒤집힌다.
 * 증거금은 그 거래만의 값이고 항상 양수라 거래소 화면의 PnL%와도 기준이 같다.
 */
export function marginOf(trade: Trade): Maybe {
  const { notional, leverage } = trade;
  if (notional === null || notional === 0 || !Number.isFinite(notional)) return null;
  // 레버리지가 비면 1배로 본다 — 투입 전액이 증거금이다.
  const lever = leverage === null || leverage === 0 ? 1 : Math.abs(leverage);
  return Math.abs(notional) / lever;
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
  /** 시트의 `최종자금` — 이체까지 반영한 거래계좌 잔액 */
  finalEquity: number;
  totalWithdrawal: number;
  /**
   * 거래계좌에서 빠져나간 돈의 누계(양수) — 자금 곡선을 실제로 내린 금액 전체.
   *
   * 나간 이체만 센다. 순이체(`netTransfer`)는 들어온 것과 상계돼 "얼마나 뽑아 갔는지"를
   * 지운다 — 100을 넣고 100을 뺐으면 순이체는 0이지만 뽑아 간 돈은 100이다.
   */
  withdrawnFromAccount: number;
  /** 온체인 입금 누계 — 실제로 넣은 현금(양수) */
  deposits: number;
  /** 온체인 출금 누계 — 실제로 뺀 현금(음수) */
  withdrawals: number;
  /** 거래계좌 순이체 — 자금 곡선을 움직인 외부 유입(부호 포함) */
  netTransfer: number;
  /** 투입원금 = 초기자금 + 누적 순이체의 최고치 (왕복 이체는 상쇄된다) */
  investedCapital: number;
  /** 시트의 `차액` — 외부 유입을 걷어낸 자금 증가분 = 매매로 번 돈 */
  netChange: number;
  /** 시트의 `수익율` = 차액 ÷ 투입원금 */
  returnPct: Maybe;
  /** 시트의 `자금비율` = 최종자금 ÷ 투입원금 */
  capitalRatio: Maybe;
  /** 시트의 `MAX` — 자금 곡선의 최고치 */
  peakEquity: number;
  /** 시트의 `MIN` — 자금 곡선의 최저치 */
  troughEquity: number;
  /** 시트의 `MDD` — 최대 낙폭(음수). 이체분은 고점에서 상쇄한다 */
  maxDrawdownPct: number;
  /** 평균 거래당 리스크 */
  avgRiskPct: Maybe;
}

export function computeMetrics(
  book: Book,
  derived: readonly TradeDerived[],
  flows: readonly CashFlow[] = [],
): BookMetrics {
  const closed = derived.filter((d) => d.result !== 'open');
  const openCount = derived.length - closed.length;

  const wins = closed.filter((d) => d.result === 'win');
  const losses = closed.filter((d) => d.result === 'loss');
  const breakEvens = closed.filter((d) => d.result === 'be');

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

  const streaks = computeStreaks(closed.map((d) => d.result));

  const transfers = sortedTransfers(flows);
  const netTransfer = transfers.reduce((a, f) => a + f.amount, 0);

  /*
   * 투입원금 — 가장 많이 넣어 뒀던 시점의 금액.
   *
   * 들어온 이체를 모두 더하면 자금계좌를 오간 왕복이 전부 원금으로 잡혀 부풀어 오른다
   * (실계좌: 왕복 45회에 유입 합계 976, 실제로 넣은 돈은 185). 누적 순이체의 최고치를
   * 쓰면 왕복이 상쇄되고 "한때 이만큼 넣어 뒀다"만 남는다.
   */
  let runningTransfer = 0;
  let peakTransfer = 0;
  for (const f of transfers) {
    runningTransfer += f.amount;
    peakTransfer = Math.max(peakTransfer, runningTransfer);
  }
  const deposits = flows
    .filter((f) => f.kind === 'deposit')
    .reduce((a, f) => a + f.amount, 0);
  const withdrawals = flows
    .filter((f) => f.kind === 'withdrawal')
    .reduce((a, f) => a + f.amount, 0);

  const last = derived[derived.length - 1];
  // 마지막 거래 뒤에 일어난 이체는 어느 거래에도 실리지 않는다 — 여기서 마저 더한다.
  const lastEntryMs = last ? Date.parse(last.trade.entry_at) : -Infinity;
  const tailTransfer = transfers
    .filter((f) => Date.parse(f.at) > lastEntryMs)
    .reduce((a, f) => a + f.amount, 0);

  const finalEquity = (last ? last.equityAfter : book.initial_capital) + tailTransfer;
  const totalWithdrawal = derived.reduce((a, d) => a + (d.trade.withdrawal ?? 0), 0);
  // 외부에서 드나든 돈을 걷어낸 자금 증가분 — 데이터가 온전하면 누적 실현손익과 같다.
  const netChange = finalEquity - book.initial_capital - netTransfer + totalWithdrawal;
  const investedCapital = book.initial_capital + peakTransfer;

  // 최고치는 낙폭을 재는 그 고점을 쓴다 — 거래 사이에 이체로 올라간 지점까지 담긴다.
  const peaks = [book.initial_capital, ...derived.map((d) => d.peak)];
  const balances = [book.initial_capital, ...derived.map((d) => d.equityAfter)];
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
    // 마지막 거래 뒤의 이체까지 담는다 — 곡선은 거래 시점까지만 찍지만 합계는 전부여야 한다.
    withdrawnFromAccount:
      transfers.filter((f) => f.amount < 0).reduce((a, f) => a - f.amount, 0) + totalWithdrawal,
    deposits,
    withdrawals,
    netTransfer,
    investedCapital,
    netChange,
    returnPct: ratio(netChange, investedCapital),
    capitalRatio: ratio(finalEquity, investedCapital),
    peakEquity: Math.max(...peaks),
    troughEquity: Math.min(...balances),
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

/**
 * 일별 키 — 표시 타임존 기준.
 *
 * UTC로 자르면 한국 아침 9시 이전 거래가 전날 칸으로 밀린다. 하루 단위는 그 차이가
 * 그대로 드러나므로(월 단위와 달리 경계에 걸리는 거래가 많다) 시간대를 명시한다.
 * `en-CA` 로케일이 `2026-07-28` 형태를 준다.
 */
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function dayKey(iso: string): string {
  return DAY_FORMAT.format(new Date(iso));
}

export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

export function yearKey(iso: string): string {
  return iso.slice(0, 4);
}

/**
 * 마지막으로 움직인 시각 — 벤치마크 구간의 끝.
 *
 * 목록은 진입순이라(`deriveTrades`) 마지막 칸이 가장 늦게 **청산된** 거래는 아니다. 먼저
 * 들어가 나중에 나온 포지션이 있으면 그 청산이 목록 끝보다 뒤에 온다. 목록 끝으로 시세를
 * 잘라 오면 그 뒤 거래들이 구간 밖으로 밀려, 마지막 종가가 그대로 이어진 채 찍힌다 —
 * 동기화로 겹치는 포지션이 한꺼번에 들어올 때 특히 잘 어긋난다.
 *
 * 아직 들고 있는 거래는 청산이 없으니 진입 시각으로 센다.
 */
export function lastActivityAt(derived: readonly TradeDerived[]): string | null {
  let latest: string | null = null;
  let latestMs = -Infinity;

  for (const d of derived) {
    const at = d.trade.exit_at ?? d.trade.entry_at;
    const ms = Date.parse(at);
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latest = at;
    }
  }
  return latest;
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
    if (d.result === 'win') bucket.wins += 1;
    if (d.result === 'loss') bucket.losses += 1;
    map.set(key, bucket);
  }

  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/* ============ 성과 요약 ============ */

/**
 * 성과 요약 — 값마다 "언제"가 붙는다.
 *
 * 기존 KPI 타일은 지금 상태가 어떤지를 한눈에 보여 준다. 이 요약은 거기 없던 걸 채운다 —
 * 최대 손실이 **언제** 났는지, 낙폭이 **어느 구간**이었는지. 시점을 모르면 그때 무슨
 * 일이 있었는지 되짚을 수 없다.
 *
 * 기준 단위가 거래 건이 아니라 **거래일**이다. 하루에 다섯 번 들어갔다 나온 날의 성적은
 * 그날 합계로 판단해야 한다 — 건별로 세면 스캘핑이 잦은 날이 통계를 통째로 끌고 간다.
 */
export interface PerformanceSummary {
  /** 첫 거래일 ~ 마지막 거래일 */
  period: { from: string; to: string } | null;
  /** 시트의 `총손익` */
  netPnl: number;
  /** 시트의 `총수익` */
  grossProfit: number;
  /** 시트의 `총손실` — 음수 */
  grossLoss: number;
  /** 거래가 있었던 날의 수 */
  tradingDays: number;
  /** 일 기준 승률 — 이익일 ÷ (이익일 + 손실일). 건 기준 승률과는 다른 값이다 */
  dailyWinRate: Maybe;
  /** 총이익 ÷ |총손실| */
  profitFactor: Maybe;
  /**
   * 보상 비율(ROA) — 총손익 ÷ |최대 낙폭 금액|.
   *
   * "한 번 견뎌야 했던 최악의 낙폭에 견줘 얼마를 벌었나". 수익률만 보면 낙폭을 얼마나
   * 크게 물고 갔는지가 지워진다.
   */
  roa: Maybe;
  bestDay: { pnl: number; day: string } | null;
  worstDay: { pnl: number; day: string } | null;
  /** 최대 낙폭 — 금액·비율과 그 구간(고점일 ~ 저점일) */
  maxDrawdown: { amount: number; pct: number; from: string; to: string } | null;
  /** 이익일이 연달한 최대 구간 */
  winStreak: DayRun | null;
  /** 손실일이 연달한 최대 구간 */
  lossStreak: DayRun | null;
}

export interface DayRun {
  days: number;
  from: string;
  to: string;
}

/**
 * 조건을 만족하는 날이 가장 길게 이어진 구간.
 *
 * 거래가 없는 날은 배열에 아예 없으므로 건너뛴다 — 그래서 12거래일 연속이어도
 * 달력으로는 26일에 걸칠 수 있다. 시트의 `최대 연속 이익 거래일`도 같은 방식이다.
 */
function longestRun(
  days: readonly PeriodBucket[],
  hit: (bucket: PeriodBucket) => boolean,
): DayRun | null {
  let best: DayRun | null = null;
  let start = -1;

  // 마지막 칸을 한 번 더 돌아 열려 있는 구간을 닫는다.
  for (let i = 0; i <= days.length; i += 1) {
    if (i < days.length && hit(days[i])) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      const length = i - start;
      if (best === null || length > best.days) {
        best = { days: length, from: days[start].key, to: days[i - 1].key };
      }
      start = -1;
    }
  }
  return best;
}

/**
 * 최대 낙폭이 언제 시작해 언제 바닥을 쳤는지.
 *
 * 낙폭 자체는 `deriveTrades`가 거래 단위로 이미 재 뒀다 — 여기서 다시 재면 KPI 타일의
 * MDD와 값이 갈린다. 그 곡선을 그대로 훑으며 고점이 갱신된 시점만 따로 기억한다.
 */
function findMaxDrawdown(
  book: Book,
  derived: readonly TradeDerived[],
): PerformanceSummary['maxDrawdown'] {
  let peak = book.initial_capital;
  let peakAt = book.start_date;
  let deepest = 0;
  let found: PerformanceSummary['maxDrawdown'] = null;

  for (const d of derived) {
    const at = dayKey(d.trade.exit_at ?? d.trade.entry_at);
    if (d.peak > peak) {
      peak = d.peak;
      peakAt = at;
    }

    const drop = d.peak - d.equityAfter;
    if (drop > deepest) {
      deepest = drop;
      found = { amount: -drop, pct: d.drawdownPct, from: peakAt, to: at };
    }
  }
  return found;
}

export function summarizePerformance(
  book: Book,
  derived: readonly TradeDerived[],
  flows: readonly CashFlow[] = [],
): PerformanceSummary {
  const m = computeMetrics(book, derived, flows);
  // 청산된 거래만 날짜 칸에 들어간다 — 보유 중인 건 아직 성적이 없다.
  const days = bucketBy(
    derived.filter((d) => d.result !== 'open'),
    dayKey,
  );

  const best = days.reduce<PeriodBucket | null>(
    (top, d) => (top === null || d.pnl > top.pnl ? d : top),
    null,
  );
  const worst = days.reduce<PeriodBucket | null>(
    (low, d) => (low === null || d.pnl < low.pnl ? d : low),
    null,
  );

  const winDays = days.filter((d) => d.pnl > 0).length;
  const lossDays = days.filter((d) => d.pnl < 0).length;
  const maxDrawdown = findMaxDrawdown(book, derived);

  return {
    period: days.length === 0 ? null : { from: days[0].key, to: days[days.length - 1].key },
    netPnl: m.netPnl,
    grossProfit: m.grossProfit,
    grossLoss: m.grossLoss,
    tradingDays: days.length,
    dailyWinRate: ratio(winDays, winDays + lossDays),
    profitFactor: m.profitFactor,
    roa: maxDrawdown === null ? null : ratio(m.netPnl, Math.abs(maxDrawdown.amount)),
    bestDay: best === null ? null : { pnl: best.pnl, day: best.key },
    worstDay: worst === null ? null : { pnl: worst.pnl, day: worst.key },
    maxDrawdown,
    // 합계가 정확히 0인 날은 연속을 끊는다 — 하루치 손익이 딱 0으로 떨어지는 일은 없다시피 하다.
    winStreak: longestRun(days, (d) => d.pnl > 0),
    lossStreak: longestRun(days, (d) => d.pnl < 0),
  };
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
      const wins = list.filter((d) => d.result === 'win').length;
      const losses = list.filter((d) => d.result === 'loss').length;
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
