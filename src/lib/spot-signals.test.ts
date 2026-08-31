import { describe, expect, it } from "vitest";

import { evaluateCrash, medianDailyTurnover } from "@/lib/spot-signals";
import type { UpbitCandle } from "@/lib/upbit";

/**
 * crash 규칙의 동치성 테스트 — 산식은 scripts/backtest/spot-signal2.mjs 와 같아야 한다.
 * 파라미터(−25%·1.5배)를 바꾸면 여기가 먼저 깨져서 "백테스트 다시 돌려라"를 상기시킨다.
 */

const H1 = 3600_000;

/** 마지막 봉이 73봉 전 대비 `dropPct` 낙폭이 되는 시리즈. */
function makeBars({
  dropPct,
  lastGreen = true,
  lastVolMult = 3,
  length = 80,
}: {
  dropPct: number;
  lastGreen?: boolean;
  lastVolMult?: number;
  length?: number;
}): UpbitCandle[] {
  const bars: UpbitCandle[] = [];
  const refIndex = length - 1 - 72; // 낙폭 기준 봉
  const refClose = 100;
  const lastClose = refClose * (1 + dropPct);
  for (let i = 0; i < length; i += 1) {
    // 기준 봉까지는 100, 이후 마지막까지 선형 하락 — 낙폭이 정확히 dropPct 가 된다.
    const c =
      i <= refIndex ? refClose : refClose + ((lastClose - refClose) * (i - refIndex)) / (length - 1 - refIndex);
    bars.push({ t: i * H1, o: c + 0.5, h: c + 1, l: c - 1, c, v: 10 });
  }
  const last = bars[length - 1];
  last.o = lastGreen ? last.c - 0.5 : last.c + 0.5;
  last.v = 10 * lastVolMult; // 직전 20봉 평균은 10
  return bars;
}

describe("evaluateCrash", () => {
  it("−25% 이상 낙폭 + 양봉 + 거래량 확증이면 발화한다", () => {
    const hit = evaluateCrash(makeBars({ dropPct: -0.3 }));
    expect(hit).not.toBeNull();
    expect(hit?.drop72Pct).toBeCloseTo(-30, 0);
    expect(hit?.volumeMult).toBeCloseTo(3, 1);
  });

  it("낙폭이 문턱(−25%)에 못 미치면 발화하지 않는다", () => {
    expect(evaluateCrash(makeBars({ dropPct: -0.2 }))).toBeNull();
  });

  it("음봉이면 발화하지 않는다 — 수요 확인이 규칙의 절반이다", () => {
    expect(evaluateCrash(makeBars({ dropPct: -0.3, lastGreen: false }))).toBeNull();
  });

  it("거래량이 20봉 평균 ×1.5 이하면 발화하지 않는다", () => {
    expect(evaluateCrash(makeBars({ dropPct: -0.3, lastVolMult: 1.2 }))).toBeNull();
  });

  it("봉이 73개 미만이면 판정하지 않는다", () => {
    expect(evaluateCrash(makeBars({ dropPct: -0.3, length: 60 }))).toBeNull();
  });
});

describe("medianDailyTurnover", () => {
  const day = (i: number, turnover: number): UpbitCandle => ({
    t: i * 86_400_000,
    o: 1,
    h: 1,
    l: 1,
    c: 1,
    v: 1,
    turnover,
  });

  it("30일 중앙값을 돌려준다", () => {
    const days = Array.from({ length: 30 }, (_, i) => day(i, (i + 1) * 1e8));
    expect(medianDailyTurnover(days)).toBe(16 * 1e8); // 1..30억의 중앙값(16번째)
  });

  it("표본 10일 미만이면 null — 신규 상장은 판단하지 않는다", () => {
    const days = Array.from({ length: 9 }, (_, i) => day(i, 1e9));
    expect(medianDailyTurnover(days)).toBeNull();
  });
});
