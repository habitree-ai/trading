import Link from "next/link";

import { LiveTestPanel } from "@/app/(app)/trades/live-test-panel";
import { SyncAction } from "@/app/(app)/trades/okx-sync-button";
import { TradeTable } from "@/app/(app)/trades/trade-table";
import { EmptyBook } from "@/components/empty-book";
import { dateTime } from "@/lib/format";
import { deriveTrades } from "@/lib/metrics";
import { nowMs } from "@/lib/okx";
import {
  LIVE_TEST_LEV,
  equityUsd,
  hasLiveKeys,
  instrument,
  lastPrice,
  positions,
} from "@/lib/okx-live";
import {
  getActiveBook,
  getLastSync,
  listAnnotationsByTrade,
  listCashFlows,
  listFillsByTrade,
  listTrades,
} from "@/lib/queries";

/** 실주문 테스트 패널에 넘길 계좌 상태 — 키가 없거나 조회가 막히면 그 사실만 전한다. */
async function readLiveStatus() {
  if (!hasLiveKeys()) return null;
  try {
    const [eq, px, inst, open] = await Promise.all([
      equityUsd(),
      lastPrice("BTC-USDT-SWAP"),
      instrument("BTC-USDT-SWAP"),
      positions("BTC-USDT-SWAP"),
    ]);
    const minNotional = inst.minSz * inst.ctVal * px;
    return {
      equity: eq,
      price: px,
      minNotional,
      needBalance: (minNotional / LIVE_TEST_LEV) * 1.3 + 0.1,
      openPositions: open,
      statusError: null as string | null,
    };
  } catch (e) {
    return {
      equity: null,
      price: null,
      minNotional: null,
      needBalance: null,
      openPositions: [],
      statusError: e instanceof Error ? e.message : "계좌 조회 실패",
    };
  }
}

export default async function TradesPage() {
  const book = await getActiveBook();
  if (!book) return <EmptyBook />;

  const [trades, flows, fillsByTrade, annotationsByTrade, liveStatus] = await Promise.all([
    listTrades(book.id),
    listCashFlows(book.id),
    listFillsByTrade(book.id),
    listAnnotationsByTrade(book.id),
    readLiveStatus(),
  ]);
  // 표의 `자금` 칸이 대시보드와 같은 값을 가리키도록 이체를 함께 넘긴다.
  const derived = deriveTrades(book, trades, flows);
  const lastSync = book.exchange_account_id ? await getLastSync(book.id) : null;

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

      {liveStatus ? <LiveTestPanel {...liveStatus} /> : null}

      {derived.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          아직 거래가 없습니다. 첫 기록을 추가해 주세요.
        </p>
      ) : (
        <TradeTable
          rows={derived}
          currency={book.base_currency}
          now={nowMs()}
          fillsByTrade={fillsByTrade}
          annotationsByTrade={annotationsByTrade}
        />
      )}
    </div>
  );
}
