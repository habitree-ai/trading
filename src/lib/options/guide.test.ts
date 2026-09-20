import { describe, expect, it } from "vitest";

import {
  OPTION_GUIDE,
  readDvol,
  readFlow,
  readGex,
  readIvMinusRv,
  readIvTerm,
  readMaxPain,
  readPcr,
  readSkew,
  readWalls,
  type IndicatorKey,
} from "@/lib/options/guide";
import type { IvTermPoint, TakerBlockFlow } from "@/lib/options/types";

const KEYS: IndicatorKey[] = [
  "oi",
  "volume",
  "pcrOi",
  "pcrVol",
  "dvol",
  "atmIv",
  "rv30",
  "ivMinusRv",
  "maxPain",
  "walls",
  "ivTerm",
  "skew",
  "gex",
  "flow",
  "history",
];

describe("OPTION_GUIDE — 15개 지표의 두 줄이 전부 채워져 있다", () => {
  it.each(KEYS)("%s 의 what/how 가 비어 있지 않다", (key) => {
    expect(OPTION_GUIDE[key].what.trim().length).toBeGreaterThan(0);
    expect(OPTION_GUIDE[key].how.trim().length).toBeGreaterThan(0);
  });

  it("gex 는 딜러 포지션 가정을, maxPain 은 가설임을 명시한다", () => {
    expect(OPTION_GUIDE.gex.what).toContain("딜러가 콜 롱·풋 숏이라는 가정 위의 추정치");
    expect(OPTION_GUIDE.maxPain.how).toContain("가설이지 규칙이 아니다");
  });
});

describe("readPcr — 0.7 / 1.0 밴드, 1.0 과 0.7 은 위 밴드에 든다", () => {
  it("null 은 재료 없음", () => {
    expect(readPcr(null, "oi").tone).toBe("neutral");
    expect(readPcr(null, "vol").text).toContain("재료 없음");
  });

  it("1.0 이상은 풋 우위(warn)", () => {
    expect(readPcr(1.0, "oi")).toMatchObject({ tone: "warn" });
    expect(readPcr(1.0, "oi").text).toContain("풋이 콜보다 많");
    expect(readPcr(1.35, "oi").text).toContain("1.0 이상");
  });

  it("0.7 이상 1.0 미만은 보통(neutral)", () => {
    expect(readPcr(0.7, "oi").tone).toBe("neutral");
    expect(readPcr(0.99, "oi").tone).toBe("neutral");
    expect(readPcr(0.85, "oi").text).toContain("0.7~1.0");
  });

  it("0.7 미만은 콜 우위(warn)", () => {
    expect(readPcr(0.69, "oi")).toMatchObject({ tone: "warn" });
    expect(readPcr(0.5, "oi").text).toContain("콜이 풋보다");
  });

  it("거래량 기준은 오늘이라고 말하고 OI 기준은 말하지 않는다", () => {
    expect(readPcr(1.2, "vol").text).toContain("오늘");
    expect(readPcr(1.2, "vol").text).toContain("풋콜비(거래량)");
    expect(readPcr(1.2, "oi").text).not.toContain("오늘");
  });
});

describe("readDvol — 40 / 60 / 80% 밴드, 경계는 위 밴드에 든다", () => {
  it("null 은 재료 없음", () => {
    expect(readDvol(null).tone).toBe("neutral");
  });

  it("0.40 미만은 조용(warn)", () => {
    expect(readDvol(0.39)).toMatchObject({ tone: "warn" });
    expect(readDvol(0.3).text).toContain("40% 아래");
  });

  it("0.40 이상 0.60 미만은 보통(neutral)", () => {
    expect(readDvol(0.4).tone).toBe("neutral");
    expect(readDvol(0.599).tone).toBe("neutral");
    expect(readDvol(0.5).text).toContain("40%~60%");
  });

  it("0.60 이상 0.80 미만은 높음(warn)", () => {
    expect(readDvol(0.6)).toMatchObject({ tone: "warn" });
    expect(readDvol(0.79).text).toContain("60%~80%");
  });

  it("0.80 이상은 극단(bad)", () => {
    expect(readDvol(0.8)).toMatchObject({ tone: "bad" });
    expect(readDvol(1.2).text).toContain("80% 이상");
  });
});

describe("readIvMinusRv — −5%p / +10%p 밴드, 두 경계 모두 보통에 든다", () => {
  it("null 은 재료 없음", () => {
    expect(readIvMinusRv(null).tone).toBe("neutral");
  });

  it("+0.10 초과는 옵션이 비쌈(warn)", () => {
    expect(readIvMinusRv(0.101)).toMatchObject({ tone: "warn" });
    expect(readIvMinusRv(0.15).text).toContain("실현보다 비쌉니다");
  });

  it("−0.05 이상 +0.10 이하는 보통 프리미엄(good) — 정상 구조", () => {
    expect(readIvMinusRv(0.1).tone).toBe("good");
    expect(readIvMinusRv(-0.05).tone).toBe("good");
    expect(readIvMinusRv(0.03).text).toContain("-5%~+10%p");
  });

  it("−0.05 미만은 실현이 더 큼(warn)", () => {
    expect(readIvMinusRv(-0.051)).toMatchObject({ tone: "warn" });
    expect(readIvMinusRv(-0.1).text).toContain("실현이 IV 보다");
  });
});

describe("readMaxPain — 현재가 대비 2% / 5% 거리, 5% 는 주의에 든다", () => {
  it("맥스페인이나 기준가가 없으면 재료 없음", () => {
    expect(readMaxPain(null, 100_000, 7).tone).toBe("neutral");
    expect(readMaxPain(100_000, null, 7).text).toContain("재료 없음");
  });

  it("2% 안은 보통 — D-n 과 방향을 말한다", () => {
    const v = readMaxPain(101_000, 100_000, 6.2);
    expect(v.tone).toBe("neutral");
    expect(v.text).toContain("만기 D-7");
    expect(v.text).toContain("현재가 위 1.0%");
  });

  it("2% 이상 5% 이하는 주의(warn)", () => {
    expect(readMaxPain(98_000, 100_000, 3)).toMatchObject({ tone: "warn" });
    expect(readMaxPain(98_000, 100_000, 3).text).toContain("현재가 아래 2.0%");
    expect(readMaxPain(105_000, 100_000, 3).text).toContain("가설 구간");
  });

  it("5% 넘게 멀면 끌림보다 OI 쏠림으로 읽는다", () => {
    const v = readMaxPain(94_000, 100_000, 20);
    expect(v.tone).toBe("warn");
    expect(v.text).toContain("OI 가 한쪽에 몰린");
  });

  it("dte 가 없으면 만기일 미상이라고 말한다", () => {
    expect(readMaxPain(100_500, 100_000, null).text).toContain("만기일 미상");
  });
});

describe("readSkew — −5%p / 0 / +3%p 밴드, −5%p 와 0 과 +3%p 는 아래 밴드에 든다", () => {
  it("null 은 재료 없음", () => {
    expect(readSkew(null).tone).toBe("neutral");
  });

  it("−0.05 미만은 강한 풋 스큐(bad)", () => {
    expect(readSkew(-0.051)).toMatchObject({ tone: "bad" });
    expect(readSkew(-0.1).text).toContain("강한 풋 스큐");
  });

  it("−0.05 이상 0 이하는 보통 — BTC 의 평소 약한 풋 스큐", () => {
    expect(readSkew(-0.05).tone).toBe("neutral");
    expect(readSkew(0).tone).toBe("neutral");
    expect(readSkew(-0.02).text).toContain("평소 모양");
  });

  it("0 초과 +0.03 이하는 콜 우위(warn)", () => {
    expect(readSkew(0.001)).toMatchObject({ tone: "warn" });
    expect(readSkew(0.03).tone).toBe("warn");
    expect(readSkew(0.02).text).toContain("콜 우위");
  });

  it("+0.03 초과는 강한 콜 스큐(bad)", () => {
    expect(readSkew(0.031)).toMatchObject({ tone: "bad" });
    expect(readSkew(0.08).text).toContain("FOMO");
  });
});

describe("readGex — 부호가 전부, 크기는 $ 축약", () => {
  it("null 은 재료 없음", () => {
    expect(readGex(null).tone).toBe("neutral");
  });

  it("양수는 롱감마(neutral) — 변동성 억제", () => {
    const v = readGex(120_000_000);
    expect(v.tone).toBe("neutral");
    expect(v.text).toContain("+$120M/1%");
    expect(v.text).toContain("롱감마");
    expect(v.text).toContain("가정 위의 추정치");
  });

  it("음수는 숏감마(warn) — 변동 확대", () => {
    const v = readGex(-2_300_000_000);
    expect(v.tone).toBe("warn");
    expect(v.text).toContain("−$2.30B/1%");
    expect(v.text).toContain("숏감마");
  });

  it("천 단위와 그 아래도 줄인다", () => {
    expect(readGex(450_000).text).toContain("$450K");
    expect(readGex(-900).text).toContain("$900/1%");
  });

  it("0 은 방향 없음", () => {
    expect(readGex(0).tone).toBe("neutral");
  });
});

describe("readWalls — 위·아래 거리와 '후보' 라는 말", () => {
  it("기준가가 없으면 재료 없음", () => {
    expect(readWalls(110_000, 90_000, null).tone).toBe("neutral");
    expect(readWalls(110_000, 90_000, null).text).toContain("재료 없음");
  });

  it("양쪽 벽이 없으면 재료 없음", () => {
    expect(readWalls(null, null, 100_000).text).toContain("재료 없음");
  });

  it("두 벽의 거리 % 와 후보·확정 아님을 말한다", () => {
    const v = readWalls(110_000, 95_000, 100_000);
    expect(v.tone).toBe("neutral");
    expect(v.text).toContain("위 콜벽 110,000(+10.0%)");
    expect(v.text).toContain("아래 풋벽 95,000(−5.0%)");
    expect(v.text).toContain("후보");
    expect(v.text).toContain("확정 지지/저항은 아닙니다");
  });

  it("한쪽만 있으면 없는 쪽을 말한다", () => {
    expect(readWalls(110_000, null, 100_000).text).toContain("아래에는 풋 OI 가 몰린 곳이 없습니다");
    expect(readWalls(null, 95_000, 100_000).text).toContain("위에는 콜 OI 가 몰린 곳이 없습니다");
  });
});

describe("readFlow — 콜·풋 순매수 부호의 네 조합", () => {
  function flow(partial: Partial<TakerBlockFlow>): TakerBlockFlow {
    return { ts: 0, callBuy: 0, callSell: 0, putBuy: 0, putSell: 0, callBlock: 0, putBlock: 0, ...partial };
  }

  it("null 은 재료 없음", () => {
    expect(readFlow(null).tone).toBe("neutral");
  });

  it("콜 매수 + 풋 매도 = 강세 흐름(warn)", () => {
    const v = readFlow(flow({ callBuy: 300, callSell: 100, putBuy: 50, putSell: 150 }));
    expect(v.tone).toBe("warn");
    expect(v.text).toContain("OKX 일간 테이커 기준");
    expect(v.text).toContain("콜 순매수 +200.0 BTC");
    expect(v.text).toContain("풋 순매수 -100.0 BTC");
    expect(v.text).toContain("강세 흐름");
  });

  it("콜 매도 + 풋 매수 = 약세·헤지 흐름(warn)", () => {
    const v = readFlow(flow({ callBuy: 100, callSell: 300, putBuy: 150, putSell: 50 }));
    expect(v.tone).toBe("warn");
    expect(v.text).toContain("약세·헤지 흐름");
  });

  it("둘 다 매수 = 변동성 매수(neutral)", () => {
    const v = readFlow(flow({ callBuy: 300, callSell: 100, putBuy: 150, putSell: 50 }));
    expect(v.tone).toBe("neutral");
    expect(v.text).toContain("변동성 매수");
  });

  it("둘 다 매도 = 변동성 매도(neutral)", () => {
    const v = readFlow(flow({ callBuy: 100, callSell: 300, putBuy: 50, putSell: 150 }));
    expect(v.tone).toBe("neutral");
    expect(v.text).toContain("변동성 매도");
  });

  it("둘 다 0 이면 방향 없음", () => {
    expect(readFlow(flow({})).text).toContain("방향이 없습니다");
  });
});

describe("readIvTerm — 근월 vs 최원월", () => {
  const point = (expiry: string, dte: number, atmIv: number): IvTermPoint => ({ expiry, dte, atmIv });

  it("점이 2개 미만이거나 일주일 이상 남은 점이 끝 점뿐이면 재료 없음", () => {
    expect(readIvTerm([]).tone).toBe("neutral");
    expect(readIvTerm([point("2026-09-25", 7, 0.4)]).text).toContain("재료 없음");
    // D-2 는 근월 후보가 아니고, 남는 D-30 은 끝 점과 같다 — 견줄 두 점이 없다.
    expect(readIvTerm([point("2026-09-20", 2, 0.5), point("2026-10-18", 30, 0.4)]).text).toContain("재료 없음");
  });

  it("근월 < 원월은 콘탱고(good) — 근월은 D-7 이상 첫 점(7 포함)", () => {
    const v = readIvTerm([
      point("2026-09-25", 7, 0.38),
      point("2026-10-30", 42, 0.42),
      point("2026-12-25", 98, 0.45),
    ]);
    expect(v.tone).toBe("good");
    expect(v.text).toContain("근월 2026-09-25(D-7) 38.0%");
    expect(v.text).toContain("최원월 2026-12-25(D-98) 45.0%");
    expect(v.text).toContain("콘탱고");
  });

  it("만기 직전 점은 비교에서 빼고, 근월보다 1%p 넘게 높으면 문구 끝에 따로 말한다", () => {
    const v = readIvTerm([
      point("2026-09-19", 0.8, 0.351),
      point("2026-09-20", 1.8, 0.268),
      point("2026-09-25", 5.8, 0.31),
      point("2026-10-30", 42, 0.33),
      point("2026-12-25", 98, 0.394),
    ]);
    expect(v.tone).toBe("good");
    expect(v.text).toContain("근월 2026-10-30(D-42) 33.0%");
    expect(v.text).toContain("만기 직전 2026-09-19(D-1) 35.1% 은 더 높지만");
    expect(v.text).not.toContain("2026-09-20");
    expect(v.text).not.toContain("2026-09-25(D-6)");
  });

  it("근월 > 원월은 역전(warn)", () => {
    const v = readIvTerm([point("2026-09-25", 7, 0.6), point("2026-12-25", 98, 0.45)]);
    expect(v.tone).toBe("warn");
    expect(v.text).toContain("역전");
  });

  it("같으면 평평(neutral)", () => {
    expect(readIvTerm([point("2026-09-25", 7, 0.4), point("2026-12-25", 98, 0.4)]).tone).toBe("neutral");
  });
});
