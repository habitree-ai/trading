import { ActualTable, ExitPlanLines, PlanTable } from "@/components/exit-plan";
import type { Trade } from "@/lib/domain";
import type { ExitSummary } from "@/lib/exit-plan";
import { DASH, num, signed, signedPct } from "@/lib/format";
import { netOf } from "@/lib/metrics";

const MODE_LABEL: Record<ExitSummary["mode"], string> = {
  plan: "보유중 · 계획 기준",
  "plan-with-actual": "보유중 · 부분청산 — 계획 + 지금까지 실적",
  "actual-with-plan": "청산 · 실적 기준",
};

/**
 * 거래 상세의 청산 계획·실적 카드.
 *
 * 손절은 한 줄로 위에 — 두 표에 같은 값을 두 번 적지 않는다. 아래는 계획 표와 실적 표를
 * 나란히 두되, 닫힌 거래는 실적을 왼쪽에 세우고 계획은 흐리게 비교용으로 남긴다.
 * 좁은 화면에서는 표 대신 목록 셀과 같은 줄 형태로 접는다 — 7열 표 둘은 375px 에서 읽을 수 없다.
 */
export function ExitPlanCard({ trade, summary }: { trade: Trade; summary: ExitSummary }) {
  const { plan, actual, mode, size, open } = summary;
  const actualFirst = mode === "actual-with-plan";
  const stop = plan.stop;
  // 부분청산 중인 OKX 거래의 명목가는 남은 물량이라 원래 크기로 되돌려 잰다(진입 체결 합 또는
  // 남은 물량 + 덜어낸 양). 표의 '증거금 대비'는 남은 물량 기준이라 분모가 다르다 — 제목에 밝힌다.
  const restored =
    open &&
    size.notional !== null &&
    trade.notional !== null &&
    Math.abs(size.notional - Math.abs(trade.notional)) > 1e-6;
  const marginLabel = restored ? "원래 증거금" : "증거금";

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-medium">
          손절 · 목표{" "}
          <span className="font-normal text-dim">
            — 금액 = 명목가 × 가격폭 × 비중 · 수익률 = 금액 ÷ {marginLabel}
          </span>
        </h2>
        <span className="ml-auto rounded border border-border px-1.5 py-0.5 text-[11px] text-dim">
          {MODE_LABEL[mode]}
        </span>
      </div>

      <p className="tnum mt-2 text-xs">
        <span className="rounded border border-loss/40 px-1.5 py-0.5 text-[11px] text-loss">손절</span>{" "}
        {stop ? (
          <>
            {num(stop.price)}{" "}
            <span className="text-[11px] text-dim">
              {stop.source === "okx" ? "거래소" : "내 계획"}
              {stop.planPrice !== null ? ` · 내 계획 ${num(stop.planPrice)}` : ""}
            </span>
            {" · "}
            <span className="text-loss">
              {signedPct(stop.riskPct === null ? null : -stop.riskPct, 2)} · {signed(stop.lossAmount)} ·{" "}
              {marginLabel} 대비 {signedPct(stop.returnPct)}
            </span>
            {stop.problem ? <span className="ml-2 text-beta">⚠ {stop.problem}</span> : null}
          </>
        ) : (
          <span className="text-dim">{DASH}</span>
        )}
      </p>
      {plan.rBasis === "okx" ? (
        <p className="mt-1 text-[11px] text-dim">
          R 은 거래소 손절(마지막 등록값) 기준입니다 — 계획 손절가를 적으면 그쪽으로 잽니다.
        </p>
      ) : plan.rBasis === null && plan.steps.length > 0 ? (
        <p className="mt-1 text-[11px] text-dim">손절가가 없어 R 을 잴 수 없습니다.</p>
      ) : null}

      {/* 좁은 화면 — 줄 형태 */}
      <div className="mt-3 sm:hidden">
        <ExitPlanLines summary={summary} />
      </div>

      <div className={`mt-3 hidden gap-4 sm:grid ${actual ? "lg:grid-cols-2" : ""}`}>
        <div className={actualFirst ? "opacity-75 lg:order-2" : ""}>
          <h3 className="text-xs font-medium">
            계획{" "}
            <span className="font-normal text-dim">
              — 입력한 TP · 비중{actualFirst ? " (비교용)" : ""}
            </span>
          </h3>
          <div className="scroll-x mt-1">
            <PlanTable plan={plan} hideTotal={plan.shareProblem !== null} />
          </div>
          {plan.shareProblem ? <p className="mt-1 text-[11px] text-beta">⚠ {plan.shareProblem}</p> : null}
          {plan.orderProblem ? <p className="mt-1 text-[11px] text-beta">⚠ {plan.orderProblem}</p> : null}
        </div>

        {actual ? (
          <div className={actualFirst ? "lg:order-1" : ""}>
            <h3 className="text-xs font-medium">
              실적{" "}
              <span className="font-normal text-dim">
                — 청산 체결로 되짚은 추정{open ? " · 지금까지" : ""}
              </span>
            </h3>
            <div className="scroll-x mt-1">
              <ActualTable actual={actual} />
            </div>
            {/*
              체결에는 손익이 없다 — 가격손익은 평균 진입가 대비 추정이라 장부의 비용 전 손익(pnl)과
              견주고, 거래소 실현손익(realized_pnl)은 진입 수수료·펀딩비·ADL 까지 든 값이라 따로 적는다.
            */}
            <p className="tnum mt-1 text-[11px] text-dim">
              체결 추정 {signed(actual.pnlTotal)} · 장부 손익(비용 전) {signed(trade.pnl)} · 거래소 실현{" "}
              {signed(netOf(trade))}
              {trade.fee !== null ? ` · 총 수수료 ${signed(trade.fee)}` : ""}
              {actual.source === "exit_price" ? " · 체결이 없어 청산가 한 점으로 되짚었습니다" : ""}
              {size.source === null && open ? " · 덜어낸 양을 몰라 비중은 보유분 기준입니다" : ""}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
