import Link from "next/link";

import { pct, signed } from "@/lib/format";
import type { RuleOutcome, TradeRule } from "@/lib/trade-rules";

/**
 * 자동으로 재는 원칙 한 장 — 손 원칙(`PrincipleRow`)과 같은 통계 줄에, 어긴 거래를 순번으로
 * 이어 준다. 고치거나 지우는 버튼은 없다 — 이 원칙은 코드가 정의하고 기록이 판정한다.
 */
export function AutoRuleCard({
  rule,
  stats,
  currency,
}: {
  rule: TradeRule;
  stats: RuleOutcome;
  currency: string;
}) {
  const keptRate = stats.judged === 0 ? null : (stats.judged - stats.broken) / stats.judged;

  return (
    <article className="rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-start gap-2">
        <p className="text-sm">{rule.title}</p>
        <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">자동 판정</span>
      </div>
      <p className="mt-1 text-xs text-dim">
        {rule.detail}
        {rule.manual ? <span className="ml-1 text-dim/80">{rule.manual}</span> : null}
      </p>

      <p className="tnum mt-2 text-[11px] text-dim">
        {stats.judged === 0 ? (
          "아직 거래가 없습니다"
        ) : (
          <>
            판단 {stats.judged}건 · 지킴 {pct(keptRate, 0)}
            {stats.broken > 0 ? (
              <>
                {" · "}
                <span className="text-loss">어김 {stats.broken}건</span>
                {stats.brokenPnl === null ? null : (
                  <>
                    {" ("}
                    <span className={stats.brokenPnl < 0 ? "text-loss" : "text-profit"}>
                      {signed(stats.brokenPnl, 1)} {currency}
                    </span>
                    {")"}
                  </>
                )}
              </>
            ) : null}
          </>
        )}
      </p>

      {stats.brokenTrades.length > 0 ? (
        <p className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
          <span className="text-dim">어긴 거래</span>
          {stats.brokenTrades.map((t) => (
            <Link
              key={t.id}
              href={`/trades/${t.id}`}
              className={`rounded border px-1.5 py-0.5 ${
                t.open ? "border-beta/40 text-beta" : "border-loss/40 text-loss"
              }`}
              title={t.open ? "보유중" : undefined}
            >
              #{t.seq}
            </Link>
          ))}
        </p>
      ) : null}
    </article>
  );
}
