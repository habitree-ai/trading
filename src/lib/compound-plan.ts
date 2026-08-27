/**
 * 복리 계획 — 목표 금액까지 필요한 수익률과, 그 전에 지켜야 할 기준.
 *
 * 순수 함수만 있다. 숫자의 출처는 `docs/goals/README.md` 가 정본이고, 여기 상수는 그 표를
 * 코드로 옮긴 것이다 — 랩 회차가 다시 돌면 그쪽 문서를 고치고 이 상수를 따라 맞춘다.
 *
 * 수익률은 전부 **월 기하수익률(소수)** 로 다룬다. 0.02 = 월 2%.
 */
import type { GoalMetric, GoalPeriod, GoalTier } from "@/lib/domain";

/** 매월 말 납입, 월 복리의 미래가치. r=0 은 단순 합. */
export function futureValue(start: number, monthly: number, rate: number, months: number): number {
  if (rate === 0) return start + monthly * months;
  const g = (1 + rate) ** months;
  return start * g + (monthly * (g - 1)) / rate;
}

/**
 * n개월 안에 목표에 닿으려면 필요한 월수익률. 납입만으로 닿으면 0.
 * 닫힌 식이 없어 이분법이다 — 단조증가라 200회면 충분하다.
 */
export function requiredMonthlyRate(
  start: number,
  monthly: number,
  target: number,
  months: number,
): number {
  if (months <= 0) return Number.POSITIVE_INFINITY;
  if (futureValue(start, monthly, 0, months) >= target) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (futureValue(start, monthly, mid, months) < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** 이 월수익률이면 목표까지 몇 달인가. 1,200개월(100년) 안에 못 닿으면 null. */
export function monthsToTarget(
  start: number,
  monthly: number,
  rate: number,
  target: number,
): number | null {
  if (start >= target) return 0;
  let v = start;
  for (let m = 1; m <= 1200; m += 1) {
    v = v * (1 + rate) + monthly;
    if (v >= target) return m;
  }
  return null;
}

/** 월 → 주(52주 기준 기하). */
export function weeklyFromMonthly(rate: number): number {
  return (1 + rate) ** (12 / 52) - 1;
}

/** 월 → 거래일. 한 달을 21거래일로 본다. */
export function dailyFromMonthly(rate: number, tradingDays = 21): number {
  return (1 + rate) ** (1 / tradingDays) - 1;
}

export function annualFromMonthly(rate: number): number {
  return (1 + rate) ** 12 - 1;
}

/* ============ 계획의 상수 ============ */

export const TARGET_KRW = 100_000_000;
/** 기본 환율 — 화면에서 바꿀 수 있다. 목표는 원화, 자금은 USDT 라 환산이 필요하다. */
export const DEFAULT_KRW_PER_USD = 1390;
export const DEFAULT_MONTHLY_CONTRIBUTION = 150;
export const HORIZONS_MONTHS = [36, 60, 84, 120] as const;
export const CONTRIBUTIONS = [100, 150, 200] as const;

/**
 * 현실 기준선 — 저장소가 이미 답해 둔 월수익률. 같은 단위에 놓아야 목표가 어디 있는지 보인다.
 * `monthly: null` 은 "양수가 없다"는 뜻이다(내 켈리).
 */
export interface Benchmark {
  key: string;
  label: string;
  monthly: number | null;
  note: string;
  source: string;
}

export const BENCHMARKS: Benchmark[] = [
  {
    key: "frontier",
    label: "월 10% — 프런티어 회차",
    monthly: 0.1,
    note: "기각. 필요한 엣지 t 5.15 vs 관측 최대 2.66. 인샘플 최고 설정도 자산 −96%",
    source: "backtest-lab/README.md §8",
  },
  {
    key: "lab-max",
    label: "복리 회차 상한 (혼합 9부품)",
    monthly: 0.0503,
    note: "낙폭 −39.6%. 구간 3등분이 11.3 → 5.1 → 1.8로 감쇠 — 최근 구간이 기대치에 가깝다",
    source: "backtest-lab/compound/README.md §8",
  },
  {
    key: "senior",
    label: "선배님 산식",
    monthly: 0.0284,
    note: "연 −20% 감내 → 기대수익 +40%. 정지선과 같은 뿌리",
    source: "선배님/투자철학정리.md 3층",
  },
  {
    key: "lab-safe",
    label: "복리 회차 보수 (레버 5배·리스크 2%)",
    monthly: 0.0204,
    note: "낙폭 −18.8%·파산확률 게이트 통과. 정지선 −20% 안에서 도는 유일한 구성",
    source: "backtest-lab/compound/README.md §8",
  },
  {
    key: "kelly",
    label: "내 켈리 (전 이력 4,023건)",
    monthly: null,
    note: "f* 음수. 지금은 어떤 양수도 근거가 없다",
    source: "/kelly",
  },
];

/** 계획 β(반드시) / 목표 α(도전). 정지선은 둘이 같다 — α라도 정지선은 움직이지 않는다. */
export interface PlanTier {
  /** 월 기하수익률 목표 */
  monthly: number;
  /** 고점 대비 월 낙폭 정지선 — 닿으면 그 달 중단. 양수 크기(0.2 = −20%) */
  stopDrawdown: number;
  /** 거래당 리스크 상한 */
  riskPerTrade: number;
  leverageCap: number;
}

export const PLAN_DEFAULT: { beta: PlanTier; alpha: PlanTier } = {
  beta: { monthly: 0.02, stopDrawdown: 0.2, riskPerTrade: 0.02, leverageCap: 5 },
  alpha: { monthly: 0.05, stopDrawdown: 0.2, riskPerTrade: 0.03, leverageCap: 5 },
};

/** "유의미한 금액대" 단계 — 승격 조건은 전부 충족해야 한다. */
export interface Stage {
  level: number;
  label: string;
  /** USD. `to` 는 미포함 상한 */
  from: number;
  to: number;
  promote: string;
}

export const STAGES: Stage[] = [
  {
    level: 0,
    label: "검증",
    from: 0,
    to: 1_000,
    promote: "3개월 연속 월 기하 > 0 · 정지선 미접촉 · 거래 30건 이상",
  },
  {
    level: 1,
    label: "축적",
    from: 1_000,
    to: 5_000,
    promote: "6개월 연속 정지선 미접촉 · 분기 기하 > 0 · 켈리 양수",
  },
  {
    level: 2,
    label: "운용",
    from: 5_000,
    to: 10_000,
    promote: "12개월 낙폭 −20% 이내 · 연 기하 ≥ β",
  },
  {
    level: 3,
    label: "복리",
    from: 10_000,
    to: Number.POSITIVE_INFINITY,
    promote: "단계 2 유지",
  },
];

export const DEMOTION_RULE =
  "정지선 접촉 시 그 달 중단 + 다음 달 리스크 절반. 두 달 연속 접촉이면 한 단계 아래로";

export function stageOf(equity: number): Stage {
  return STAGES.find((s) => equity >= s.from && equity < s.to) ?? STAGES[0];
}

/* ============ 이번 달 성적 ============ */

export interface CurveSample {
  /** ISO 시각 */
  at: string;
  /** 넣고 뺀 돈을 걷어낸 매매 성과 곡선의 값 */
  performance: number;
}

export interface MonthPerformance {
  /** `YYYY-MM` */
  month: string;
  /** 달 시작 시점의 성과 곡선 값(직전 점, 없으면 초기자금) */
  startValue: number;
  endValue: number;
  /** 소수. 0.02 = +2% */
  returnPct: number;
  /** 달 안의 고점 대비 최대 낙폭, 양수 크기. 0.2 = −20% */
  drawdown: number;
  /** 이 달에 찍힌 점 수 = 실현 거래 수 */
  samples: number;
}

/**
 * 한 달의 성적 — 성과 곡선(입출금 제외)에서 잰다. 잔액 곡선으로 재면 납입이 수익으로 보인다.
 *
 * 낙폭의 고점은 달 시작값에서 출발한다 — 지난달 고점을 끌고 오면 이번 달 규칙("이 달에
 * 잃은 폭")이 아니라 누적 낙폭이 된다. 그것은 대시보드의 MDD 가 이미 말한다.
 */
export function monthPerformance(
  samples: readonly CurveSample[],
  initialValue: number,
  month: string,
): MonthPerformance {
  const sorted = [...samples].sort((a, b) => a.at.localeCompare(b.at));
  const before = sorted.filter((s) => s.at.slice(0, 7) < month);
  const inMonth = sorted.filter((s) => s.at.slice(0, 7) === month);
  const startValue = before.length > 0 ? before[before.length - 1].performance : initialValue;

  let peak = startValue;
  let drawdown = 0;
  for (const s of inMonth) {
    peak = Math.max(peak, s.performance);
    if (peak > 0) drawdown = Math.max(drawdown, 1 - s.performance / peak);
  }
  const endValue = inMonth.length > 0 ? inMonth[inMonth.length - 1].performance : startValue;
  const returnPct = startValue > 0 ? endValue / startValue - 1 : 0;
  return { month, startValue, endValue, returnPct, drawdown, samples: inMonth.length };
}

export type MonthVerdict = "stopped" | "alpha" | "beta" | "positive" | "negative" | "idle";

/**
 * 이 달을 어떻게 읽을 것인가. 정지선이 먼저다 — α를 넘겼어도 정지선에 닿았으면 중단이다.
 * 점이 하나도 없으면 판정하지 않는다(idle).
 */
export function monthVerdict(
  perf: MonthPerformance,
  beta: PlanTier,
  alpha: PlanTier,
): MonthVerdict {
  if (perf.samples === 0) return "idle";
  if (perf.drawdown >= beta.stopDrawdown) return "stopped";
  if (perf.returnPct >= alpha.monthly) return "alpha";
  if (perf.returnPct >= beta.monthly) return "beta";
  return perf.returnPct >= 0 ? "positive" : "negative";
}

/* ============ 저장된 목표 ↔ 계획 ============ */

export interface GoalLike {
  tier: GoalTier;
  period: GoalPeriod;
  metric: GoalMetric;
  target_value: number;
}

/**
 * `goals` 표의 월 단위 행에서 β/α 를 읽는다. 없는 칸은 기본안을 쓴다.
 * 표에는 %(2.0) 로 저장하고 여기서는 소수(0.02) 로 다룬다 — 낙폭은 크기(20 → 0.2).
 */
export function planFromGoals(goals: readonly GoalLike[]): { beta: PlanTier; alpha: PlanTier } {
  const pick = (tier: GoalTier, metric: GoalMetric): number | null => {
    const g = goals.find((x) => x.tier === tier && x.period === "month" && x.metric === metric);
    return g ? g.target_value : null;
  };
  const build = (tier: GoalTier): PlanTier => {
    const base = PLAN_DEFAULT[tier];
    const monthly = pick(tier, "return_pct");
    const stop = pick(tier, "max_drawdown_pct");
    const risk = pick(tier, "risk_per_trade_pct");
    return {
      monthly: monthly === null ? base.monthly : monthly / 100,
      stopDrawdown: stop === null ? base.stopDrawdown : Math.abs(stop) / 100,
      riskPerTrade: risk === null ? base.riskPerTrade : risk / 100,
      leverageCap: base.leverageCap,
    };
  };
  return { beta: build("beta"), alpha: build("alpha") };
}

/** 계획 → 표에 넣을 행. 정지선은 양수 크기(%)로 저장한다 — `max_drawdown_pct` 는 낮을수록 좋은 지표다. */
export function goalsFromPlan(plan: { beta: PlanTier; alpha: PlanTier }): GoalLike[] {
  const rows: GoalLike[] = [];
  for (const tier of ["beta", "alpha"] as const) {
    const t = plan[tier];
    rows.push(
      { tier, period: "month", metric: "return_pct", target_value: t.monthly * 100 },
      { tier, period: "month", metric: "max_drawdown_pct", target_value: t.stopDrawdown * 100 },
      { tier, period: "month", metric: "risk_per_trade_pct", target_value: t.riskPerTrade * 100 },
    );
  }
  return rows;
}
