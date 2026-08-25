import {
  mergeStages,
  type ExitActual,
  type ExitPlan,
  type ExitStage,
  type ExitSummary,
  type PlanStep,
  type StopLeg,
} from "@/lib/exit-plan";
import { DASH, dateTime, num, pct, pnlClass, signed, signedPct } from "@/lib/format";

/**
 * 분할 청산 계획·실적의 표시 조각 — 훅이 없어 서버·클라이언트 어디서든 그린다.
 *
 * 네 화면(거래 목록 셀·거래 상세 카드·대시보드 펼침·좁은 화면)이 같은 어휘를 쓴다:
 *   `SL 95.00 −5.00% −50 거래소` / `TP1 105.00 33% +5.00% +16.7` / `실제 1 105.10 50% +5.10% +25.5`
 * 숫자 포맷은 format.ts 만 쓴다 — 직접 toLocaleString 을 부르면 서버와 브라우저가 다른
 * 문자열을 만들어 하이드레이션이 깨진다.
 */

const BADGE = "inline-block rounded border px-1 text-center text-[10px] leading-4";
const SL_BADGE = `${BADGE} border-loss/40 text-loss`;
const TP_BADGE = `${BADGE} border-profit/40 text-profit`;
const ACTUAL_BADGE = `${BADGE} border-beta/40 text-beta`;

function Warn({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <span className="text-beta" title={text} aria-label={text}>
      ⚠
    </span>
  );
}

/** 값이 어디서 왔는지 — 거래소면 그렇게, 계획값이 나란히 있으면 함께. */
function SourceTag({ source, planPrice }: { source: "plan" | "okx"; planPrice: number | null }) {
  if (source !== "okx") return null;
  return (
    <span className="text-dim">
      거래소{planPrice !== null ? ` · 내 계획 ${num(planPrice)}` : ""}
    </span>
  );
}

function StopLine({ stop }: { stop: StopLeg | null }) {
  if (!stop) {
    return (
      <div className="text-dim">
        <span className={SL_BADGE}>SL</span> {DASH}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5">
      <span className={SL_BADGE}>SL</span>
      <span>{num(stop.price)}</span>
      <span className="text-loss">{signedPct(stop.riskPct === null ? null : -stop.riskPct, 2)}</span>
      <span className="text-loss">{signed(stop.lossAmount, 0)}</span>
      <SourceTag source={stop.source} planPrice={stop.planPrice} />
      <Warn text={stop.problem} />
    </div>
  );
}

/** 세 자리는 늘 보인다 — 비어 있는 단이 어느 것인지 알아야 채울 수 있다. */
const TP_SLOTS = [1, 2, 3] as const;

function PlanLine({ step }: { step: PlanStep }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5">
      <span className={TP_BADGE}>TP{step.n}</span>
      <span>{num(step.price)}</span>
      <span className="text-dim">{pct(step.share, 0)}</span>
      <span className={pnlClass(step.movePct)}>{signedPct(step.movePct, 2)}</span>
      <span className={pnlClass(step.amount)}>{signed(step.amount, 0)}</span>
      <SourceTag source={step.source} planPrice={step.planPrice} />
      <Warn text={step.problem} />
    </div>
  );
}

/**
 * 단계 한 줄 — `1차 체결 79,458 · 50% · +0.70% · +36` / `2차 예상 81,000 · 33% · +2.65% · +90`.
 * 수익률은 진입가 대비, 수익금은 체결이면 실현값·예상이면 등록된 TP 가격 기준이다.
 */
function StageLine({ stage }: { stage: ExitStage }) {
  if (stage.kind === "empty") {
    return (
      <div className="text-dim">
        <span className={`${BADGE} border-border text-dim`}>{stage.n}차 예상</span> {DASH}
      </div>
    );
  }
  const filled = stage.kind === "filled";
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5">
      <span className={filled ? ACTUAL_BADGE : TP_BADGE}>
        {stage.n}차 {filled ? "체결" : "예상"}
      </span>
      <span>{num(stage.price)}</span>
      <span className="text-dim">{pct(stage.share, 0)}</span>
      <span className={pnlClass(stage.movePct)}>{signedPct(stage.movePct, 2)}</span>
      <span className={pnlClass(stage.pnl)}>{signed(stage.pnl, 0)}</span>
      {stage.tp !== null && stage.tp !== stage.n ? <span className="text-dim">TP{stage.tp}</span> : null}
      {stage.source === "okx" ? <span className="text-dim">거래소</span> : null}
      {stage.estimated ? <span className="text-dim">추정</span> : null}
      <Warn text={stage.problem} />
    </div>
  );
}

/**
 * 줄 형태 — 목록 셀·대시보드·좁은 화면.
 *
 * 손절 한 줄 뒤에 단계가 차수 순으로 선다. 체결된 차수는 실현값, 아직이면 등록된 TP 기준
 * 예상치다. 닫힌 거래는 체결만 남고 계획은 흐리게 비교용으로 아래 붙는다.
 */
export function ExitPlanLines({ summary }: { summary: ExitSummary }) {
  const { plan, mode } = summary;
  const stages = mergeStages(summary);

  return (
    <div className="tnum space-y-0.5 text-[11px] leading-4">
      <StopLine stop={plan.stop} />
      {stages.map((s) => (
        <StageLine key={s.n} stage={s} />
      ))}
      {mode === "actual-with-plan" && plan.steps.length > 0 ? (
        <div className="opacity-60">
          {TP_SLOTS.map((n) => {
            const step = plan.steps.find((s) => s.n === n);
            return step ? (
              <PlanLine key={n} step={step} />
            ) : (
              <div key={n} className="text-dim">
                <span className={TP_BADGE}>TP{n}</span> {DASH}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

const TH = "py-1 text-right font-medium";

function RCell({ r }: { r: number | null }) {
  return (
    <td className={`hidden py-1.5 text-right sm:table-cell ${pnlClass(r)}`}>
      {r === null ? DASH : `${num(r, 2)}R`}
    </td>
  );
}

/** 계획 표 — 단계 · 가격 · 비중 · 가격폭 · 금액 · 수익률(증거금) · R. */
export function PlanTable({ plan, hideTotal }: { plan: ExitPlan; hideTotal: boolean }) {
  return (
    <table className="tnum w-full text-xs">
      <thead className="text-[11px] text-dim">
        <tr>
          <th className="py-1 text-left font-medium">단계</th>
          <th className={TH}>가격</th>
          <th className={TH}>비중</th>
          <th className={TH}>가격폭</th>
          <th className={TH}>금액</th>
          <th className={TH}>
            수익률<span className="block font-normal">증거금</span>
          </th>
          <th className={`hidden sm:table-cell ${TH}`}>R</th>
        </tr>
      </thead>
      <tbody>
        {TP_SLOTS.map((n) => {
          const s = plan.steps.find((step) => step.n === n);
          if (!s) {
            return (
              <tr key={n} className="border-t border-border text-dim">
                <td className="py-1.5 whitespace-nowrap">
                  <span className={TP_BADGE}>TP{n}</span>
                </td>
                <td className="py-1.5 text-right">{DASH}</td>
                <td colSpan={5} className="py-1.5 text-right text-[11px]">
                  거래 수정에서 가격을 적으면 채워집니다
                </td>
              </tr>
            );
          }
          return (
            <tr key={s.n} className="border-t border-border">
              <td className="py-1.5 whitespace-nowrap">
                <span className={TP_BADGE}>TP{s.n}</span> <Warn text={s.problem} />
              </td>
              <td className="py-1.5 text-right">
                {num(s.price)}
                {s.source === "okx" ? (
                  <span className="block text-[11px] text-dim">
                    거래소{s.planPrice !== null ? ` · 내 계획 ${num(s.planPrice)}` : ""}
                  </span>
                ) : null}
              </td>
              <td className="py-1.5 text-right text-dim">
                {pct(s.share, 0)}
                {s.shareSource === "even" ? <span className="block text-[11px]">균등</span> : null}
              </td>
              <td className={`py-1.5 text-right ${pnlClass(s.movePct)}`}>{signedPct(s.movePct, 2)}</td>
              <td className={`py-1.5 text-right ${pnlClass(s.amount)}`}>{signed(s.amount)}</td>
              <td className={`py-1.5 text-right ${pnlClass(s.returnPct)}`}>{signedPct(s.returnPct)}</td>
              <RCell r={s.r} />
            </tr>
          );
        })}
      </tbody>
      {/* 합이 100 이 아닐 때의 합계는 그 물량 기준이라 "이 거래 최대" 로 읽힌다 — 숨긴다. */}
      {plan.steps.length > 0 && !hideTotal ? (
        <tfoot className="border-t border-border text-[11px]">
          <tr>
            <td className="py-1.5 text-dim">합계</td>
            <td />
            <td className="py-1.5 text-right text-dim">{pct(plan.shareSum, 0)}</td>
            <td />
            <td className={`py-1.5 text-right ${pnlClass(plan.total.amount)}`}>
              {signed(plan.total.amount)}
            </td>
            <td className={`py-1.5 text-right ${pnlClass(plan.total.returnPct)}`}>
              {signedPct(plan.total.returnPct)}
            </td>
            <RCell r={plan.total.blendedR} />
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

/** 실적 표 — 계획 표와 같은 열에 수수료·시각이 붙는다. */
export function ActualTable({ actual }: { actual: ExitActual }) {
  return (
    <table className="tnum w-full text-xs">
      <thead className="text-[11px] text-dim">
        <tr>
          <th className="py-1 text-left font-medium">차수</th>
          <th className={TH}>가격</th>
          <th className={TH}>비중</th>
          <th className={TH}>가격폭</th>
          <th className={TH}>손익</th>
          <th className={TH}>
            수익률<span className="block font-normal">증거금</span>
          </th>
          <th className={`hidden sm:table-cell ${TH}`}>R</th>
          <th className={`hidden sm:table-cell ${TH}`}>시각</th>
        </tr>
      </thead>
      <tbody>
        {actual.steps.map((s) => (
          <tr key={s.n} className="border-t border-border">
            <td className="py-1.5 whitespace-nowrap">
              <span className={ACTUAL_BADGE}>{s.n}차</span>
              {s.estimated ? <span className="ml-1 text-[11px] text-dim">추정</span> : null}
            </td>
            <td className="py-1.5 text-right">
              {num(s.price)}
              {s.fillCount > 1 ? (
                <span className="block text-[11px] text-dim">{s.fillCount}체결 평균</span>
              ) : null}
            </td>
            <td className="py-1.5 text-right text-dim">{pct(s.share, 0)}</td>
            <td className={`py-1.5 text-right ${pnlClass(s.movePct)}`}>{signedPct(s.movePct, 2)}</td>
            <td className={`py-1.5 text-right ${pnlClass(s.pnl)}`}>
              {signed(s.pnl)}
              {s.fee !== null ? (
                <span className="block text-[11px] text-dim">수수료 {signed(s.fee)}</span>
              ) : null}
            </td>
            <td className={`py-1.5 text-right ${pnlClass(s.returnPct)}`}>{signedPct(s.returnPct)}</td>
            <RCell r={s.r} />
            <td className="hidden py-1.5 text-right text-dim sm:table-cell">{dateTime(s.at)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot className="border-t border-border text-[11px]">
        <tr>
          <td className="py-1.5 text-dim">합계</td>
          <td />
          <td className="py-1.5 text-right text-dim">
            {pct(actual.closedShare, 0)}
            {actual.remainingShare !== null && actual.remainingShare > 0 ? (
              <span className="block">보유 {pct(actual.remainingShare, 0)}</span>
            ) : null}
          </td>
          <td />
          <td className={`py-1.5 text-right ${pnlClass(actual.pnlTotal)}`}>
            {signed(actual.pnlTotal)}
            {actual.closeFeeTotal !== null ? (
              <span className="block text-dim">수수료 {signed(actual.closeFeeTotal)}</span>
            ) : null}
          </td>
          <td />
          <td className="hidden sm:table-cell" />
          <td className="hidden sm:table-cell" />
        </tr>
      </tfoot>
    </table>
  );
}
