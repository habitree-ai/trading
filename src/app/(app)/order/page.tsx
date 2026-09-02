import { OrderPanel } from "@/app/(app)/order/order-panel";
import { readOrderStatus } from "@/app/(app)/order/status";
import { EmptyBook } from "@/components/empty-book";
import { RationaleAlert } from "@/components/rationale-alert";
import { dailyStatus } from "@/lib/manual-order";
import { computeMetrics, deriveTrades, isOpenTrade } from "@/lib/metrics";
import { nowMs } from "@/lib/okx";
import { getActiveBook, listCashFlows, listFieldSuggestions, listTrades } from "@/lib/queries";
import { unjustifiedTrades } from "@/lib/rationale";

/**
 * 주문 — 근거가 먼저, 주문은 그 다음.
 *
 * OKX 앱에서 먼저 주문을 내고 나중에 근거를 적는 순서를 뒤집는다. 여기서 낸 주문은 근거·
 * 손절·목표가 전부 있어야 나가고, 나간 순간 그 근거가 거래 행에 붙는다. 그래서 이 화면이
 * 수동매매의 주문 통로가 되면 근거 없는 주문은 구조적으로 존재할 수 없다.
 */
export default async function OrderPage() {
  const book = await getActiveBook();
  if (!book) return <EmptyBook />;

  const [trades, flows, suggestions, status] = await Promise.all([
    listTrades(book.id),
    listCashFlows(book.id),
    listFieldSuggestions(book.id),
    readOrderStatus(book),
  ]);
  const now = nowMs();

  // 절반 켈리 — 대시보드와 같은 계산. 이 주문의 리스크가 상한을 넘는지 옆에 적는다.
  const m = computeMetrics(book, deriveTrades(book, trades, flows), flows);
  const halfKelly = m.kelly === null ? null : Math.max(m.kelly, 0) / 2;

  const unjustified = unjustifiedTrades(trades, now).map((t) => ({
    id: t.id,
    seq: t.seq,
    symbol: t.symbol,
    side: t.side,
    entry_at: t.entry_at,
    open: isOpenTrade(t),
  }));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">주문</h1>
        <p className="mt-1 text-sm text-dim">
          {book.name} · 근거·손절·목표를 다 적어야 주문이 나갑니다 — 차트에 그린 것과 적은 글이 그대로 거래
          기록이 됩니다
        </p>
      </header>

      {/* 근거 없는 거래가 남아 있으면 여기서도 본다 — 새 주문보다 먼저 할 일이다. */}
      <RationaleAlert trades={unjustified} />

      <OrderPanel
        status={status}
        suggestions={suggestions}
        daily={dailyStatus(trades, new Date(now).toISOString())}
        halfKelly={halfKelly}
        now={now}
      />
    </div>
  );
}
