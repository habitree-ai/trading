/**
 * 오답노트 집계본을 화면이 읽는 자리.
 *
 * `re_sys/mistakes.mjs` 가 로컬 원장을 유형별 건수·합계로 줄여
 * `docs/mistakes/okx-mistakes.json` 에 쓰고, 그 파일만 커밋된다 — 그래서 배포된
 * 앱에서도 이 화면이 열린다. `okx-kelly.ts`·`okx-diagnosis.ts` 와 같은 구조다.
 *
 * **집계본에는 답이 없다.** 승률·거래당 손익·비교군과의 차이·유의성·귀속 손실은 전부
 * 여기서 계산한다. 문턱을 고치면 이 파일 한 곳만 바뀌고 과거 회차까지 같은 기준으로
 * 다시 매겨진다 — 집계본에 판정을 박아 두면 회차마다 기준이 달라져 추이가 거짓이 된다.
 *
 * `/diagnosis` 와 겹치지 않는가: 진단은 축을 전수로 훑어 FDR 로 걸러 낸다. 여기는
 * **이름이 이미 붙어 있는 오답 후보 10개**만 본다. 후보가 정해져 있으니 답은 "그래서
 * 이게 진짜 오답이냐" 하나뿐이고, 그 답이 바로 "하지 말 것"의 문장이 된다.
 */
import raw from "../../docs/mistakes/okx-mistakes.json";
import { ACTIONABILITY_LABEL, type Actionability } from "@/lib/okx-diagnosis";
import type { Tone, Verdict } from "@/lib/verdict";

/** 집계본이 담는 충분통계량. 여기서 평균·표준오차·t 가 되살아난다. */
export interface MistakeStats {
  n: number;
  wins: number;
  sumNet: number;
  sumSqDev: number;
  sumFee: number;
  sumFunding: number;
}

export interface MistakeTrade {
  id: string;
  /** 한국 시간 날짜 */
  day: string;
  hourKst: number;
  symbol: string;
  side: string;
  lever: number | null;
  holdMin: number;
  net: number;
  fee: number | null;
  entryPx: number | null;
  exitPx: number | null;
  /** 진입 의도 — 원장이 진입 시점 지표로 되짚은 것 */
  intent: string | null;
  basis: string | null;
  mfeMarginPct: number | null;
  maeMarginPct: number | null;
  liq: boolean;
}

interface RawGroup extends MistakeStats {
  id: string;
  control: string;
  title: string;
  /** 무엇을 이 유형으로 세는가 — 원장 필드로 적은 판정 기준 */
  rule: string;
  /** "하지 말 것" 한 문장 — 원칙으로 옮길 때의 초안 */
  taboo: string;
  baseline: (MistakeStats & { label: string }) | null;
  worst: MistakeTrade[];
}

/** 유형 하나 — 집계본의 숫자에 판정을 붙인 것. */
export interface MistakeGroup extends RawGroup {
  control: Actionability;
  controlLabel: string;
  winRate: number | null;
  /** 거래당 순손익 */
  perTrade: number | null;
  baselineWinRate: number | null;
  baselinePerTrade: number | null;
  /** 비교군과의 거래당 손익 차이. 음수면 이 유형이 더 잃었다 */
  gap: number | null;
  /** 비교군과의 승률 차이(%p) */
  winRateGap: number | null;
  /** Welch t — 차이가 표본 흔들림보다 큰가 */
  t: number | null;
  /** 차이가 진짜라면 이 유형에 돌릴 수 있는 손익 = 건수 × 거래당 차이 */
  attributable: number | null;
  verdict: Verdict;
  /** 규칙으로 옮길 수 있는가 */
  canSeed: boolean;
}

export interface HoldBucket extends MistakeStats {
  id: string;
  label: string;
  winRate: number | null;
  perTrade: number | null;
}

export interface MistakeReport {
  round: {
    no: number;
    generatedAt: string;
    tradeCount: number;
    excludedBot: number;
    worstPerGroup: number;
    period: { from: string; to: string; tradingDays: number };
    totals: MistakeStats;
  };
  source: { file: string; analyzedAt: string | null; origins: string[] };
  holdBuckets: HoldBucket[];
  groups: MistakeGroup[];
}

/*
 * 판정 문턱 — 왜 2 와 3 인가.
 *
 * 후보가 10개다. 문턱을 |t| ≥ 2 하나로 두면 열 번 재는 동안 우연히 2 를 넘는 것이
 * 하나쯤 나온다. 그래서 "확인"은 3 으로 올리고, 2~3 은 "조짐"으로 따로 둔다 —
 * 버리지는 않는다. 조짐을 규칙으로 옮기면 지키느라 잃는 쪽이 커지고, 지워 버리면
 * 다음 회차에 표본이 쌓였을 때 다시 볼 자리가 없다.
 */
const T_CONFIRMED = 3;
const T_HINT = 2;

/** 유형별 최소 표본 — 이보다 적으면 차이를 재지 않는다. */
export const MIN_SAMPLE = 30;

/** 비율로 낸다(0.289) — 화면의 `pct()` 가 그 형태를 받는다. */
const rate = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

const mean = (s: MistakeStats): number | null => (s.n > 0 ? s.sumNet / s.n : null);

/** Welch t — 분산이 다른 두 표본의 평균 차이. */
export function welchT(a: MistakeStats, b: MistakeStats): number | null {
  if (a.n < 2 || b.n < 2) return null;
  const va = a.sumSqDev / (a.n - 1);
  const vb = b.sumSqDev / (b.n - 1);
  const se = Math.sqrt(va / a.n + vb / b.n);
  if (!(se > 0)) return null;
  return (a.sumNet / a.n - b.sumNet / b.n) / se;
}

/**
 * 이 유형이 오답인가.
 *
 * 합계가 크다고 오답이 아니다 — 대개 거래가 많았을 뿐이다. 비교군보다 **거래당** 얼마나
 * 더 잃었는지, 그 차이가 표본 흔들림보다 큰지로만 가른다.
 */
export function judgeGroup(
  g: { control: string; n: number },
  t: number | null,
  gap: number | null,
): Verdict {
  if (g.control === "outcome") {
    return {
      tone: "neutral",
      text: "결과로 정의된 유형입니다 — 손실 거래에만 붙으므로 승률 0%는 결과가 아니라 정의입니다. 규칙으로 옮길 수 없고, 얼마를 잃었는지만 셉니다.",
    };
  }
  if (g.n < MIN_SAMPLE) {
    return { tone: "neutral", text: `표본 ${g.n}건 — ${MIN_SAMPLE}건이 안 되어 차이를 재지 않습니다.` };
  }
  if (t === null || gap === null) {
    return { tone: "neutral", text: "비교군이 없어 차이를 재지 못했습니다." };
  }

  const abs = Math.abs(t);
  const per = `거래당 ${gap > 0 ? "+" : ""}${gap.toFixed(1)}`;

  if (abs < T_HINT) {
    return {
      tone: "neutral",
      text: `차이 없음 — 비교군과 ${per} 차이지만 표본 흔들림 안입니다(t ${t.toFixed(1)}). 합계가 큰 것은 건수가 많아서입니다.`,
    };
  }
  if (gap < 0) {
    return abs >= T_CONFIRMED
      ? { tone: "bad", text: `오답 확인 — 비교군보다 ${per} 더 잃었습니다(t ${t.toFixed(1)}).` }
      : { tone: "warn", text: `오답 조짐 — 비교군보다 ${per} 나쁘지만 아직 단단하지 않습니다(t ${t.toFixed(1)}). 규칙으로 옮기기 전에 표본을 더 봅니다.` };
  }
  return abs >= T_CONFIRMED
    ? { tone: "good", text: `오답이 아닙니다 — 비교군보다 ${per} 더 벌었습니다(t ${t.toFixed(1)}).` }
    : { tone: "good", text: `오답이라 할 근거가 없습니다 — 오히려 ${per} 나은 쪽입니다(t ${t.toFixed(1)}).` };
}

function hydrate(g: RawGroup): MistakeGroup {
  const t = g.baseline ? welchT(g, g.baseline) : null;
  const m = mean(g);
  const bm = g.baseline ? mean(g.baseline) : null;
  const gap = m !== null && bm !== null ? m - bm : null;
  const control = g.control as Actionability;
  const verdict = judgeGroup(g, t, gap);

  return {
    ...g,
    control,
    controlLabel: ACTIONABILITY_LABEL[control],
    winRate: rate(g.wins, g.n),
    perTrade: m,
    baselineWinRate: g.baseline ? rate(g.baseline.wins, g.baseline.n) : null,
    baselinePerTrade: bm,
    gap,
    winRateGap:
      g.baseline && g.n > 0 && g.baseline.n > 0
        ? g.wins / g.n - g.baseline.wins / g.baseline.n
        : null,
    t,
    attributable: gap === null ? null : gap * g.n,
    verdict,
    // 규칙이 되려면 고를 수 있어야 하고, 차이가 나쁜 쪽으로 단단해야 한다.
    canSeed: control !== "outcome" && verdict.tone === "bad",
  };
}

/**
 * 화면에 뜨는 순서 — 귀속 손실이 큰 쪽부터.
 *
 * 합계 손실로 줄 세우면 건수가 많은 유형이 늘 위에 온다. 귀속(건수 × 거래당 차이)은
 * "이 유형을 안 했다면 얼마가 남았을까"에 가장 가까운 값이라 순서의 뜻이 산다.
 */
export function byAttributable(a: MistakeGroup, b: MistakeGroup): number {
  return (a.attributable ?? 0) - (b.attributable ?? 0);
}

export function loadMistakes(): MistakeReport {
  const report = raw as unknown as {
    round: MistakeReport["round"];
    source: MistakeReport["source"];
    holdBuckets: (MistakeStats & { id: string; label: string })[];
    groups: RawGroup[];
  };

  return {
    round: report.round,
    source: report.source,
    holdBuckets: report.holdBuckets.map((b) => ({
      ...b,
      winRate: rate(b.wins, b.n),
      perTrade: mean(b),
    })),
    groups: report.groups.map(hydrate),
  };
}

/** 유형을 원칙 초안으로 — 사용자가 고쳐 쓸 출발점. */
export function seedDraft(g: MistakeGroup, round: number, generatedAt: string): {
  category: "taboo";
  title: string;
  detail: string;
} {
  const date = generatedAt.slice(0, 10);
  const numbers =
    g.gap === null
      ? `${g.n}건 · 순손익 ${Math.round(g.sumNet)}.`
      : `${g.n}건 · 승률 ${((g.winRate ?? 0) * 100).toFixed(1)}% ` +
        `(비교군 ${((g.baselineWinRate ?? 0) * 100).toFixed(1)}%) · ` +
        `거래당 ${g.gap.toFixed(1)} 차이 · 귀속 ${Math.round(g.attributable ?? 0)}.`;

  return {
    category: "taboo",
    title: g.taboo,
    detail: `오답노트 회차 ${round} (${date}) — ${g.rule}\n${numbers}`,
  };
}

/** 화면의 「출처와 한계」가 그대로 쓰는 줄. */
export const LIMIT_NOTES = [
  "표본은 OKX 원장의 내 손 주문입니다 — 봇 계정 거래는 뺐습니다.",
  "유형끼리 겹칩니다. 한 거래가 빠른매매이면서 역추세일 수 있어, 귀속 손실을 다 더하면 실제 손실보다 커집니다.",
  "앱의 거래 기록(`/trades`)과 열쇠가 이어져 있지 않습니다 — 여기 나온 거래는 원장 쪽 식별자입니다.",
  "「원칙으로 옮기기」는 과거에 소급되지 않습니다. 등록한 뒤 새로 적는 거래부터 체크 대상입니다.",
] as const;

export const TONE_ORDER: Record<Tone, number> = { bad: 0, warn: 1, neutral: 2, good: 3 };
