import Link from "next/link";

import { CapturePanel } from "@/app/(app)/trades/new/capture-panel";
import { getActiveBook, nextSeq, requireUser } from "@/lib/queries";

export default async function NewTradePage() {
  const { user } = await requireUser();
  const book = await getActiveBook();

  if (!book) {
    return (
      <div className="mx-auto max-w-2xl rounded-xl border border-dashed border-border p-8 text-center">
        <p className="text-sm text-dim">거래를 기록하려면 북이 먼저 필요합니다.</p>
        <Link
          href="/books"
          className="mt-3 inline-block rounded-lg bg-accent px-4 py-2 text-sm text-white"
        >
          북 만들기
        </Link>
      </div>
    );
  }

  const seq = await nextSeq(book.id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">기록 추가</h1>
        <p className="mt-1 text-sm text-dim">
          {book.name} · {seq}번째 거래
        </p>
      </header>

      <CapturePanel bookId={book.id} userId={user.id} />
    </div>
  );
}
