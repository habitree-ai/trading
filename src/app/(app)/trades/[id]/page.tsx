import { notFound } from "next/navigation";

import { PrincipleChecklist } from "@/app/(app)/trades/[id]/principle-checklist";
import { TradeForm } from "@/app/(app)/trades/trade-form";
import { TradeChart } from "@/components/trade-chart";
import { nowMs } from "@/lib/okx";
import {
  getTrade,
  listAnnotations,
  listFills,
  listPrincipleChecks,
  listPrinciples,
} from "@/lib/queries";

export default async function EditTradePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trade = await getTrade(id);
  if (!trade) notFound();

  const [fills, principles, checks, annotations] = await Promise.all([
    listFills(trade.id),
    listPrinciples(trade.book_id),
    listPrincipleChecks(trade.id),
    listAnnotations(trade.id),
  ]);

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

      <TradeChart
        tradeId={trade.id}
        symbol={trade.symbol}
        side={trade.side}
        entryAt={trade.entry_at}
        exitAt={trade.exit_at}
        entryPrice={trade.entry_price}
        exitPrice={trade.exit_price}
        stopPrice={trade.stop_price}
        targetPrice={trade.tp1_price}
        notional={trade.notional}
        now={nowMs()}
        fills={fills}
        annotations={annotations}
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
