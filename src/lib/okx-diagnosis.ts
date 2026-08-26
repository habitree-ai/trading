/**
 * 매매 진단 집계본 — 앱 밖에서 만든 발견 목록을 화면이 읽는 자리.
 *
 * `re_sys/diagnose.mjs` 가 로컬 45MB 원장을 발견(Finding) 레코드로 줄여
 * `docs/diagnosis/okx-diagnosis.json` 에 쓰고, 그 파일만 커밋된다 — 그래서 배포된
 * 앱에서도 이 화면이 열린다. `okx-kelly.ts` 와 같은 구조다.
 *
 * **집계본에는 답이 없다.** 리프트·표준오차·t·등급·심각도는 전부 여기서 계산한다.
 * 문턱을 고치면 이 파일 한 곳만 바뀌고 보존된 과거 회차까지 같은 기준으로 다시 매겨진다 —
 * 집계본에 등급을 박아 두면 회차마다 기준이 달라져 추이가 거짓이 된다.
 */
import raw from "../../docs/diagnosis/okx-diagnosis.json";
import {
  gradeFinding,
  heldOutOfSample,
  readFinding,
  CONFIDENCE_RANK,
  type Confidence,
  type FindingEvidence,
  type Verdict,
} from "@/lib/verdict";

type Maybe = number | null;

/** 진입 시점에 고를 수 있는가 — 이 진단의 중심 축. */
export type Actionability = "entry" | "exit" | "outcome" | "context";

export const ACTIONABILITY_LABEL: Record<Actionability, string> = {
  entry: "진입에서 통제",
  exit: "청산에서 통제",
  outcome: "결과로 정의됨",
  context: "고를 수 없는 배경",
};

export const ACTIONABILITY_HINT: Record<Actionability, string> = {
  entry: "들어가기 전에 고를 수 있습니다 — 규칙으로 바로 옮겨집니다",
  exit: "들고 있는 동안 고칠 수 있습니다 — 청산 규율로 옮겨집니다",
  outcome: "정의에 결과가 들어 있어 규칙으로 옮길 수 없습니다",
  context: "고를 수 없는 배경입니다 — 표류를 보는 용도입니다",
};

/** 집계본이 담는 충분통계량. 여기서 평균·표준편차·t 가 되살아난다. */
interface RawStats {
  n: number;
  wins: number;
  losses: number;
  sumNet: number;
  sumSqDev: number;
  sumWin: number;
  sumLoss: number;
  sumFee: number;
  sumFunding: number;
  sumGross: number;
}

interface RawSplit {
  boundary: string;
  inN: number;
  inSumNet: number;
  inSumSqDev: number;
  outN: number;
  outSumNet: number;
  outSumSqDev: number;
}

interface RawConditional {
  given: string;
  then: string;
  givenN: number;
  thenN: number;
  thenSumNet: number;
}

interface RawFinding extends RawStats {
  id: string;
  kind: "axis" | "conditional";
  axis: string;
  axisLabel: string;
  bucket: string;
  bucketOrder: number | null;
  cohort: string;
  actionability: Actionability;
  basis: string;
  split: RawSplit;
  conditional: RawConditional | null;
  tautological: boolean;
  tautologyReason: string | null;
  /**
   * 이 축의 값이 결과와 기계적으로 얽혀 있는가.
   *
   * 보유시간·MFE·MAE 는 진입 뒤 가격이 만든 값이라, 크게 이긴 거래가 큰 평가익 구간을
   * 지나간 것은 당연하다. 리프트를 효과로 읽으면 "평가익 100%를 넘기면 좋다" 같은
   * 순환 논리가 발견처럼 보인다 — 순위에서 빼고 조건부 비율로만 읽는다.
   */
  pathDependent: boolean;
  twinId: string | null;
  defects: string[];
  evidence: string | null;
  firstSeenRound: number;
}

interface RawCohort {
  key: string;
  label: string;
  filter: string;
  baseline: RawStats & RawSplit;
}

/** 계산이 끝난 발견 — 화면이 쓰는 형태. */
export interface Finding extends RawFinding {
  /** 이 칸의 거래당 손익 */
  mean: number;
  /** 같은 코호트 기준선과의 차이 */
  lift: number;
  /** 리프트 × n — 이 칸이 기준선보다 더 잃거나 번 금액 */
  attributable: number;
  /** 거래당 손익의 표본 표준편차 */
  sd: Maybe;
  /** 평균의 표준오차 */
  se: Maybe;
  /** 리프트 ÷ 표준오차 */
  t: Maybe;
  inLift: Maybe;
  outLift: Maybe;
  /** 앞뒤 절반의 부호가 같은가. 표본이 얇아 못 재면 null */
  held: boolean | null;
  confidence: Confidence;
  verdict: Verdict;
  /** 승 ÷ (승 + 패) */
  winRate: Maybe;
  /** 조건부 발견의 비율 — givenN 중 thenN */
  conditionalRate: Maybe;
}

export interface DiagnosisReport {
  round: {
    no: number;
    generatedAt: string;
    sourceFingerprint: string;
    tradeCount: number;
    period: { from: string | null; to: string | null; tradingDays: number };
    question: string | null;
    splitBoundary: string;
    testCount: number;
  };
  source: { file: string; analyzedAt: string | null; origins: string[]; symbols: number };
  defects: { key: string; label: string; effect: string }[];
  cohorts: RawCohort[];
  coverage: { axis: string; cohort: string; covered: number; total: number }[];
  findings: Finding[];
  history: {
    no: number;
    generatedAt: string;
    tradeCount: number;
    ids: string[];
    baselines: Record<string, [number, number]>;
    rows: [number, number, number][];
  }[];
}

const mean = (sum: number, n: number): number => (n === 0 ? 0 : sum / n);

/**
 * 표본 표준편차 — `sumSqDev` 는 스크립트가 2-pass 로 낸 Σ(x−μ)² 이다.
 *
 * 한 건짜리 칸은 산포가 정의되지 않는다. 0으로 두면 표준오차가 0이 되어 t 가 무한대로
 * 튀므로, 잴 수 없다는 뜻의 null 로 돌린다.
 */
function sdOf(sumSqDev: number, n: number): Maybe {
  if (n < 2 || !Number.isFinite(sumSqDev) || sumSqDev < 0) return null;
  return Math.sqrt(sumSqDev / (n - 1));
}

/** 발견 하나를 계산이 끝난 형태로. */
export function enrichFinding(f: RawFinding, cohort: RawCohort): Finding {
  const base = mean(cohort.baseline.sumNet, cohort.baseline.n);
  const m = mean(f.sumNet, f.n);
  const lift = m - base;

  const sd = sdOf(f.sumSqDev, f.n);
  const se = sd === null || f.n === 0 ? null : sd / Math.sqrt(f.n);
  const t = se === null || se === 0 ? null : lift / se;

  // 앞뒤 절반은 각 절반의 기준선과 견준다 — 두 절반의 기준선이 4.7 이나 벌어져 있어
  // 통합 기준선으로 재면 없던 안정성이 만들어진다.
  const inBase = mean(cohort.baseline.inSumNet, cohort.baseline.inN);
  const outBase = mean(cohort.baseline.outSumNet, cohort.baseline.outN);
  const inLift = f.split.inN === 0 ? null : mean(f.split.inSumNet, f.split.inN) - inBase;
  const outLift = f.split.outN === 0 ? null : mean(f.split.outSumNet, f.split.outN) - outBase;

  const evidence: FindingEvidence = {
    n: f.n,
    lift,
    t,
    inLift,
    outLift,
    inN: f.split.inN,
    outN: f.split.outN,
    tautological: f.tautological,
  };

  const decided = f.wins + f.losses;

  return {
    ...f,
    mean: m,
    lift,
    attributable: lift * f.n,
    sd,
    se,
    t,
    inLift,
    outLift,
    held: heldOutOfSample(evidence),
    confidence: gradeFinding(evidence),
    verdict: readFinding(evidence),
    winRate: decided === 0 ? null : f.wins / decided,
    conditionalRate:
      f.conditional === null || f.conditional.givenN === 0
        ? null
        : f.conditional.thenN / f.conditional.givenN,
  };
}

/**
 * 화면에 세우는 순서.
 *
 * 금액만으로 세우면 거래가 많은 칸이 늘 위로 온다. 등급을 가중치로 곱해 단단한 발견이
 * 먼저 오되, 금액이 큰 가설도 아주 밀려나지는 않게 한다(0.3 은 완전히 지우지 않을 만큼만).
 */
const CONFIDENCE_WEIGHT: Record<Confidence, number> = {
  confirmed: 1,
  likely: 0.6,
  hypothesis: 0.3,
};

/*
 * 원칙 ↔ 발견을 잇는 마커.
 *
 * 제목으로 맞추면 사용자가 문구를 고치는 순간 연결이 끊긴다 — 그리고 고치라고 폼을
 * 열어 주는 설계다. `detail` 마지막 줄에 발견 id 를 박아 두는 편이 살아남는다.
 */
export function seedTagLine(findingId: string): string {
  return `발견 id \`${findingId}\``;
}

export function seedTagOf(detail: string | null): string | null {
  if (!detail) return null;
  const m = detail.match(/발견 id `([^`]+)`/);
  return m ? m[1] : null;
}

/**
 * 이 발견을 원칙으로 옮길 수 있는가.
 *
 * 확정되지 않은 것을 규칙으로 만들면 지키느라 잃는 쪽이 커진다. 결과로 정의된 라벨과
 * 고를 수 없는 배경은 애초에 규칙이 되지 않는다.
 */
export function canSeed(f: Finding): boolean {
  if (f.tautological) return false;
  if (f.actionability !== "entry" && f.actionability !== "exit") return false;
  return f.confidence === "confirmed" || f.kind === "conditional";
}

/** 원칙 초안 — 사용자가 고쳐 쓸 출발점. */
export function seedDraft(f: Finding, round: number, generatedAt: string): {
  category: "risk" | "entry" | "exit" | "mental" | "routine";
  title: string;
  detail: string;
} {
  const category = f.actionability === "exit" ? "exit" : f.axis === "lever" ? "risk" : "entry";
  const date = generatedAt.slice(0, 10);

  const title =
    f.kind === "conditional"
      ? `${f.axisLabel} — 이 구간에 닿으면 규칙대로 덜어낸다`
      : f.lift > 0
        ? `${f.axisLabel}가 ${f.bucket}일 때만 들어간다`
        : `${f.axisLabel}가 ${f.bucket}인 자리는 피한다`;

  const numbers =
    f.kind === "conditional" && f.conditional
      ? `${f.conditional.givenN}건 중 ${f.conditional.thenN}건이 그렇게 끝났고 합계 ${Math.round(f.conditional.thenSumNet)} 입니다.`
      : `${f.n}건 · 거래당 기준선과 ${f.lift > 0 ? "+" : ""}${f.lift.toFixed(2)} 차이 · 귀속 ${Math.round(f.attributable)}.`;

  return {
    category,
    title,
    detail: `진단 회차 ${round} (${date}) — ${f.axisLabel} ${f.bucket}\n${numbers}`,
  };
}

/** 화면의 「출처와 한계」가 그대로 쓰는 한 줄 — 코호트를 왜 나눴는지. */
export const MIN_SAMPLE_NOTE =
  "마진 대비 지표를 쓰는 축은 레버리지가 기록된 거래에서만 잽니다 — " +
  "전역 기준선으로 재면 레버 결측 거래가 만든 가짜 차이가 전 축에 실립니다.";

export function rankScore(f: Finding): number {
  return Math.abs(f.attributable) * CONFIDENCE_WEIGHT[f.confidence];
}

/** 심각도순 — 같은 점수면 등급이 단단한 쪽이 위로. */
export function byRank(a: Finding, b: Finding): number {
  return rankScore(b) - rankScore(a) || CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
}

export function loadDiagnosis(): DiagnosisReport {
  const report = raw as unknown as Omit<DiagnosisReport, "findings"> & { findings: RawFinding[] };
  const cohortOf = new Map(report.cohorts.map((c) => [c.key, c]));

  return {
    ...report,
    findings: report.findings.map((f) => enrichFinding(f, cohortOf.get(f.cohort)!)),
  };
}

/** id 로 발견 하나 — 쌍둥이(`twinId`)를 따라갈 때 쓴다. */
export function findingById(report: DiagnosisReport, id: string | null): Finding | null {
  if (!id) return null;
  return report.findings.find((f) => f.id === id) ?? null;
}
