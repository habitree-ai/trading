/**
 * 옵션 분석 계층의 타입 — 두 거래소(OKX·Deribit)의 BTC 옵션을 한 모양으로 편다.
 *
 * 단위는 여기서 고정한다. BTC 옵션은 두 거래소 모두 코인 정산이라 OI·거래량은 **BTC 개수**,
 * IV 는 **소수**(0.38 = 38%), 가격은 **USD** 다. 계산·화면이 단위를 되묻지 않게 하려는 것이다.
 * 만기 키는 UTC 날짜 `YYYY-MM-DD` — 두 거래소 모두 08:00 UTC 에 정산하므로 같은 날짜면
 * 같은 만기다(OKX `260925` 와 Deribit `25SEP26` 이 한 키로 합쳐진다).
 */

export type OptionVenue = "okx" | "deribit";
export type OptionType = "C" | "P";

/** 옵션 한 종목의 현재 상태 — 거래소 응답을 이 모양으로 정규화한다. */
export interface OptionRow {
  venue: OptionVenue;
  /** 거래소 원래 종목 코드 — `BTC-USD-260925-80000-C` / `BTC-25SEP26-80000-C`. */
  instId: string;
  /** 만기일 — UTC `YYYY-MM-DD`. */
  expiry: string;
  /** 만기 시각(epoch ms, 08:00 UTC). */
  expiryMs: number;
  strike: number;
  type: OptionType;
  /** 미결제약정 — BTC 개수. */
  oi: number;
  /** 24h 거래량 — BTC 개수. 못 받았으면 null. */
  vol24h: number | null;
  /** 마크 내재변동성 — 소수(0.38 = 38%). 못 받았으면 null. */
  markIv: number | null;
  /** 이 만기의 선도가격(USD) — 거래소가 주는 값. 못 받았으면 null. */
  forward: number | null;
}

/**
 * OKX 테이커·블록 일간 흐름. 테이커 넷은 BTC 개수(정산통화). 블록 둘은 OKX 문서가 단위를
 * 주지 않고 실측도 BTC 가 아니다(공개 블록 체결 합의 60~130배) — 파싱만 하고 화면에 쓰지 않는다.
 */
export interface TakerBlockFlow {
  /** 봉의 끝 시각(ms) — UTC+8 자정. 값은 그 앞 하루치 확정값. */
  ts: number;
  callBuy: number;
  callSell: number;
  putBuy: number;
  putSell: number;
  callBlock: number;
  putBlock: number;
}

/** OKX OI·거래량·풋콜비 이력 한 점(8H 간격). */
export interface OkxHistoryPoint {
  t: number;
  /** 총 OI (BTC). */
  oi: number;
  /** 구간 거래량 (BTC). */
  vol: number;
  /** 풋/콜 OI 비율 — OKX 는 콜/풋(oiRatio)로 주므로 파서가 뒤집는다. */
  pcrOi: number;
  /** 풋/콜 거래량 비율 — 같은 이유로 뒤집힌 값. */
  pcrVol: number;
}

export const OPTION_SOURCE_KEYS = ["okx", "deribit", "dvol", "candles"] as const;
export type OptionSourceKey = (typeof OPTION_SOURCE_KEYS)[number];
/** 소스별 성공/실패 — `"ok"` 또는 `"error: ..."`. */
export type OptionSourceStatus = Record<OptionSourceKey, string>;

/** 수집 결과 — 계산 전 원재료. 소스가 죽은 자리는 비어 있고 `sources` 에 사유가 남는다. */
export interface OptionsSnapshot {
  /** ISO 시각. */
  collectedAt: string;
  /** BTC-USD 지수가(USD). OKX 지수, 없으면 Deribit 지수. */
  indexPrice: number | null;
  /** 두 거래소 종목을 합친 목록 — OI 0 인 종목은 뺀다. */
  rows: OptionRow[];
  okxFlow: TakerBlockFlow | null;
  /** 오래된 것부터. */
  okxHistory: OkxHistoryPoint[];
  /** Deribit DVOL 최근 종가 — 소수(0.34 = 34%). */
  dvol: number | null;
  /** 최근 일봉 종가, 오래된 것부터(진행 중인 오늘 봉 제외) — 실현변동성 재료. */
  dailyCloses: number[];
  sources: OptionSourceStatus;
}

/* ── 분석 결과 ───────────────────────────────────────────── */

export interface VenueTotals {
  venue: OptionVenue;
  oi: number;
  vol24h: number;
}

export interface ExpirySummary {
  expiry: string;
  expiryMs: number;
  /** 남은 일수(소수, 0 이상). */
  dte: number;
  callOi: number;
  putOi: number;
  callVol: number;
  putVol: number;
  /** 풋/콜 OI. 콜 OI 가 0 이면 null. */
  pcrOi: number | null;
  /** 맥스페인 행사가(USD). OI 가 없으면 null. */
  maxPain: number | null;
  /** ATM 내재변동성(소수). IV 재료가 없으면 null. */
  atmIv: number | null;
  /** 25Δ 리스크 리버설 = IV(25Δ 콜) − IV(25Δ 풋), 소수 차이. 못 구하면 null. */
  rr25: number | null;
  /** 선도가격(USD). */
  forward: number | null;
}

export interface StrikeRow {
  strike: number;
  callOi: number;
  putOi: number;
}

export interface GexRow {
  strike: number;
  /** USD / 현물 1% 변동. 콜 +, 풋 −. */
  gex: number;
}

export interface IvTermPoint {
  expiry: string;
  dte: number;
  /** 소수. */
  atmIv: number;
}

export interface OptionsAnalysis {
  /** 기준가(USD) — 스냅샷 지수가. */
  spot: number | null;
  totals: {
    oi: number;
    /** oi × spot. spot 이 없으면 null. */
    oiUsd: number | null;
    vol24h: number;
    pcrOi: number | null;
    pcrVol: number | null;
    byVenue: VenueTotals[];
  };
  /** 만기 오름차순. */
  expiries: ExpirySummary[];
  /** 만기별 행사가 분포(행사가 오름차순) — key 는 expiry, `"all"` 은 전체 합. */
  strikesByExpiry: Record<string, StrikeRow[]>;
  /** 전체 기준 — 현재가 위에서 콜 OI 최대 행사가, 현재가 아래에서 풋 OI 최대 행사가. */
  walls: { callWall: number | null; putWall: number | null };
  gex: {
    /** USD / 1%. 재료가 없으면 null. */
    total: number | null;
    byStrike: GexRow[];
    /** 누적 GEX 부호가 바뀌는 행사가 — 없으면 null. */
    flipStrike: number | null;
  };
  /** 만기 오름차순. */
  ivTerm: IvTermPoint[];
  /** IV 지표를 어느 거래소 값으로 냈는가 — 재료가 없으면 null. */
  ivVenue: OptionVenue | null;
  /** 실현변동성 30일(소수). */
  rv30: number | null;
  /** DVOL(소수). */
  dvol: number | null;
  /** DVOL − RV30 (소수 차이). 어느 쪽이든 없으면 null. */
  ivMinusRv: number | null;
}

/** 지표 설명 — 화면의 「무엇인가 · 어떻게 읽나」 두 줄. */
export interface IndicatorGuide {
  /** 무엇을 재는 값인가(단위·출처 포함). */
  what: string;
  /** 어떻게 읽나 — 높고 낮음이 각각 무슨 뜻인지. */
  how: string;
}
