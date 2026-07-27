import { notFound } from "next/navigation";

import { TradeForm } from "@/app/(app)/trades/trade-form";
import { TradeChart } from "@/components/trade-chart";
import { getTrade, listFills } from "@/lib/queries";

export default async function EditTradePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trade = await getTrade(id);
  if (!trade) notFound();

  const fills = await listFills(trade.id);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">거래 수정</h1>
        <p className="mt-1 text-sm text-dim">
          #{trade.seq} · {trade.symbol}
        </p>
      </header>

      <TradeChart
        symbol={trade.symbol}
        side={trade.side}
        entryAt={trade.entry_at}
        exitAt={trade.exit_at}
        entryPrice={trade.entry_price}
        exitPrice={trade.exit_price}
        stopPrice={trade.stop_price}
        fills={fills}
      />

      <TradeForm bookId={trade.book_id} trade={trade} />
    </div>
  );
}
