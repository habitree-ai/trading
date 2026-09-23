import Link from "next/link";

import { GeneralNotes } from "@/app/(app)/notes/general-notes";
import { TradeDetail, type PrincipleMark } from "@/app/(app)/notes/trade-detail";
import { NOTES_FILTERS, TradeList, type NotesFilter } from "@/app/(app)/notes/trade-list";
import type { JournalEntry } from "@/app/(app)/trades/new/journal-list";
import { isOpenTrade } from "@/lib/metrics";
import { nowMs } from "@/lib/okx";
import {
  getActiveBook,
  listAnnotationsByOwner,
  listFieldSuggestions,
  listFillsByTrade,
  listJournalNotes,
  listPrincipleChecksByBook,
  listPrinciples,
  listTradeJournalNotes,
  listTrades,
  requireUser,
} from "@/lib/queries";

/**
 * 일반 기록을 찾으려고 읽는 북 기록 수 — 포지션 추가 기록과 섞여 최신순으로 온다.
 * 기록 추가 화면의 최근 목록(50)보다 넉넉히 잡아 일반 기록이 밀려 사라지지 않게 한다.
 */
const JOURNAL_SCAN = 500;

function isFilter(value: string | undefined): value is NotesFilter {
  return (NOTES_FILTERS as readonly string[]).includes(value ?? "");
}

/**
 * 매매 노트 — 한 매매의 근거·복기·추가 기록·사진·원칙 체크를 한 화면에 모은다(REQ-0074).
 *
 * 같은 값이 흩어져 있던 자리(`/trades/[id]` 폼, 기록 추가 포지션 탭, 원칙 탭)는 그대로 두고,
 * 여기는 읽고 그 자리에서 고치는 곳이다. 저장 경로는 모두 거래 행·journal_notes 그대로라
 * 어느 화면에서 고쳐도 같은 값을 본다. 숫자 칸은 고치지 않는다 — 동기화가 채운다.
 */
export default async function NotesPage({
  searchParams,
}: {
  searchParams: Promise<{ trade?: string; filter?: string; view?: string }>;
}) {
  const [{ user }, book, params] = await Promise.all([requireUser(), getActiveBook(), searchParams]);

  if (!book) {
    return (
      <div className="mx-auto max-w-2xl rounded-xl border border-dashed border-border p-8 text-center">
        <p className="text-sm text-dim">매매 노트를 보려면 북이 먼저 필요합니다.</p>
        <Link href="/books" className="mt-3 inline-block rounded-lg bg-accent px-4 py-2 text-sm text-white">
          북 만들기
        </Link>
      </div>
    );
  }

  const filter: NotesFilter = isFilter(params.filter) ? params.filter : "all";
  const general = params.view === "general";
  const [trades, suggestions, principles, checks, journal] = await Promise.all([
    listTrades(book.id),
    listFieldSuggestions(book.id),
    listPrinciples(book.id),
    listPrincipleChecksByBook(book.id),
    listJournalNotes(book.id, JOURNAL_SCAN),
  ]);
  // 매매와 무관한 기록 — 거래에 붙은 추가 기록은 각 매매의 상세에서 본다.
  const freeNotes = journal.filter((n) => n.trade_id === null);
  // 최근 진입부터 — 보유중이든 청산이든 매매가 일어난 순서대로 읽는다.
  const sorted = [...trades].sort((a, b) => b.entry_at.localeCompare(a.entry_at));
  const notesByTrade = await listTradeJournalNotes(sorted.map((t) => t.id));

  // 고른 거래가 없으면 목록 맨 위를 연다(넓은 화면). 좁은 화면은 목록부터 보인다.
  const selected = sorted.find((t) => t.id === params.trade) ?? sorted[0] ?? null;
  const fills = selected ? ((await listFillsByTrade([selected.id]))[selected.id] ?? []) : [];

  const titleById = new Map(principles.map((p) => [p.id, p.title]));
  const marks: PrincipleMark[] = selected
    ? checks
        .filter((c) => c.trade_id === selected.id)
        .map((c) => ({
          title: titleById.get(c.principle_id) ?? "지운 원칙",
          kept: c.kept,
          note: c.note,
        }))
    : [];

  // 일반 기록을 열었을 때만 차트 메모를 읽는다.
  const freeEntries: JournalEntry[] = freeNotes.map((note) => ({ kind: "free", at: note.created_at, note }));
  const freeAnnotations = general ? await listAnnotationsByOwner([], freeNotes.map((n) => n.id)) : {};
  const symbols = [...new Set(trades.map((t) => t.symbol))].sort();
  // 좁은 화면은 무언가를 고른 뒤에만 오른쪽을 보인다.
  const picked = general || Boolean(params.trade);
  const backHref = filter === "all" ? "/notes" : `/notes?filter=${filter}`;

  const noReview = sorted.filter((t) => !isOpenTrade(t) && !t.review).length;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">매매 노트</h1>
        <p className="mt-1 text-sm text-dim">
          {book.name} · 매매 {sorted.length}건 · 복기 안 쓴 청산 {noReview}건 · 일반 기록 {freeNotes.length}건
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className={picked ? "hidden lg:block" : ""}>
          <TradeList
            trades={sorted}
            notesByTrade={notesByTrade}
            selectedId={general ? null : (selected?.id ?? null)}
            filter={filter}
            generalCount={freeNotes.length}
            generalActive={general}
          />
        </div>
        {general ? (
          <div>
            <GeneralNotes
              entries={freeEntries}
              annotations={freeAnnotations}
              bookId={book.id}
              userId={user.id}
              suggestions={suggestions}
              symbols={symbols}
              now={nowMs()}
              backHref={backHref}
            />
          </div>
        ) : selected ? (
          <div className={picked ? "" : "hidden lg:block"}>
            <TradeDetail
              key={selected.id}
              trade={selected}
              notes={notesByTrade[selected.id] ?? []}
              fills={fills}
              principles={marks}
              suggestions={suggestions}
              userId={user.id}
              backHref={backHref}
            />
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-dim">
            아직 매매가 없습니다.
          </p>
        )}
      </div>
    </div>
  );
}
