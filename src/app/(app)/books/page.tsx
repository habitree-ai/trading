import { BookForm } from "@/app/(app)/books/book-form";
import { BookRow } from "@/app/(app)/books/book-row";
import { computeMetrics, deriveTrades } from "@/lib/metrics";
import { getActiveBook, listBooks, listCashFlows, listTrades } from "@/lib/queries";

export default async function BooksPage() {
  const books = await listBooks();
  const active = await getActiveBook(books);

  const summaries = await Promise.all(
    books.map(async (book) => {
      const [trades, flows] = await Promise.all([listTrades(book.id), listCashFlows(book.id)]);
      return { book, metrics: computeMetrics(book, deriveTrades(book, trades, flows), flows) };
    }),
  );

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">북 관리</h1>
        <p className="mt-1 text-sm text-dim">
          계좌나 기간별로 일지를 나눕니다. 구글시트의 탭 하나가 북 하나에 해당합니다.
        </p>
      </header>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">새 북 만들기</h2>
        <BookForm />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">북 목록 ({books.length})</h2>
        {summaries.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-dim">
            아직 북이 없습니다. 위에서 첫 북을 만들어 주세요.
          </p>
        ) : (
          summaries.map(({ book, metrics }) => (
            <BookRow
              key={book.id}
              book={book}
              metrics={metrics}
              isActive={book.id === active?.id}
            />
          ))
        )}
      </section>
    </div>
  );
}
