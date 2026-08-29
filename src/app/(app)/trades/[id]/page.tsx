import { notFound } from "next/navigation";

import { AutoRuleVerdicts } from "@/app/(app)/trades/[id]/auto-rule-verdicts";
import { ExitPlanCard } from "@/app/(app)/trades/[id]/exit-plan-card";
import { PrincipleChecklist } from "@/app/(app)/trades/[id]/principle-checklist";
import { TradeForm } from "@/app/(app)/trades/trade-form";
import { summarizeExits } from "@/lib/exit-plan";
import { isOpenTrade } from "@/lib/metrics";
import {
  getTrade,
  listFieldSuggestions,
  listFills,
  listPrincipleChecks,
  listPrinciples,
  listTrades,
} from "@/lib/queries";
import { judgeTradeRules } from "@/lib/trade-rules";

/**
 * 거래 수정 — 차트는 여기 없다. 목록 행에서 펼치는 것으로 충분하고, 위를 차트가 차지하면
 * 정작 고치려는 폼이 아래로 밀린다. 이 화면의 일은 단계 확인·원칙 판단·복기 기록이다.
 */
export default async function EditTradePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trade = await getTrade(id);
  if (!trade) notFound();

  const [principles, checks, fills, suggestions, all] = await Promise.all([
    listPrinciples(trade.book_id),
    listPrincipleChecks(trade.id),
    listFills(trade.id),
    listFieldSuggestions(trade.book_id),
    // 하루 규칙은 같은 날의 다른 거래를 봐야 한다 — 북의 거래 전부를 읽는다.
    listTrades(trade.book_id),
  ]);
  const exits = summarizeExits(trade, fills, isOpenTrade(trade));
  const verdicts = judgeTradeRules(all).get(trade.id) ?? [];

  // 접어 둔 원칙도 이미 판단이 남아 있으면 계속 보여 준다 — 그 기록을 지우거나 고칠
  // 자리가 사라지면 안 된다.
  const judged = new Set(checks.map((c) => c.principle_id));
  const visible = principles.filter((p) => p.active || judged.has(p.id));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">거래 수정</h1>
        <p className="mt-1 text-sm text-dim">
          #{trade.seq} · {trade.symbol}
        </p>
      </header>

      <ExitPlanCard trade={trade} summary={exits} />

      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          원칙 준수{" "}
          <span className="font-normal text-dim">— 누르면 바로 저장됩니다</span>
        </h2>
        <div className="mt-3 space-y-4">
          <AutoRuleVerdicts verdicts={verdicts} />
          <PrincipleChecklist tradeId={trade.id} principles={visible} checks={checks} />
        </div>
      </section>

      <TradeForm bookId={trade.book_id} trade={trade} suggestions={suggestions} />
    </div>
  );
}
