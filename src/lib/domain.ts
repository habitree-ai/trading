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
  /**
   * 아직 안 닫힌 포지션이 지금까지 계좌에 남긴 순손익 — 미실현 가격손익 + 이미 낸 비용.
   *
   * 확정된 값이 아니라 시세를 따라 움직인다. 그래서 손익 칸과 나눠 둔다 — 같은 칸에
   * 담으면 누적 손익·승률·기대치가 시세에 흔들리고, 잔고 대조에서는 스냅샷의
   * 미청산분과 이중으로 잡힌다. 청산되는 순간 null이 되고 `realized_pnl`로 옮겨간다.
   */
  unrealized_pnl: number | null;
  /** 교차/격리 — 청산 위험이 달라 복기 축이 된다 */
  margin_mode: 'cross' | 'isolated' | null;
  /** 시트의 `손절가` — **손으로 적는 계획값.** 동기화는 이 칸을 건드리지 않는다 */
  stop_price: number | null;
  /** 시트의 `TP1`~`TP3` (익절1~3) — 여기도 손 입력 전용 */
  tp1_price: number | null;
  tp2_price: number | null;
  tp3_price: number | null;
  /**
   * TP 단계마다 덜어낼 비중(%, 0 초과 100 이하) — 시트에는 없던 항목. 손 입력 전용.
   *
   * 셋 다 비어 있으면 가격이 있는 TP 수로 균등으로 읽고, 하나라도 적혀 있으면 빈 칸은 0 이다.
   * 합이 100 이 아닌 것은 폼이 경고할 뿐 저장을 막지 않는다 — 계획은 고쳐 가며 적는다.
   */
  tp1_pct: number | null;
  tp2_pct: number | null;
  tp3_pct: number | null;
  /**
   * 거래소에 **실제로 걸려 있던** 손절 트리거가.
   *
   * 위 `stop_price`가 "얼마에 끊으려 했나"(계획)라면 이쪽은 "얼마가 걸려 있었나"(사실)다.
   * 한 포지션에 손절이 여러 번 걸렸으면 **마지막에 등록된 값**이지 진입 시점 값이 아니다.
   * 어느 포지션의 예약인지 가릴 수 없으면 비운다 — 틀린 값을 적느니 비우는 게 낫다.
   */
  okx_stop_price: number | null;
  /** 거래소에 걸려 있던 익절 트리거가. 익절을 걸지 않은 거래가 대부분이라 보통 null */
  okx_tp_price: number | null;
  /**
   * 위 두 값을 어느 경로로 얻었는지.
   *
   * `attached`·`position`은 식별자가 일치한 사실이고, `algo`는 종목·방향·시각으로
   * 되짚은 추정이다. 숫자가 이상하면 여기부터 의심한다.
   */
  okx_sl_source: 'attached' | 'position' | 'algo' | null;
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

/**
 * 차트 메모 1개 — 거래 차트 위에 남긴 텍스트나 도형.
 *
 * 복기는 "그때 무엇을 봤는지"를 되짚는 일이다. 지지선을 어디로 봤는지, 어느 봉에서
 * 손이 먼저 나갔는지는 차트 위 좌표에 붙어 있어야 뜻이 산다.
 */
export type AnnotationKind = 'text' | 'line' | 'hline' | 'rect' | 'long' | 'short';

/** 색은 CSS 토큰 이름으로 둔다 — 라이트/다크가 바뀌어도 같은 뜻의 색을 쓴다. */
export type AnnotationColor = 'accent' | 'profit' | 'loss' | 'beta';

/** 선 종류 — 실선·파선·점선. */
export type AnnotationLineStyle = 'solid' | 'dashed' | 'dotted';

export const ANNOTATION_LINE_STYLES: AnnotationLineStyle[] = ['solid', 'dashed', 'dotted'];

export const ANNOTATION_LINE_STYLE_LABEL: Record<AnnotationLineStyle, string> = {
  solid: '실선',
  dashed: '파선',
  dotted: '점선',
};

/** 메모가 가리키는 자리 — 화면 픽셀이 아니라 (시각, 가격)이라 봉을 바꿔도 같은 곳이다. */
export interface ChartPoint {
  /** 초 단위 epoch — lightweight-charts의 UTCTimestamp와 같은 단위 */
  t: number;
  p: number;
}

export interface TradeAnnotation {
  id: string;
  trade_id: string;
  user_id: string;
  kind: AnnotationKind;
  /**
   * `text`·`hline`은 1점, `line`·`rect`는 2점, `long`·`short`는 3점.
   *
   * 손익 툴(`long`·`short`)만 순서가 곧 역할이다 — `[진입, 손절, 목표]`.
   */
  points: ChartPoint[];
  /** 도형에 붙는 라벨. `text`에서는 이것이 내용 전부다 */
  text: string | null;
  color: AnnotationColor;
  /**
   * 잠긴 메모는 차트에서 집히지 않는다 — 그 위에서도 차트를 그대로 밀고 확대할 수 있다.
   *
   * 자리를 다 잡은 메모가 차트를 만지다 밀리는 걸 막는 게 전부다. 푸는 자리는 목록이다.
   */
  locked: boolean;
  created_at: string;
  updated_at: string;
  /**
   * 선 굵기(px)·선 종류 — 없으면 화면 기본값으로 그린다.
   *
   * 4분할 차트(세션 메모리)에서 도형별로 고치는 값이라 DB 컬럼은 없다. DB에서 읽은
   * 메모는 이 필드가 비어 있고, 그때는 화면이 정한 기본 굵기·실선으로 그려진다.
   */
  line_width?: number;
  line_style?: AnnotationLineStyle;
}

export const ANNOTATION_KINDS: AnnotationKind[] = [
  'text',
  'hline',
  'line',
  'rect',
  'long',
  'short',
];

export const ANNOTATION_KIND_LABEL: Record<AnnotationKind, string> = {
  text: '텍스트',
  hline: '수평선',
  line: '추세선',
  rect: '박스',
  long: '롱 손익',
  short: '숏 손익',
};

/** 진입·손절·목표를 한 덩어리로 잡는 종류 — 좌표 순서가 역할이라 따로 다룬다. */
export function isPositionKind(kind: AnnotationKind): kind is 'long' | 'short' {
  return kind === 'long' || kind === 'short';
}

export const ANNOTATION_COLORS: AnnotationColor[] = ['accent', 'profit', 'loss', 'beta'];

export const ANNOTATION_COLOR_LABEL: Record<AnnotationColor, string> = {
  accent: '파랑',
  profit: '초록',
  loss: '빨강',
  beta: '노랑',
};

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

/**
 * 매매 원칙 — 지키기로 정한 규칙 1개.
 *
 * 북 단위다. 북은 계좌/기간 단위라 그 안에서 쓰는 전략도 같이 갈린다.
 */
export type PrincipleCategory = 'entry' | 'exit' | 'risk' | 'mental' | 'routine';

export interface Principle {
  id: string;
  book_id: string;
  user_id: string;
  category: PrincipleCategory;
  title: string;
  /** 왜 이 원칙인지 — 어겼을 때 무슨 일이 있었는지 */
  detail: string | null;
  /** 묶음 안에서의 표시 순서 */
  sort_order: number;
  /** 지금 지키는 원칙인지. false는 접어 둔 것으로, 과거 거래의 체크는 그대로 남는다 */
  active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * 거래 × 원칙 — 지켰는지(true) 어겼는지(false).
 *
 * 행이 없는 건 '어겼음'이 아니라 '아직 판단하지 않음'이다. 셋을 구분해야 체크를
 * 안 한 거래가 위반으로 잡혀 복기 통계를 끌고 가는 일이 없다.
 */
export interface TradePrincipleCheck {
  trade_id: string;
  principle_id: string;
  user_id: string;
  kept: boolean;
  note: string | null;
  created_at: string;
}

export const PRINCIPLE_CATEGORY_LABEL: Record<PrincipleCategory, string> = {
  risk: '리스크',
  entry: '진입',
  exit: '청산',
  mental: '멘탈',
  routine: '루틴',
};

/** 화면에 뜨는 묶음 순서 — 계좌를 먼저 지키는 것부터 위에 둔다. */
export const PRINCIPLE_CATEGORIES: PrincipleCategory[] = [
  'risk',
  'entry',
  'exit',
  'mental',
  'routine',
];

export interface BalanceSnapshot {
  id: string;
  book_id: string;
  user_id: string;
  at: string;
  equity: number;
  /**
   * 이 시점 미청산 포지션이 잔고에 남긴 순손익 — `equity`에 이미 포함돼 있다.
   *
   * 미실현 가격손익에 그 포지션이 이미 낸 수수료·펀딩비까지 더한 값이다. 계산 자금은
   * 청산된 거래만 더하므로, 둘을 견줄 때는 이만큼을 걷어내야 같은 기준이 된다.
   * 예전에 찍은 스냅샷이면 null.
   */
  unrealized_pnl: number | null;
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

/**
 * 종목 리서치 — 매매 이전에 참고하는 자료.
 *
 * 일지가 "이미 한 거래"를 되짚는 도구라면 리서치는 "하기 전"의 자리다.
 * 스냅샷은 수집 시점의 시장 단면(정량), 노트는 사람이 쌓는 맥락(정성)이다.
 * 북과 무관하게 종목 단위다 — 리서치는 계좌/기간이 아니라 대상에 붙는다.
 */
export type ResearchNoteCategory =
  | 'fundamental'
  | 'onchain'
  | 'regulation'
  | 'social'
  | 'macro'
  | 'briefing';

export interface ResearchNote {
  id: string;
  user_id: string;
  symbol: string;
  category: ResearchNoteCategory;
  title: string;
  body: string | null;
  source_url: string | null;
  /** 1(참고) ~ 3(핵심) — 목록에서 중요한 것이 위로 온다 */
  importance: number;
  created_at: string;
  updated_at: string;
}

/**
 * 뉴스 헤드라인 1건 — 스냅샷의 jsonb에 담긴다.
 *
 * interface가 아니라 type인 것에 뜻이 있다 — DB의 `Json` 타입(인덱스 시그니처)에
 * 그대로 대입되려면 type alias여야 한다. interface는 확장 가능성 때문에 거부된다.
 */
export type ResearchHeadline = {
  title: string;
  link: string;
  source: string;
  published_at: string | null;
};

/** 정량 스냅샷 1장. 실패한 소스의 값은 null이고 `sources`에 사유가 남는다. */
export interface ResearchSnapshot {
  id: string;
  user_id: string;
  symbol: string;
  collected_at: string;
  price_usd: number | null;
  market_cap_usd: number | null;
  volume_24h_usd: number | null;
  /** 글로벌 시총 점유율(%) */
  dominance_pct: number | null;
  /** 시장 전체 지수 — 심볼과 무관하게 같은 값이 기록된다 */
  fear_greed: number | null;
  fear_greed_label: string | null;
  /** 소수 — 0.0001 = 0.01% */
  funding_rate: number | null;
  open_interest: number | null;
  open_interest_usd: number | null;
  headlines: ResearchHeadline[];
  /** 소스별 성공/실패 — `{"coingecko":"ok","okx":"error: ..."}` */
  sources: Record<string, string>;
}

export const RESEARCH_NOTE_CATEGORY_LABEL: Record<ResearchNoteCategory, string> = {
  fundamental: '기본적 분석',
  onchain: '온체인·수급',
  regulation: '규제·정책',
  social: '사회·채택',
  macro: '매크로',
  briefing: 'AI 브리핑',
};

/** 화면에 뜨는 묶음 순서 — 종목 자체의 가치부터, 브리핑은 종합이라 맨 뒤. */
export const RESEARCH_NOTE_CATEGORIES: ResearchNoteCategory[] = [
  'fundamental',
  'onchain',
  'regulation',
  'social',
  'macro',
  'briefing',
];
