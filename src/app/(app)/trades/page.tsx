import Link from "next/link";

import { OkxSyncButton } from "@/app/(app)/trades/okx-sync-button";
import { TradeTable } from "@/app/(app)/trades/trade-table";
import { EmptyBook } from "@/components/empty-book";
import { dateTime } from "@/lib/format";
import { deriveTrades } from "@/lib/metrics";
import {
  getActiveBook,
  getLastSync,
  listCashFlows,
  listFillsByTrade,
  listTrades,
} from "@/lib/queries";

export default async function TradesPage() {
  const book = await getActiveBook();
  if (!book) return <EmptyBook />;

  const [trades, flows, fillsByTrade] = await Promise.all([
    listTrades(book.id),
    listCashFlows(book.id),
    listFillsByTrade(book.id),
  ]);
  // 표의 `자금` 칸이 대시보드와 같은 값을 가리키도록 이체를 함께 넘긴다.
  const derived = deriveTrades(book, trades, flows);
  const lastSync = book.okx_sync_enabled ? await getLastSync(book.id) : null;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">거래 목록</h1>
          <p className="mt-1 text-sm text-dim">
            {book.name} · {derived.length}건
            {book.okx_sync_enabled ? (
              <> · 마지막 동기화 {lastSync ? dateTime(lastSync.started_at) : "없음"}</>
            ) : null}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {book.okx_sync_enabled ? <OkxSyncButton /> : null}
          <Link
            href="/trades/new"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            기록 추가
          </Link>
        </div>
      </header>

      {derived.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          아직 거래가 없습니다. 첫 기록을 추가해 주세요.
        </p>
      ) : (
        <TradeTable rows={derived} currency={book.base_currency} fillsByTrade={fillsByTrade} />
      )}
    </div>
  );
}
