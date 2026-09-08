import Link from "next/link";

import { JournalForm } from "@/app/(app)/trades/new/journal-form";
import { JournalList, type JournalEntry } from "@/app/(app)/trades/new/journal-list";
import { LegacyCapture } from "@/app/(app)/trades/new/legacy-capture";
import { hasPositionRecord } from "@/lib/journal-basis";
import { isOpenTrade } from "@/lib/metrics";
import { nowMs } from "@/lib/okx";
import {
  getActiveBook,
  listAnnotationsByOwner,
  listFieldSuggestions,
  listFillsByTrade,
  listJournalNotes,
  listTradeJournalNotes,
  listTrades,
  requireUser,
} from "@/lib/queries";

/** 고를 수 있는 포지션 수 — 보유중은 전부, 청산은 최근 것부터 여기까지. */
const PICK_LIMIT = 60;
/** 최근 기록 목록 길이 — 두 종류를 합쳐서. */
const LIST_LIMIT = 50;

/**
 * 기록 추가 — 포지션 기록과 일반 기록, 그리고 최근 기록 목록.
 *
 * 캡쳐 OCR 로 거래를 만들던 옛 폼은 맨 아래에 접어 둔다. 거래는 동기화가 만들고, 여기서는
 * 판단과 감정을 적는다.
 */
export default async function NewTradePage({
  searchParams,
}: {
  searchParams: Promise<{ trade?: string }>;
}) {
  const [{ user }, book, { trade: preselect }] = await Promise.all([
    requireUser(),
    getActiveBook(),
    searchParams,
  ]);

  if (!book) {
    return (
      <div className="mx-auto max-w-2xl rounded-xl border border-dashed border-border p-8 text-center">
        <p className="text-sm text-dim">기록을 남기려면 북이 먼저 필요합니다.</p>
        <Link
          href="/books"
          className="mt-3 inline-block rounded-lg bg-accent px-4 py-2 text-sm text-white"
        >
          북 만들기
        </Link>
      </div>
    );
  }

  const [trades, notes, suggestions] = await Promise.all([
    listTrades(book.id),
    listJournalNotes(book.id, LIST_LIMIT),
    listFieldSuggestions(book.id),
  ]);

  // 고르는 순서: 보유중(최근 진입부터) → 청산(최근 청산부터).
  const open = trades.filter(isOpenTrade).sort((a, b) => b.entry_at.localeCompare(a.entry_at));
  const closed = trades
    .filter((t) => !isOpenTrade(t))
    .sort((a, b) => (b.exit_at ?? b.entry_at).localeCompare(a.exit_at ?? a.entry_at));
  const pickable = [...open, ...closed].slice(0, PICK_LIMIT);
  const symbols = [...new Set(trades.map((t) => t.symbol))].sort();
  const pickableIds = pickable.map((t) => t.id);
  // 고를 수 있는 포지션의 추가 기록·체결 — 포지션 탭이 시간순 기록과 추가 진입 후보를 그리는 재료.
  const [notesByTrade, fillsByTrade] = await Promise.all([
    listTradeJournalNotes(pickableIds),
    listFillsByTrade(pickableIds),
  ]);

  // 최근 기록 — 포지션 기록(거래 행)·포지션 추가 기록·일반 기록을 합쳐 최신순.
  const tradeById = new Map(trades.map((t) => [t.id, t]));
  const entries: JournalEntry[] = [
    ...trades
      .filter(hasPositionRecord)
      .map((trade): JournalEntry => ({ kind: "position", at: trade.updated_at, trade })),
    ...notes.map((note): JournalEntry => {
      const trade = note.trade_id ? tradeById.get(note.trade_id) : undefined;
      return trade && note.event
        ? { kind: "position-note", at: note.created_at, note, trade, event: note.event }
        : { kind: "free", at: note.created_at, note };
    }),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, LIST_LIMIT);
  const annotations = await listAnnotationsByOwner(
    entries.flatMap((e) => (e.kind === "position" ? [e.trade.id] : [])),
    entries.flatMap((e) => (e.kind === "free" ? [e.note.id] : [])),
  );
  const now = nowMs();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">기록 추가</h1>
        <p className="mt-1 text-sm text-dim">
          {book.name} · 보유중 {open.length}건 · 기록 {entries.length}건
        </p>
      </header>

      <JournalForm
        bookId={book.id}
        userId={user.id}
        trades={pickable}
        notesByTrade={notesByTrade}
        fillsByTrade={fillsByTrade}
        suggestions={suggestions}
        symbols={symbols}
        now={now}
        initialTradeId={preselect && pickable.some((t) => t.id === preselect) ? preselect : null}
      />

      <section className="space-y-3">
        <h2 className="text-sm font-medium">
          최근 기록 <span className="font-normal text-dim">— 포지션·추가 기록·일반 합쳐 최신순</span>
        </h2>
        <JournalList entries={entries} annotations={annotations} now={now} />
      </section>

      <LegacyCapture bookId={book.id} userId={user.id} suggestions={suggestions} />
    </div>
  );
}
