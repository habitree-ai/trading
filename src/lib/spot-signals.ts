/**
 * 현물신호 규칙 정본 — 백테스트로 채택된 것만 (REQ-0023 Phase A 게이트, 2026-08-31).
 *
 * 채택: `crash` 급락 반전 × T1 유동성 — 후보 8종(1차 추세추종 4 + 2차 역발상 4) 중
 * 유일하게 사전 등록 기준(표본≥300 · 전체·2025·2026 각각 양수)을 통과했다.
 * 판정 코드는 scripts/backtest/spot-signal2.mjs 와 같은 산식이어야 한다 —
 * 여기 파라미터를 바꾸면 백테스트와의 동치성이 깨진다. 바꾸려면 새 회차를 돌려라.
 */
import { sma } from "@/lib/indicators";
import type { UpbitCandle } from "@/lib/upbit";

/** 채택 규칙 파라미터 — spot-signal2.mjs 헤더의 사전 등록 값 그대로. */
export const CRASH_RULE = {
  /** 72×1H 봉(3일) 수익률이 이 값 이하 */
  drop72: -0.25,
  /** 신호 봉 거래량 > 직전 20봉 평균 × 이 배수 */
  volMult: 1.5,
  /** 일 거래대금 30일 중앙값 하한(KRW) — T1 */
  minTurnoverKrw: 1_000_000_000,
  /** 최소 표본 일수 — 미만이면 신규 상장 등으로 판단 불가, 제외 */
  minTurnoverDays: 10,
  /** 같은 종목 재발화 억제(1H 봉 수) */
  cooldownBars: 24,
} as const;

/** 페그 자산 — 기술적 신호가 무의미해 유니버스에서 제외한다(수집 스크립트와 동일 목록). */
export const STABLE_SYMBOLS = new Set(["USDT", "USDC", "DAI", "TUSD", "USDS", "PYUSD", "FDUSD", "USD1", "USDE"]);

/**
 * 채택 근거 통계 — 상세 화면에 그대로 표기한다.
 * 과거 통계이며 미래를 보장하지 않는다. 숫자를 손보지 말 것 — 재백테스트가 정본이다.
 */
export const ADOPTED_STATS = {
  rule: "72봉(3일) −25% 급락 후 양봉 + 거래량 확증 · 일 거래대금 30일 중앙값 ≥10억",
  horizon: "진입 후 24시간(24봉) 기준 평가",
  period: "2023-01 ~ 2026-08 · 업비트 KRW 261종",
  n: 346,
  avgPct: 4.44,
  winPct: 66,
  pf: 3.21,
  worstPct: -27.3,
  y2025: { n: 167, avgPct: 4.91, winPct: 68 },
  y2026: { n: 49, avgPct: 1.64, winPct: 39 },
  caveats: [
    "발화가 폭락일에 군집한다 — 같은 날 신호들은 사실상 시장 반등 하나에 거는 상관된 베팅이다",
    "2026년은 승률 39%로 소수 큰 반등이 평균을 끌었다 — 엣지가 약해지는 중일 수 있다",
    "폭락장의 실제 슬리피지는 모델(0.1~0.3%)보다 나쁠 수 있다",
  ],
  source: "scripts/backtest/spot-signal2.mjs · 게이트 2026-08-31",
} as const;

export interface CrashSignal {
  /** 72봉 낙폭(%) — 음수 */
  drop72Pct: number;
  /** 신호 봉 거래량 / volMA20 */
  volumeMult: number;
  /** 신호 봉 종가(KRW) */
  price: number;
}

/**
 * crash 판정 — `bars`는 오래된 순 확정 1H 봉, 마지막 원소가 판정 대상 봉.
 *
 * 백테스트와 같은 위치 기준(positional) 산식: 낙폭은 73봉 전 종가 대비,
 * volMA20 은 직전 20봉(판정 봉 제외) 평균. 봉이 모자라면 null.
 */
export function evaluateCrash(bars: readonly UpbitCandle[]): CrashSignal | null {
  const i = bars.length - 1;
  if (i < 72 + 1) return null;
  const last = bars[i];
  const green = last.c > last.o;
  if (!green) return null;

  const drop72 = last.c / bars[i - 72].c - 1;
  if (drop72 > CRASH_RULE.drop72) return null;

  const volAvg = sma(bars.map((b) => b.v), 20)[i - 1];
  if (volAvg === null || volAvg <= 0) return null;
  const volumeMult = last.v / volAvg;
  if (volumeMult <= CRASH_RULE.volMult) return null;

  return {
    drop72Pct: +(drop72 * 100).toFixed(2),
    volumeMult: +volumeMult.toFixed(2),
    price: last.c,
  };
}

/**
 * 일 거래대금 30일 중앙값(KRW) — `days`는 오래된 순 일봉, 진행 중인 오늘 봉은
 * 호출자가 이미 잘라냈다고 가정한다. 표본이 minTurnoverDays 미만이면 null(판단 불가).
 */
export function medianDailyTurnover(days: readonly UpbitCandle[]): number | null {
  const vals = days
    .slice(-30)
    .map((d) => d.turnover)
    .filter((x): x is number => typeof x === "number" && x > 0);
  if (vals.length < CRASH_RULE.minTurnoverDays) return null;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}
