import { notFound } from "next/navigation";

import { ExitPlanCard } from "@/app/(app)/trades/[id]/exit-plan-card";
import { PrincipleChecklist } from "@/app/(app)/trades/[id]/principle-checklist";
import { TradeForm } from "@/app/(app)/trades/trade-form";
import { TradeChart } from "@/components/trade-chart";
import { activeTargetPrices, summarizeExits } from "@/lib/exit-plan";
import { isOpenTrade } from "@/lib/metrics";
import { nowMs } from "@/lib/okx";
import { getTrade, listFills, listPrincipleChecks, listPrinciples } from "@/lib/queries";

export default async function EditTradePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trade = await getTrade(id);
  if (!trade) notFound();

  // 메모는 차트가 직접 읽는다. 체결은 청산 실적 카드 때문에 여기서도 한 번 읽는다 — 차트가
  // 같은 것을 다시 받지만 한 거래분이라 감수한다(목록이 북 전량을 싣지 않는 결정과는 무관).
  const [principles, checks, fills] = await Promise.all([
    listPrinciples(trade.book_id),
    listPrincipleChecks(trade.id),
    listFills(trade.id),
  ]);
  const exits = summarizeExits(trade, fills, isOpenTrade(trade));

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

      {/* 기준선은 거래소에 걸려 있던 값이 먼저다 — 손 입력은 계획이라 실제와 다를 수 있다. */}
      <TradeChart
        tradeId={trade.id}
        symbol={trade.symbol}
        side={trade.side}
        entryAt={trade.entry_at}
        exitAt={trade.exit_at}
        entryPrice={trade.entry_price}
        exitPrice={trade.exit_price}
        stopPrice={trade.okx_stop_price ?? trade.stop_price}
        targets={activeTargetPrices(trade)}
        notional={trade.notional}
        now={nowMs()}
      />

      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          원칙 준수{" "}
          <span className="font-normal text-dim">— 누르면 바로 저장됩니다</span>
        </h2>
        <div className="mt-3">
          <PrincipleChecklist tradeId={trade.id} principles={visible} checks={checks} />
        </div>
      </section>

      <TradeForm bookId={trade.book_id} trade={trade} />
    </div>
  );
}
