/**
 * OKX 전 이력 켈리 집계본 — 앱 밖에서 만든 원장을 화면이 읽는 자리.
 *
 * 원본(`re_sys/data/manual-review.json`, 45MB)은 이 PC에만 있고 저장소에 넣지 않는다.
 * `re_sys/kelly.mjs` 가 그걸 차원별 집계로 줄여 `docs/kelly/okx-kelly.json` 에 쓰고,
 * 그 파일만 커밋된다 — 그래서 배포된 앱에서도 이 화면이 열린다.
 *
 * 집계본에는 **켈리 값이 들어 있지 않다.** 승·패·평균수익·평균손실만 담겨 있고,
 * 승률·손익비·켈리는 여기서 `kellyFraction` 으로 계산한다. 대시보드·복기 분석과
 * 같은 함수를 통과해야 세 화면이 같은 거래를 두고 같은 켈리를 말한다.
 */
import raw from "../../docs/kelly/okx-kelly.json";
import { kellyFraction } from "@/lib/metrics";

type Maybe = number | null;

/** 집계본이 담고 있는 것 — 켈리의 입력이지 결과가 아니다. */
export interface KellyStats {
  n: number;
  wins: number;
  losses: number;
  /** 이긴 거래의 평균 실현손익(양수). 승이 없으면 null */
  avgWin: Maybe;
  /** 진 거래의 평균 실현손익(양수로 표현). 패가 없으면 null */
  avgLoss: Maybe;
  netPnl: number;
}

export interface KellyRow extends KellyStats {
  key: string;
  /** 승 ÷ (승 + 패) — 본전은 분모에서 뺀다 */
  winRate: Maybe;
  /** 평균수익 ÷ 평균손실 */
  payoffRatio: Maybe;
  /** f* = W − (1 − W) / b */
  kelly: Maybe;
  /** 승·패가 정해진 거래 수 — 표본이 이 값으로 판정된다 */
  decided: number;
}

export interface KellyDimension {
  key: string;
  label: string;
  hint: string;
  /** 크기순으로 읽어야 뜻이 통하는 축인가 — 보유시간·시각처럼 */
  ordered: boolean;
  rows: KellyRow[];
}

export interface OkxKellyReport {
  generatedAt: string;
  source: {
    file: string;
    analyzedAt: string | null;
    origins: string[];
    symbols: number;
  };
  period: { from: string | null; to: string | null; tradingDays: number };
  overall: KellyRow & {
    grossWin: number;
    grossLoss: number;
    feeUsd: number;
    fundingUsd: number;
    liqCount: number;
  };
  /**
   * 손실 거래가 증거금의 몇 %를 가져갔나.
   *
   * 켈리의 f* 는 자기자본 대비 비율인데 이 원장에는 거래 시점 잔액이 없다. 분모가
   * 다르므로 켈리와 나란히 두고 크다/작다를 말할 수 없다 — 참고 수치다.
   */
  lossMargin: { median: Maybe; mean: Maybe; n: number };
  dimensions: KellyDimension[];
}

/** 집계 하나를 켈리까지 채운다. */
export function enrich(key: string, s: KellyStats): KellyRow {
  const decided = s.wins + s.losses;
  const winRate = decided === 0 ? null : s.wins / decided;
  const payoffRatio =
    s.avgWin === null || s.avgLoss === null || s.avgLoss === 0 ? null : s.avgWin / s.avgLoss;

  return {
    ...s,
    key,
    decided,
    winRate,
    payoffRatio,
    kelly: kellyFraction(winRate, payoffRatio),
  };
}

/**
 * 표본이 이만큼은 돼야 그 칸의 켈리를 근거로 쓸 수 있다.
 *
 * `verdict.ts` 의 `RELIABLE_SAMPLE` 과 같은 값이지만 여기서는 판정 문구가 아니라
 * **정렬과 흐리기**에 쓴다 — 2건짜리 종목이 +72%로 표 맨 위에 서면 표 전체가 거짓말이 된다.
 */
export const MIN_SAMPLE = 30;

/**
 * 화면에 실을 순서.
 *
 * 크기순 축(보유시간·시각·연패 수)은 집계본이 매긴 순서를 지킨다 — 부호가 어디서
 * 갈리는지는 그 흐름으로만 보인다. 나머지는 켈리 내림차순으로 세워 "어디에 걸 만한
 * 구간이 있나"가 위에서부터 읽히게 하되, 표본 미달은 값과 무관하게 아래로 내린다.
 */
function sortRows(dim: KellyDimension): KellyRow[] {
  if (dim.ordered) return dim.rows;
  return [...dim.rows].sort((a, b) => {
    const aThin = a.decided < MIN_SAMPLE;
    const bThin = b.decided < MIN_SAMPLE;
    if (aThin !== bThin) return aThin ? 1 : -1;
    return (b.kelly ?? -Infinity) - (a.kelly ?? -Infinity);
  });
}

interface RawDimension {
  key: string;
  label: string;
  hint: string;
  ordered: boolean;
  rows: (KellyStats & { key: string })[];
}

export function loadOkxKelly(): OkxKellyReport {
  const report = raw as unknown as Omit<OkxKellyReport, "overall" | "dimensions"> & {
    overall: KellyStats & {
      grossWin: number;
      grossLoss: number;
      feeUsd: number;
      fundingUsd: number;
      liqCount: number;
    };
    dimensions: RawDimension[];
  };

  const dimensions = report.dimensions.map((d) => {
    const withKelly: KellyDimension = {
      key: d.key,
      label: d.label,
      hint: d.hint,
      ordered: d.ordered,
      rows: d.rows.map((r) => enrich(r.key, r)),
    };
    return { ...withKelly, rows: sortRows(withKelly) };
  });

  return {
    ...report,
    overall: { ...report.overall, ...enrich("전체", report.overall) },
    dimensions,
  };
}
