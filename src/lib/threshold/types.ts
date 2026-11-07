/**
 * 시장 구조적 임계점 — 공용 타입과 기준값(REQ-0102).
 *
 * 세 임계점(변동성 팽창·감마 스퀴즈·유동성 공백)과 감마의 보조(스퀴즈 연료)를
 * "내 방향으로 켜졌나(on)"와 "추가 금지 경고(warn)"로 판정한다.
 * 측정하지 못한 것은 measured=false — 꺼짐(0)으로 보이면 안 된다.
 */

export type SignalSide = 'long' | 'short';

export interface SignalState {
  /** 켜진 방향 — 없으면 null */
  on: SignalSide | null;
  /** 추가 금지 경고 */
  warn: boolean;
  /** 판정 재료를 다 받았나. false 면 on·warn 은 의미 없다 */
  measured: boolean;
  /** 화면에 그대로 보일 판정 근거 */
  reasons: string[];
}

export type SignalTf = '15m' | '1H' | '4H' | '1D';

export interface VolatilityTf {
  tf: SignalTf;
  /** 판정에 쓴 마지막 마감 봉 시각 */
  lastClosedMs: number;
  /** BB폭 백분위(0~1) — 최근 120봉 중 지금보다 좁았던 비율 */
  bbwPct: number | null;
  /** ATR(5) ÷ ATR(50) */
  atrRatio: number | null;
  /** 직전 10봉 안에 압축(BB폭 하위 20% 또는 BB 가 켈트너 안)이 있었나 */
  squeezeWithin10: boolean;
  /** 지금 BB 가 켈트너 안(스퀴즈) */
  squeezeNow: boolean;
  /** BB폭 3봉 연속 확대 */
  bbwExpanding3: boolean;
  /** 종가가 밴드 밖 */
  closeOutside: 'upper' | 'lower' | null;
  /** ATR(14) ÷ 왕복 비용 */
  atrOverCost: number | null;
  /** 상태 글 — 압축·팽창 중·과열(끝물)·보통 */
  label: string;
  state: SignalState;
}

export interface GammaReport {
  spot: number;
  /** 현재가 근처 순 감마 부호(가정 부호) */
  netGexNearSpot: number | null;
  flipStrike: number | null;
  callWall: number | null;
  putWall: number | null;
  wallDistPct: { call: number | null; put: number | null };
  /** 진행 방향 다음 벽까지 거리(%) */
  nextWallDistPct: number | null;
  bigExpiry: { expiry: string; hoursLeft: number; oiShare: number } | null;
  state: SignalState;
}

export interface FuelReport {
  /** 8시간 펀딩비(소수 — 0.0001 = 0.01%) */
  fundingRate: number | null;
  /** 연환산 펀딩(소수) */
  fundingAnnual: number | null;
  /** 가격 24시간 변화(소수) */
  priceChg24h: number | null;
  /** 미결제약정 24시간 변화(%) */
  oiChg24hPct: number | null;
  state: SignalState;
}

export interface VolumeBin {
  lo: number;
  hi: number;
  vol: number;
}

export interface PriceRange {
  lo: number;
  hi: number;
}

export interface LiquidityReport {
  bins: VolumeBin[];
  lvn: PriceRange[];
  hvn: PriceRange[];
  /** 현재가 → 위쪽 가장 가까운 공백 하단 거리(%) */
  gapUpDistPct: number | null;
  /** 현재가 → 아래쪽 가장 가까운 공백 상단 거리(%, 양수) */
  gapDownDistPct: number | null;
  /** 현재가 칸이 고거래량 */
  inHvn: boolean;
  /** 위 0.5% 매도 깊이 ÷ 아래 0.5% 매수 깊이 — 측정 못 하면 null */
  depthRatio: number | null;
  state: SignalState;
}

export interface ThresholdSummary {
  /**
   * 방향별 추가 금지 경고 이름들 — 같은 사실이 한쪽에만 경고일 수 있다
   * (바로 위 고거래량은 롱 추가 경고, 바로 아래는 숏 추가 경고. 펀딩 연 +30% 는 롱, −30% 는 숏).
   * 방향 없는 경고(변동성 과열·감마 핀닝)는 양쪽에 다 들어간다.
   */
  warnings: Record<SignalSide, string[]>;
  on: Record<SignalSide, number>;
  /** 네 가지 중 측정된 것 수 */
  measuredCount: number;
  /** 넷 다 측정됐나 */
  measured: boolean;
}

export interface ThresholdReport {
  symbol: string;
  collectedAt: string;
  spot: number | null;
  volatility: VolatilityTf[];
  gamma: GammaReport | null;
  fuel: FuelReport | null;
  liquidity: LiquidityReport | null;
  summary: ThresholdSummary;
  /** 소스별 상태 글 — 'ok' 또는 실패 사유 */
  sources: Record<'candles' | 'options' | 'derivs' | 'book', string>;
}

/** 초기값 — 검증 전. 시험 전에 고정하고, 신호 켜짐/꺼짐별 MER 로 확인한 뒤에만 고친다. */
export const THRESHOLD_RULES = {
  bbPeriod: 20,
  bbStd: 2,
  keltnerAtr: 10,
  keltnerMult: 1.5,
  bbwLookback: 120,
  bbwSqueezePct: 0.2,
  bbwWarnPct: 0.95,
  atrFast: 5,
  atrSlow: 50,
  atrRatioOn: 1.3,
  atrRatioWarn: 2.0,
  squeezeLookback: 10,
  bbwExpandBars: 3,
  wallGapOnPct: 1.5,
  wallNearWarnPct: 0.5,
  bigExpiryHours: 48,
  oiChgOnPct: 5,
  fundingAnnualWarn: 0.3,
  profileDays: 20,
  binPct: 0.0025,
  lvnMedianRatio: 0.35,
  hvnMedianRatio: 1.5,
  lvnMinBins: 3,
  gapEntryPct: 0.3,
  depthPct: 0.005,
  depthRatioOn: 0.5,
} as const;
