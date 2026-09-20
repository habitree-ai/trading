/**
 * 옵션 지표 안내 — 카드마다 붙는 「무엇인가 · 어떻게 읽나」 두 줄과 「지금 값의 뜻」 한 줄.
 *
 * `@/lib/verdict` 의 옵션판이다. 옵션 화면은 DVOL·풋콜비·스큐·GEX 처럼 숫자만 봐서는
 * 방향조차 안 잡히는 값이 많아, 밴드와 문구를 한곳에 모아 두지 않으면 카드마다 기준이
 * 갈린다. 계산(analyze)과 갈라 둔 이유는 해석이 숫자를 바꾸지 않게 하려는 것 —
 * 여기는 `OptionsAnalysis` 의 값을 읽기만 하고 아무것도 계산하지 않는다.
 *
 * 경계값은 BTC 옵션 시장의 관행에서 가져왔고 근거는 각 밴드 상수에 적는다. 절대 기준이
 * 아니므로 문구는 항상 어느 밴드에 걸렸는지(숫자)를 함께 말한다. 색(tone)은 매수·매도
 * 권고가 아니다 — neutral 은 보통 밴드, warn 은 한쪽으로 치우침, bad 는 극단, good 은
 * "정상 구조"(콘탱고·보통 IV 프리미엄)에만 쓴다.
 */

import { num, pct, signed } from "@/lib/format";
import { pickHeadline } from "@/lib/options/analyze";
import { usdCompact } from "@/lib/options/format";
import type { IndicatorGuide, IvTermPoint, TakerBlockFlow } from "@/lib/options/types";
import type { Verdict } from "@/lib/verdict";

export type IndicatorKey =
  | "oi"
  | "volume"
  | "pcrOi"
  | "pcrVol"
  | "dvol"
  | "atmIv"
  | "rv30"
  | "ivMinusRv"
  | "maxPain"
  | "walls"
  | "ivTerm"
  | "skew"
  | "gex"
  | "flow"
  | "history";

/* ── 지표 설명 ───────────────────────────────────────────── */

/** 화면 카드의 두 줄 — 값과 무관한 고정 문구라 상수로 둔다. */
export const OPTION_GUIDE: Record<IndicatorKey, IndicatorGuide> = {
  oi: {
    what: "미결제약정 — 아직 청산되지 않은 옵션 계약 수. OKX·Deribit 합, BTC 개수와 USD 환산(OI × 지수가).",
    how: "높을수록 옵션에 걸린 돈이 많아 만기·벽의 영향력이 크다. 줄어들면 포지션 정리나 관심 이탈.",
  },
  volume: {
    what: "24h 옵션 거래량 — 두 거래소 합, BTC 개수.",
    how: "OI 대비 거래량이 크면 포지션 교체가 활발(이벤트·급변), 작으면 보유 위주의 조용한 장.",
  },
  pcrOi: {
    what: "풋콜비(OI) = 풋 OI ÷ 콜 OI. 두 거래소 합.",
    how: "1.0 이상이면 풋(하락 보호) 잔고가 콜보다 많고, 0.7 아래면 콜(상승 베팅) 잔고가 많다. 0.7~1.0 이 보통.",
  },
  pcrVol: {
    what: "풋콜비(거래량) = 24h 풋 거래량 ÷ 콜 거래량. 두 거래소 합.",
    how: "OI 비율과 같은 밴드로 읽되 하루 흐름이라 빨리 바뀐다 — 오늘 풋을 많이 샀는지 콜을 많이 샀는지.",
  },
  dvol: {
    what: "DVOL — Deribit 이 BTC 옵션에서 뽑는 30일 내재변동성 지수(연율, 소수). 주식의 VIX 에 해당.",
    how: "40% 아래 조용, 40~60% 보통, 60~80% 높음, 80% 이상 이벤트·패닉. 높을수록 옵션이 비싸고 시장이 큰 움직임을 대비한다.",
  },
  atmIv: {
    what: "근월 ATM 내재변동성 — 그 만기의 선도가에 가장 가까운 행사가의 마크 IV(연율, 소수). 머리에 적힌 IV 거래소 값.",
    how: "DVOL 보다 짧은 창의 변동성 기대. DVOL 보다 뚜렷이 높으면 근월 안의 이벤트를 가격에 넣고 있다.",
  },
  rv30: {
    what: "실현변동성 30일 — OKX 일봉 종가 로그수익률의 표본표준편차 × √365(연율, 소수).",
    how: "이미 일어난 움직임의 크기. IV 와 견줘 옵션이 비싼지 싼지를 재는 기준선.",
  },
  ivMinusRv: {
    what: "IV − RV = DVOL − RV30 (소수 차이). 양수면 옵션이 실제 움직임보다 비싸게 거래된다.",
    how: "+10%p 위면 프리미엄이 두텁고(시장이 큰 움직임 대비), −5%p 아래면 실현이 IV 를 넘어 이미 움직이는 중. −5~+10%p 가 보통.",
  },
  maxPain: {
    what: "맥스페인 — 만기 시 옵션 매수자의 손실 합이 최대(매도자 이익 최대)가 되는 행사가. 만기별 OI 로 계산.",
    how: "만기 근처에서 가격이 이 값 쪽으로 끌린다는 가설이지 규칙이 아니다. 현재가와 멀면 끌림이 아니라 OI 가 한쪽에 몰렸다는 뜻.",
  },
  walls: {
    what: "콜벽·풋벽 — 현재가 위에서 콜 OI 가 가장 큰 행사가, 아래에서 풋 OI 가 가장 큰 행사가(전체 만기 합).",
    how: "OI 가 몰린 곳이라 저항·지지 후보로 본다. 확정 지지/저항이 아니며, 뚫리면 헤지 되감기로 오히려 가속될 수 있다.",
  },
  ivTerm: {
    what: "IV 기간구조 — 만기별 ATM IV 를 만기 순으로 늘어놓은 것.",
    how: "근월 < 원월(콘탱고)이 정상. 근월 > 원월(역전)은 단기 이벤트·스트레스를 가격에 넣은 상태.",
  },
  skew: {
    what: "25Δ 스큐(리스크 리버설) = IV(25Δ 콜) − IV(25Δ 풋), 근월, 소수 차이.",
    how: "음수면 풋이 더 비싸다(하락 보호 수요). BTC 는 평소 약한 풋 스큐(−5~0%p). +3%p 위면 콜 추격(FOMO), −5%p 아래면 공포.",
  },
  gex: {
    what: "감마 익스포저 — 행사가별 OI × 감마로, 현물이 1% 움직일 때 딜러가 헤지해야 하는 USD. 딜러가 콜 롱·풋 숏이라는 가정 위의 추정치.",
    how: "양수면 딜러가 롱감마라 움직임을 되돌린다(변동성 억제·레인지). 음수면 숏감마라 움직임을 키운다(추세·변동 확대). 플립 행사가가 그 경계.",
  },
  flow: {
    what: "OKX 테이커 일간 흐름 — 콜·풋을 시장가로 산/판 BTC 개수(UTC+8 하루, 마감값). 블록 거래량은 OKX 가 단위를 밝히지 않아 쓰지 않는다.",
    how: "콜 매수+풋 매도 = 강세, 콜 매도+풋 매수 = 약세·헤지, 둘 다 매수 = 변동성 매수, 둘 다 매도 = 변동성 매도. 한 거래소 하루치라 방향 참고용.",
  },
  history: {
    what: "OKX 옵션 OI·거래량·풋콜비 24일 추이(8시간 간격).",
    how: "OI 가 늘며 풋콜비가 오르면 하락 대비가 쌓이는 중, OI 가 줄면 포지션 정리. 오늘 값이 추이 어디에 있는지를 본다.",
  },
};

/* ── 해석 ───────────────────────────────────────────────── */

/** 재료가 없을 때의 공통 답 — 화면은 이걸 회색으로 보여 주고 값 자리는 `—` 다. */
function none(reason: string): Verdict {
  return { tone: "neutral", text: `재료 없음 — ${reason}` };
}

/*
 * 풋콜비 밴드 — 0.7 / 1.0.
 *
 * 1.0 은 풋과 콜이 같은 지점이라 그 위는 풋이 더 많다는 뜻이다. BTC 옵션은 콜이 늘 더
 * 많아(채굴자·보유자의 커버드콜, 상승 베팅) 평소 0.5~0.7 근처에 머무르고, 0.7 을 밑돌면
 * 콜 쪽 쏠림이 평소보다 심한 것으로 본다.
 */
const PCR_CALL = 0.7;
const PCR_PUT = 1.0;

/**
 * 풋콜비 — OI 기준은 쌓인 잔고, 거래량 기준은 오늘 하루의 흐름.
 *
 * 밴드는 같지만 거래량 쪽은 "오늘" 이라고 말한다. 하루치라 내일이면 뒤집힐 수 있는 값이라
 * 잔고처럼 읽으면 과하게 반응하게 된다.
 */
export function readPcr(pcr: number | null, basis: "oi" | "vol"): Verdict {
  if (pcr === null || !Number.isFinite(pcr)) {
    return none(basis === "oi" ? "콜 OI 가 0이거나 수집이 비었습니다." : "콜 거래량이 0이거나 수집이 비었습니다.");
  }
  const label = basis === "oi" ? "풋콜비(OI)" : "풋콜비(거래량)";
  const scope = basis === "oi" ? "" : "오늘 ";
  const value = num(pcr, 2);

  if (pcr >= PCR_PUT) {
    return {
      tone: "warn",
      text: `${label} ${value} — ${num(PCR_PUT, 1)} 이상이라 ${scope}풋이 콜보다 많습니다. 헤지·하락 대비가 ${basis === "oi" ? "쌓여 있는" : "몰린"} 쪽으로 읽습니다.`,
    };
  }
  if (pcr >= PCR_CALL) {
    return {
      tone: "neutral",
      text: `${label} ${value} — ${num(PCR_CALL, 1)}~${num(PCR_PUT, 1)} 의 보통 밴드입니다. ${scope}어느 쪽으로도 뚜렷이 쏠리지 않았습니다.`,
    };
  }
  return {
    tone: "warn",
    text: `${label} ${value} — ${num(PCR_CALL, 1)} 아래라 ${scope}콜이 풋보다 훨씬 많습니다. 상승 베팅·낙관이 ${basis === "oi" ? "쌓여 있는" : "몰린"} 쪽으로 읽습니다.`,
  };
}

/*
 * DVOL 밴드 — 40 / 60 / 80 (%).
 *
 * BTC DVOL 은 2021 년 이후 대략 35~150 사이를 오갔다. 40 아래는 강세장 후반·횡보의
 * 바닥권, 60 을 넘는 날은 손에 꼽히고, 80 은 2022 년 폭락·ETF 같은 이벤트에서만 찍혔다.
 */
const DVOL_LOW = 0.4;
const DVOL_HIGH = 0.6;
const DVOL_EXTREME = 0.8;

/** DVOL — 시장이 앞으로 30일에 얼마나 큰 움직임을 가격에 넣고 있나. */
export function readDvol(dvol: number | null): Verdict {
  if (dvol === null || !Number.isFinite(dvol)) return none("Deribit DVOL 을 받지 못했습니다.");
  const value = pct(dvol, 1);

  if (dvol >= DVOL_EXTREME) {
    return {
      tone: "bad",
      text: `DVOL ${value} — ${pct(DVOL_EXTREME, 0)} 이상은 이벤트·패닉 구간입니다. 옵션이 극단적으로 비싸고 시장이 급변을 가격에 넣고 있습니다.`,
    };
  }
  if (dvol >= DVOL_HIGH) {
    return {
      tone: "warn",
      text: `DVOL ${value} — ${pct(DVOL_HIGH, 0)}~${pct(DVOL_EXTREME, 0)} 의 높은 구간입니다. 옵션이 비싸고 시장이 큰 움직임을 대비하고 있습니다.`,
    };
  }
  if (dvol >= DVOL_LOW) {
    return {
      tone: "neutral",
      text: `DVOL ${value} — ${pct(DVOL_LOW, 0)}~${pct(DVOL_HIGH, 0)} 의 보통 밴드입니다.`,
    };
  }
  return {
    tone: "warn",
    text: `DVOL ${value} — ${pct(DVOL_LOW, 0)} 아래의 조용한 구간입니다. 옵션이 싸서 큰 움직임에 대비하는 비용이 낮습니다.`,
  };
}

/*
 * IV − RV 밴드 — −5%p / +10%p.
 *
 * 옵션은 평소 실현보다 조금 비싸다(변동성 프리미엄). BTC 에서 그 폭은 대개 0~10%p 라
 * 그 안은 정상 구조로 보고, 10%p 를 넘으면 프리미엄이 두텁다고 본다. 실현이 IV 를
 * 5%p 넘게 앞서면 옵션이 움직임을 따라가지 못하는 상태다.
 */
const IVRV_CHEAP = -0.05;
const IVRV_RICH = 0.1;

/** IV − RV — 옵션이 실제 움직임보다 비싼가 싼가. 보통 프리미엄은 정상 구조라 good. */
export function readIvMinusRv(diff: number | null): Verdict {
  if (diff === null || !Number.isFinite(diff)) return none("DVOL 과 실현변동성이 모두 있어야 계산됩니다.");
  const value = `${diff > 0 ? "+" : ""}${pct(diff, 1)}p`;

  if (diff > IVRV_RICH) {
    return {
      tone: "warn",
      text: `IV−RV ${value} — +${pct(IVRV_RICH, 0)}p 를 넘어 옵션이 실현보다 비쌉니다. 프리미엄이 두텁고 시장이 큰 움직임을 대비하고 있습니다.`,
    };
  }
  if (diff >= IVRV_CHEAP) {
    return {
      tone: "good",
      text: `IV−RV ${value} — ${pct(IVRV_CHEAP, 0)}~+${pct(IVRV_RICH, 0)}p 의 보통 프리미엄입니다. 옵션이 실현을 조금 웃도는 정상 구조입니다.`,
    };
  }
  return {
    tone: "warn",
    text: `IV−RV ${value} — ${pct(IVRV_CHEAP, 0)}p 아래라 실현이 IV 보다 큽니다. 변동성이 과소평가됐거나 이미 움직이는 중입니다.`,
  };
}

/*
 * 맥스페인 거리 밴드 — 2% / 5%.
 *
 * BTC 는 만기 주에 1~2% 는 늘 움직이니 그 안은 "이미 거기" 다. 5% 를 넘으면 만기 전에
 * 끌려갈 거리라기보다 OI 가 한쪽에 몰려 있다는 사실 쪽이 정보다.
 */
const PAIN_NEAR = 0.02;
const PAIN_FAR = 0.05;

/**
 * 맥스페인 — 현재가에서 얼마나, 어느 쪽에 있나.
 *
 * 끌림 가설은 만기가 가까울수록만 뜻이 있어서 D-n 을 같이 말한다.
 */
export function readMaxPain(
  maxPain: number | null,
  spot: number | null,
  dte: number | null,
): Verdict {
  if (maxPain === null || spot === null || !(spot > 0)) {
    return none("맥스페인이나 기준가가 없습니다.");
  }
  const dist = (maxPain - spot) / spot;
  const abs = Math.abs(dist);
  const dir = dist > 0 ? "위" : dist < 0 ? "아래" : "같은 자리";
  const when = dte === null ? "만기일 미상" : `만기 D-${Math.ceil(dte)}`;
  const head = `${when} · 맥스페인 ${num(maxPain, 0)} — 현재가 ${dir}${dist === 0 ? "" : ` ${pct(abs, 1)}`}`;

  if (abs < PAIN_NEAR) {
    return {
      tone: "neutral",
      text: `${head}. ${pct(PAIN_NEAR, 0)} 안이라 현재가와 거의 같은 자리입니다 — 끌림 가설이 맞더라도 갈 곳이 없습니다.`,
    };
  }
  if (abs <= PAIN_FAR) {
    return {
      tone: "warn",
      text: `${head}. ${pct(PAIN_NEAR, 0)}~${pct(PAIN_FAR, 0)} 거리라 만기 전 그쪽으로 끌릴 수 있다는 가설 구간입니다 — 규칙이 아니라 가설입니다.`,
    };
  }
  return {
    tone: "warn",
    text: `${head}. ${pct(PAIN_FAR, 0)} 넘게 멀어서 만기 전 되돌림 가설이 강한 구간이라기보다 OI 가 한쪽에 몰린 것으로 읽습니다.`,
  };
}

/*
 * 25Δ 스큐 밴드 — −5%p / 0 / +3%p.
 *
 * BTC 는 주식과 달리 평소에도 풋 스큐가 약하다(보유자가 콜을 팔고 하락 보호는 덜 산다).
 * −5%p 아래는 2022 년 폭락 같은 공포 구간에서 보이고, 콜이 풋보다 3%p 넘게 비싸지는
 * 것은 상승 추격이 몰린 날이다.
 */
const SKEW_FEAR = -0.05;
const SKEW_FOMO = 0.03;

/** 25Δ 리스크 리버설 — 하락 보호(풋)와 상승 추격(콜) 중 어느 쪽이 비싼가. */
export function readSkew(rr25: number | null): Verdict {
  if (rr25 === null || !Number.isFinite(rr25)) return none("25Δ 콜·풋 IV 를 뽑을 만한 행사가가 없습니다.");
  const value = `${rr25 > 0 ? "+" : ""}${pct(rr25, 1)}p`;

  if (rr25 < SKEW_FEAR) {
    return {
      tone: "bad",
      text: `25Δ 스큐 ${value} — ${pct(SKEW_FEAR, 0)}p 아래의 강한 풋 스큐입니다. 하락 보호 수요가 몰린 공포 구간으로 읽습니다.`,
    };
  }
  if (rr25 <= 0) {
    return {
      tone: "neutral",
      text: `25Δ 스큐 ${value} — ${pct(SKEW_FEAR, 0)}~0%p 의 약한 풋 스큐로, BTC 의 평소 모양입니다.`,
    };
  }
  if (rr25 <= SKEW_FOMO) {
    return {
      tone: "warn",
      text: `25Δ 스큐 ${value} — 0~+${pct(SKEW_FOMO, 0)}p 로 콜이 풋보다 비쌉니다. 상승 쪽 수요가 앞서는 콜 우위입니다.`,
    };
  }
  return {
    tone: "bad",
    text: `25Δ 스큐 ${value} — +${pct(SKEW_FOMO, 0)}p 를 넘는 강한 콜 스큐입니다. 상승 추격·FOMO 가 몰린 구간으로 읽습니다.`,
  };
}

/**
 * GEX — 딜러 헤지가 움직임을 누르는가 키우는가.
 *
 * 부호가 전부다. 양수(롱감마)는 오르면 팔고 내리면 사서 되돌리는 힘, 음수(숏감마)는
 * 오르면 사고 내리면 팔아 키우는 힘이다. 크기는 그 힘이 얼마나 큰지의 어림값일 뿐이라
 * 밴드를 두지 않는다.
 */
export function readGex(total: number | null): Verdict {
  if (total === null || !Number.isFinite(total)) return none("IV 재료가 없어 감마를 구하지 못했습니다.");
  // 부호는 문구가 따로 붙인다 — 크기만 축약.
  const size = `${usdCompact(Math.abs(total))}/1%`;

  if (total > 0) {
    return {
      tone: "neutral",
      text: `GEX +${size} — 양수라 딜러가 롱감마입니다. 움직임을 되돌리는 힘(변동성 억제·레인지)이 우세합니다. 딜러가 콜 롱·풋 숏이라는 가정 위의 추정치입니다.`,
    };
  }
  if (total < 0) {
    return {
      tone: "warn",
      text: `GEX −${size} — 음수라 딜러가 숏감마입니다. 움직임을 키우는 힘(추세·변동 확대)이 우세합니다. 딜러가 콜 롱·풋 숏이라는 가정 위의 추정치입니다.`,
    };
  }
  return { tone: "neutral", text: "GEX 0 — 콜과 풋의 감마가 상쇄돼 딜러 헤지 방향이 없습니다." };
}

/**
 * 콜벽·풋벽 — 현재가에서 위·아래로 얼마나 떨어져 있나.
 *
 * 밴드가 없다. OI 가 몰린 행사가는 저항·지지 후보일 뿐이고 그 거리가 좋고 나쁨을 정하지
 * 않는다 — 문구는 거리와 "후보" 라는 말만 전한다.
 */
export function readWalls(
  callWall: number | null,
  putWall: number | null,
  spot: number | null,
): Verdict {
  if (spot === null || !(spot > 0)) return none("기준가가 없어 벽까지의 거리를 잴 수 없습니다.");
  if (callWall === null && putWall === null) return none("OI 가 몰린 행사가가 현재가 위아래에 없습니다.");

  const parts: string[] = [];
  if (callWall !== null) {
    parts.push(`위 콜벽 ${num(callWall, 0)}(+${pct((callWall - spot) / spot, 1)})`);
  }
  if (putWall !== null) {
    parts.push(`아래 풋벽 ${num(putWall, 0)}(−${pct((spot - putWall) / spot, 1)})`);
  }
  const missing =
    callWall === null ? " 현재가 위에는 콜 OI 가 몰린 곳이 없습니다." : putWall === null ? " 현재가 아래에는 풋 OI 가 몰린 곳이 없습니다." : "";

  return {
    tone: "neutral",
    text: `${parts.join(" · ")} — OI 가 몰린 행사가라 저항·지지 후보로 봅니다. 확정 지지/저항은 아닙니다.${missing}`,
  };
}

/**
 * OKX 테이커 흐름 — 콜·풋 순매수 부호의 네 조합.
 *
 * 순매수 = 매수 − 매도. 방향 흐름(강세·약세)은 치우침이라 warn, 변동성 흐름(둘 다 매수·
 * 둘 다 매도)은 방향이 없어 neutral 로 둔다. 한 거래소 하루치라 어느 쪽이든 참고용이다.
 */
export function readFlow(flow: TakerBlockFlow | null): Verdict {
  if (flow === null) return none("OKX 테이커 흐름을 받지 못했습니다.");
  const callNet = flow.callBuy - flow.callSell;
  const putNet = flow.putBuy - flow.putSell;
  const head = `OKX 일간 테이커 기준 — 콜 순매수 ${signed(callNet, 1)} BTC · 풋 순매수 ${signed(putNet, 1)} BTC`;

  if (callNet === 0 && putNet === 0) {
    return { tone: "neutral", text: `${head}. 사고 판 양이 같아 방향이 없습니다.` };
  }
  const callBought = callNet > 0;
  const putBought = putNet > 0;

  if (callBought && !putBought) {
    return { tone: "warn", text: `${head}. 콜을 사고 풋을 파는 강세 흐름입니다.` };
  }
  if (!callBought && putBought) {
    return { tone: "warn", text: `${head}. 콜을 팔고 풋을 사는 약세·헤지 흐름입니다.` };
  }
  if (callBought && putBought) {
    return {
      tone: "neutral",
      text: `${head}. 콜과 풋을 둘 다 사는 변동성 매수입니다 — 방향보다 큰 움직임에 거는 흐름입니다.`,
    };
  }
  return {
    tone: "neutral",
    text: `${head}. 콜과 풋을 둘 다 파는 변동성 매도입니다 — 프리미엄을 받고 조용한 장에 거는 흐름입니다.`,
  };
}

/**
 * IV 기간구조 — 근월과 최원월의 ATM IV 를 견준다.
 *
 * `ivTerm` 은 계약상 만기 오름차순이다. 근월은 `pickHeadline`(일주일 이상 남은 첫 점)이고
 * 끝 점이 최원월이다 — 만기 직전 점은 잡음이라 비교에서 빼되, 그 점이 근월보다 뚜렷이
 * 높으면(1%p 초과) 문구 끝에 따로 말한다. 콘탱고는 옵션 시장의 정상 구조라 good, 역전은
 * 단기에 무언가 잡혀 있다는 뜻이라 warn.
 */
export function readIvTerm(ivTerm: IvTermPoint[]): Verdict {
  const near = pickHeadline(ivTerm);
  const far = ivTerm[ivTerm.length - 1];
  if (near === null || far === undefined || near === far) {
    return none("일주일 이상 남은 만기를 포함해 둘 이상 있어야 기간구조를 견줍니다.");
  }
  const nearLabel = `근월 ${near.expiry}(D-${Math.ceil(near.dte)}) ${pct(near.atmIv, 1)}`;
  const farLabel = `최원월 ${far.expiry}(D-${Math.ceil(far.dte)}) ${pct(far.atmIv, 1)}`;

  // 근월 앞의 만기 직전 점들 — 비교에서 뺀 이유를 숨기지 않는다.
  const front = ivTerm.slice(0, ivTerm.indexOf(near)).filter((point) => point.atmIv > near.atmIv + 0.01);
  const frontNote =
    front.length === 0
      ? ""
      : ` 만기 직전 ${front.map((point) => `${point.expiry}(D-${Math.ceil(point.dte)}) ${pct(point.atmIv, 1)}`).join(", ")} 은 더 높지만 잔여일이 짧아 비교에서 뺐습니다.`;

  if (near.atmIv < far.atmIv) {
    return {
      tone: "good",
      text: `${nearLabel} < ${farLabel} — 콘탱고(정상). 단기는 조용하고 먼 만기에 불확실성이 실려 있습니다.${frontNote}`,
    };
  }
  if (near.atmIv > far.atmIv) {
    return {
      tone: "warn",
      text: `${nearLabel} > ${farLabel} — 역전. 단기 이벤트·스트레스를 가격에 넣고 있습니다.${frontNote}`,
    };
  }
  return { tone: "neutral", text: `${nearLabel} = ${farLabel} — 평평합니다. 만기별 변동성 기대가 같습니다.${frontNote}` };
}
