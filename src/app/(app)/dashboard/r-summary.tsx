import Link from "next/link";

import { EDGE_MIN_SAMPLE, EDGE_VERDICT_LABEL } from "@/lib/edge";
import { DASH, num, pct, pnlClass, signed } from "@/lib/format";
import type { REdgeReport } from "@/lib/r-edge-report";

const VERDICT_CLASS = {
  insufficient: "text-beta",
  undetermined: "text-dim",
  positive: "text-profit",
  negative: "text-loss",
} as const;

/**
 * 대시보드의 R 엣지 한 줄(REQ-0091) — 한 거래에 평균 몇 R(최초 위험 단위)을 버는가.
 *
 * 위 「기대치」는 금액 기준(평균손실 1 단위)이라 숫자가 다르다. 상세·그림·필터는 R 엣지 탭에 있다.
 */
export function RSummary({ report }: { report: REdgeReport }) {
  const { stats, interval, verdict, unmeasured } = report;
  const last = report.points.at(-1)?.cum ?? null;
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <h2 className="text-sm font-medium">
          R 엣지 <span className="font-normal text-dim">— 최초 위험 1R 당 평균 결과</span>
        </h2>
        <Link href="/kelly?tab=r" className="ml-auto text-xs text-accent">
          R 엣지 자세히 →
        </Link>
      </div>
      <div className="tnum mt-2 flex flex-wrap items-baseline gap-x-8 gap-y-2 text-sm">
        <span>
          <span className="text-xs text-dim">엣지 </span>
          <span className={`text-xl font-semibold ${pnlClass(stats.edge)}`}>
            {stats.edge === null ? DASH : `${signed(stats.edge, 2)}R`}
          </span>
        </span>
        <span>
          <span className="text-xs text-dim">95% 구간 </span>
          {interval === null ? DASH : `${signed(interval[0], 2)} ~ ${signed(interval[1], 2)}`}
        </span>
        <span>
          <span className="text-xs text-dim">N </span>
          {num(stats.n, 0)}건
        </span>
        <span>
          <span className="text-xs text-dim">R 승률 </span>
          {pct(stats.winRate)}
        </span>
        <span>
          <span className="text-xs text-dim">누적 </span>
          <span className={pnlClass(last)}>{last === null ? DASH : `${signed(last, 1)}R`}</span>
        </span>
        <span className={`text-xs ${VERDICT_CLASS[verdict]}`}>
          {EDGE_VERDICT_LABEL[verdict]}
          {verdict === "insufficient" ? ` (${EDGE_MIN_SAMPLE}건 미만)` : ""}
        </span>
        {unmeasured.count > 0 ? (
          <span className="text-xs text-dim">R 미측정 {unmeasured.count}건 제외</span>
        ) : null}
      </div>
    </section>
  );
}
