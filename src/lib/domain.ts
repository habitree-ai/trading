/**
 * 도메인 모델 — 구글시트 매매일지의 항목 체계를 정규화한 것.
 *
 * 원칙: 원자값만 보관하고 파생지표(누적 최고치·MDD·RR·수익율 등)는 저장하지 않는다.
 * 시트가 `#REF!`로 깨진 원인이 계산값을 셀에 박아둔 것이기 때문.
 */

export type Side = 'long' | 'short';
export type TradeResult = 'win' | 'loss' | 'be' | 'open';
export type BookStatus = 'active' | 'closed';
export type CaptureKind = 'position' | 'chart' | 'balance';
export type ExtractEngine = 'ocr' | 'ai' | 'manual';

/** 계좌/기간별 일지 1권 — 시트의 탭 하나에 대응. */
export interface Book {
  id: string;
  user_id: string;
  name: string;
  exchange: string | null;
  base_currency: string;
  /** 시트의 `초기자금` */
  initial_capital: number;
  start_date: string;
  status: BookStatus;
  memo: string | null;
  created_at: string;
}

/** 거래 1건 — 시트 거래 로그의 한 행. */
export interface Trade {
  id: string;
  book_id: string;
  user_id: string;
  /** 시트의 `순번` — 북 내에서 1부터 */
  seq: number;
  /** 시트의 `방향` (L/S) */
  side: Side;
  /** 시트의 `종목` */
  symbol: string;
  /** 시트의 `진입` */
  entry_at: string;
  /** 시트의 `종료` — 미청산이면 null */
  exit_at: string | null;
  /** 시트의 `승`/`패` 두 컬럼을 통합 */
  result: TradeResult;
  /** 시트의 `자금` — 진입 직전 계좌 자금 */
  equity_before: number | null;
  /** 시트의 `자금` — 청산 직후 계좌 자금 */
  equity_after: number | null;
  /** 시트의 `출금` */
  withdrawal: number | null;
  /** 시트의 `투입` — 포지션 명목가 */
  notional: number | null;
  /** 시트의 `Lv`/`Rv` */
  leverage: number | null;
  /** 시트의 `TP/SP` — 부호 포함 손익 (수익금/손실금 2컬럼을 통합) */
  pnl: number | null;
  /** 시트의 `진입가` */
  entry_price: number | null;
  /** 청산가 — 거래소 캡쳐의 `Fill price`. 시트에는 없던 항목 */
  exit_price: number | null;
  /** 수수료 — 부호 포함(보통 음수). 시트에는 없던 항목 */
  fee: number | null;
  /** 시트의 `손절가` */
  stop_price: number | null;
  /** 시트의 `TP1`~`TP3` (익절1~3) */
  tp1_price: number | null;
  tp2_price: number | null;
  tp3_price: number | null;
  /** 시트의 `기준` — 진입 셋업 */
  setup: string | null;
  /** 시트의 `근거` */
  rationale: string | null;
  /** 시트의 `복기` */
  review: string | null;
  /** 시트의 `감정` */
  emotion: string | null;
  /** 시트의 `비고` */
  note: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 체결 1건 — 분할 진입·분할 청산을 낱개로 보관한다.
 *
 * 거래의 `entry_price`/`exit_price`는 가중평균가라 어느 한 시점의 가격이 아니다.
 * 차트에 점으로 찍으려면 실제 체결 좌표가 필요하다.
 */
export interface TradeFill {
  id: string;
  trade_id: string;
  user_id: string;
  role: 'open' | 'close';
  filled_at: string;
  price: number;
  amount: number | null;
  fee: number | null;
  created_at: string;
}

export interface TradeImage {
  id: string;
  trade_id: string | null;
  user_id: string;
  kind: CaptureKind;
  storage_path: string;
  ocr_raw: string | null;
  extracted: unknown;
  confidence: number | null;
  engine: ExtractEngine;
  created_at: string;
}

export interface BalanceSnapshot {
  id: string;
  book_id: string;
  user_id: string;
  at: string;
  equity: number;
  source: 'capture' | 'manual';
  image_id: string | null;
}

/** 목표 지표 — 계획 β(반드시 지킬 기준) / 목표 α(도전 기준) 2중 관리. */
export type GoalMetric =
  | 'return_pct'
  | 'max_drawdown_pct'
  | 'win_rate'
  | 'expectancy'
  | 'risk_per_trade_pct'
  | 'trade_count';

export type GoalPeriod = 'week' | 'month' | 'year';
export type GoalTier = 'beta' | 'alpha';

export interface Goal {
  id: string;
  book_id: string;
  user_id: string;
  tier: GoalTier;
  period: GoalPeriod;
  metric: GoalMetric;
  target_value: number;
}

/** 지표별 표시 정보 — 낮을수록 좋은 지표가 섞여 있어 방향을 명시한다. */
export const GOAL_METRICS: Record<
  GoalMetric,
  { label: string; unit: string; higherIsBetter: boolean; decimals: number }
> = {
  return_pct: { label: '수익률', unit: '%', higherIsBetter: true, decimals: 1 },
  max_drawdown_pct: { label: '최대 MDD', unit: '%', higherIsBetter: false, decimals: 1 },
  win_rate: { label: '승률', unit: '%', higherIsBetter: true, decimals: 1 },
  expectancy: { label: '기대치값', unit: 'R', higherIsBetter: true, decimals: 2 },
  risk_per_trade_pct: { label: '거래당 리스크', unit: '%', higherIsBetter: false, decimals: 2 },
  trade_count: { label: '거래 수', unit: '건', higherIsBetter: false, decimals: 0 },
};

export const SIDE_LABEL: Record<Side, string> = { long: '롱', short: '숏' };

export const RESULT_LABEL: Record<TradeResult, string> = {
  win: '승',
  loss: '패',
  be: '본전',
  open: '보유중',
};

export const CAPTURE_KIND_LABEL: Record<CaptureKind, string> = {
  position: '포지션 종료',
  chart: '차트(진입 근거)',
  balance: '계좌 잔고',
};
