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
  /** 이 북이 내려받는 거래소 계정 — 비어 있으면 수동 기록 전용 북이다 */
  exchange_account_id: string | null;
  created_at: string;
}

/**
 * 거래소 API 계정 — 사람마다 자기 키를 등록한다.
 *
 * 키 원문은 여기 없다. Supabase Vault 가 암호화해 보관하고 이 표에는 비밀의 uuid만
 * 남으며, 복호화는 서버(service_role)에서만 가능하다. 그래서 앱이 다루는 이 타입에는
 * 아예 키 필드가 없다 — 화면으로 흘러갈 경로 자체를 만들지 않는다.
 */
export interface ExchangeAccount {
  id: string;
  user_id: string;
  exchange: 'okx';
  /** 화면에 뜨는 이름 — 거래소가 주는 값이 아니라 사람이 붙이는 꼬리표 */
  label: string;
  created_at: string;
  updated_at: string;
}

export const EXCHANGE_LABEL: Record<ExchangeAccount['exchange'], string> = {
  okx: 'OKX',
};

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
  /** 거래 수수료 — 체결 비용. 부호 포함(보통 음수) */
  fee: number | null;
  /** 펀딩비 — 보유 비용. 거래 수수료와 성격이 달라 나눠 둔다 */
  funding_fee: number | null;
  /**
   * 거래소가 알려준 실현손익 — 계좌가 실제로 움직인 금액.
   *
   * `pnl + fee + funding_fee`로 되짚으면 청산 수수료·ADL처럼 세 항목 어디에도
   * 실리지 않는 비용이 빠진다. 이 값이 있으면 그쪽이 정본이다.
   */
  realized_pnl: number | null;
  /** 교차/격리 — 청산 위험이 달라 복기 축이 된다 */
  margin_mode: 'cross' | 'isolated' | null;
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
  /** OKX 포지션 슬롯 번호 — 종목·방향이 같으면 재사용된다. `exit_at`과 짝이어야 거래 하나를 가리킨다 */
  okx_pos_id: string | null;
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
  /** 거래소 주문번호 — 부분체결이면 여러 체결이 같은 값을 갖는다 */
  order_no: string | null;
  /** OKX 체결번호 — 체결 1건마다 유일하다. API 경로의 중복 방지 열쇠 */
  okx_bill_id: string | null;
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

/** 거래소 동기화 1회 실행 기록 — 어디까지 훑었는지 남겨 다음 실행이 이어받는다. */
export interface SyncRun {
  id: string;
  user_id: string;
  book_id: string;
  /** 어느 거래소 계정으로 받아 온 실행인지 — 계정을 바꾼 뒤 이력을 되짚을 때 필요하다 */
  exchange_account_id: string | null;
  source: 'okx';
  started_at: string;
  finished_at: string | null;
  cursor_at: string | null;
  trades_added: number;
  fills_added: number;
  error: string | null;
}

/**
 * 계좌를 드나든 돈 — 입금·출금·이체.
 *
 * 거래계좌 잔액을 움직이는 건 매매 손익과 `transfer`(자금계좌 ↔ 거래계좌)뿐이다.
 * 온체인 `deposit`/`withdrawal`은 자금계좌에 먼저 닿으므로 이체 전까지는
 * 자금 곡선에 반영되지 않는다.
 */
export type CashFlowKind = 'deposit' | 'withdrawal' | 'transfer';

export interface CashFlow {
  id: string;
  book_id: string;
  user_id: string;
  kind: CashFlowKind;
  at: string;
  ccy: string;
  /** 부호 포함 — 들어오면 +, 나가면 − */
  amount: number;
  /** 출금 수수료 등 부대비용. 부호 포함(보통 음수) */
  fee: number | null;
  note: string | null;
  /** OKX 원본 식별자(billId / depId / wdId) */
  okx_ref: string | null;
  source: 'okx' | 'manual';
  created_at: string;
}

export const CASH_FLOW_LABEL: Record<CashFlowKind, string> = {
  deposit: '입금',
  withdrawal: '출금',
  transfer: '이체',
};

export interface BalanceSnapshot {
  id: string;
  book_id: string;
  user_id: string;
  at: string;
  equity: number;
  source: 'capture' | 'manual' | 'okx';
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
