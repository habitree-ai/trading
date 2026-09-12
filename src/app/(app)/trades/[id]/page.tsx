import { notFound } from "next/navigation";

import { ExitPlanCard } from "@/app/(app)/trades/[id]/exit-plan-card";
import { TradeForm } from "@/app/(app)/trades/trade-form";
import { summarizeExits } from "@/lib/exit-plan";
import { isOpenTrade } from "@/lib/metrics";
import { getTrade, listFieldSuggestions, listFills } from "@/lib/queries";

/**
 * 거래 수정 — 차트는 여기 없다. 목록 행에서 펼치는 것으로 충분하고, 위를 차트가 차지하면
 * 정작 고치려는 폼이 아래로 밀린다. 이 화면의 일은 오직 적는 것이다.
 *
 * 읽기만 하는 것은 폼 뒤에 선다. 하루에 몇 번씩 여는 화면이라, 손대지 않는 카드가 앞을
 * 막으면 그 스크롤이 매번 비용이 된다. 원칙 준수 판단은 원칙 탭에 있다 — 판단은 거래
 * 하나가 아니라 여러 거래를 놓고 하는 일이고, 이 화면에 두면 적는 일을 가린다.
 */
export default async function EditTradePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trade = await getTrade(id);
  if (!trade) notFound();

  const [fills, suggestions] = await Promise.all([
    listFills(trade.id),
    listFieldSuggestions(trade.book_id),
  ]);
  const exits = summarizeExits(trade, fills, isOpenTrade(trade));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <TradeForm
        bookId={trade.book_id}
        userId={trade.user_id}
        trade={trade}
        suggestions={suggestions}
        heading={`거래 수정 · #${trade.seq} ${trade.symbol}`}
      />

      <ExitPlanCard trade={trade} summary={exits} />
    </div>
  );
}
