import { notFound } from "next/navigation";

import { TradeForm } from "@/app/(app)/trades/trade-form";
import { getTrade } from "@/lib/queries";

export default async function EditTradePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trade = await getTrade(id);
  if (!trade) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">거래 수정</h1>
        <p className="mt-1 text-sm text-dim">
          #{trade.seq} · {trade.symbol}
        </p>
      </header>

      <TradeForm bookId={trade.book_id} trade={trade} />
    </div>
  );
}
