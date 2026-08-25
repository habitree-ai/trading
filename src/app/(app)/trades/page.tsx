import Link from "next/link";

import { SyncAction } from "@/app/(app)/trades/okx-sync-button";
import { TradeTable } from "@/app/(app)/trades/trade-table";
import { EmptyBook } from "@/components/empty-book";
import { dateTime } from "@/lib/format";
import { deriveTrades, isOpenTrade } from "@/lib/metrics";
import { nowMs } from "@/lib/okx";
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

  // 체결·메모는 여기서 받지 않는다 — 차트를 펼친 거래만 자기 것을 읽는다.
  const [trades, flows, lastSync] = await Promise.all([
    listTrades(book.id),
    listCashFlows(book.id),
    // 머리말의 "마지막 동기화" 한 줄 때문에 다른 조회를 다 받고 나서 한 번 더
    // 기다리고 있었다. 서로 의존하지 않으므로 같이 띄운다.
    book.exchange_account_id ? getLastSync(book.id) : null,
  ]);
  // 들고 있는 거래의 체결만 읽는다 — 부분청산이 얼마나 됐는지는 체결에만 있다.
  const openFills = await listFillsByTrade(trades.filter(isOpenTrade).map((t) => t.id));
  // 표의 `자금` 칸이 대시보드와 같은 값을 가리키도록 이체를 함께 넘긴다.
  const derived = deriveTrades(book, trades, flows);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">거래 목록</h1>
          <p className="mt-1 text-sm text-dim">
            {book.name} · {derived.length}건
            {book.exchange_account_id ? (
              <> · 마지막 동기화 {lastSync ? dateTime(lastSync.started_at) : "없음"}</>
            ) : null}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <SyncAction linked={Boolean(book.exchange_account_id)} />
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
        <TradeTable rows={derived} fills={openFills} currency={book.base_currency} now={nowMs()} />
      )}
    </div>
  );
}
