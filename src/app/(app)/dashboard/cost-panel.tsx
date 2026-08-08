import { num, pnlClass, signed } from "@/lib/format";
import type { BookMetrics } from "@/lib/metrics";
import { readCost, TONE_CLASS } from "@/lib/verdict";

/**
 * 비용 — 가격으로 번 돈과 계좌에 남은 돈 사이에서 사라진 금액.
 *
 * 지금까지 화면은 실현손익 한 덩어리만 보여 줬다. 그러면 자금이 줄어든 이유가 방향을
 * 틀려서인지 회전이 잦아서인지 갈리지 않는다. 고배율·단타 계좌에서는 이 둘이 전혀 다른
 * 처방으로 이어진다 — 앞은 진입을 고치는 문제고, 뒤는 덜 들어가는 문제다.
 *
 * 그래서 한 줄로 이어 붙인다: 가격 손익 − 수수료 − 펀딩비 = 실현손익.
 */
export function CostPanel({ m, currency }: { m: BookMetrics; currency: string }) {
  const cost = m.fees + m.fundingFees;
  const verdict = readCost({
    pnlBeforeCost: m.pnlBeforeCost,
    cost,
    netPnl: m.netPnl,
    flipped: m.costFlippedCount,
  });

  // 건당 평균 — 총액만 보면 "많이 해서 그렇다"에서 멈춘다. 한 번 들어갈 때마다
  // 얼마가 나가는지를 알아야 회전을 줄일지 크기를 줄일지가 정해진다.
  const perTrade = m.closedCount === 0 ? null : cost / m.closedCount;

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h3 className="text-sm font-medium">
        비용 분해{" "}
        <span className="font-normal text-dim">
          — 가격으로 번 돈에서 무엇이 얼마나 빠졌는가 ({currency})
        </span>
      </h3>

      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Cell label="가격 손익" value={m.pnlBeforeCost} hint="수수료·펀딩비 이전" />
        <Cell label="수수료" value={m.fees} hint={perTrade === null ? "" : `건당 ${num(perTrade, 2)}`} />
        <Cell label="펀딩비" value={m.fundingFees} hint="포지션을 들고 있던 값" />
        <Cell label="실현손익" value={m.netPnl} hint="계좌가 실제로 움직인 금액" strong />
      </dl>

      <p className={`mt-3 text-xs ${TONE_CLASS[verdict.tone]}`}>{verdict.text}</p>
    </section>
  );
}

function Cell({
  label,
  value,
  hint,
  strong = false,
}: {
  label: string;
  value: number;
  hint: string;
  /** 결과 칸 — 앞의 세 칸이 더해진 자리라 한 단계 강조한다. */
  strong?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        strong ? "border-border bg-surface-2/70" : "border-border bg-surface-2/40"
      }`}
    >
      <dt className="text-[11px] text-dim">{label}</dt>
      <dd className={`tnum mt-0.5 font-medium ${strong ? "text-base" : "text-sm"} ${pnlClass(value)}`}>
        {signed(value, 2)}
      </dd>
      {hint ? <p className="mt-0.5 text-[10px] text-dim">{hint}</p> : null}
    </div>
  );
}
