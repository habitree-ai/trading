"use client";

import { usePathname } from "next/navigation";
import { useTransition } from "react";

import { switchBook } from "@/app/(app)/books/actions";
import type { Book } from "@/lib/domain";
import { AREAS, areaOf } from "@/lib/nav";

/**
 * 북 선택 — 수동매매 영역에서만 뜬다.
 *
 * 북은 수동 일지의 단위다. 시스템매매는 모드(paper·live)로 나뉘고 북과 무관하며,
 * 차트·자료는 계좌 데이터가 아니다. 그 화면들에 북 선택이 떠 있으면 "지금 고른 북이
 * 이 숫자에 영향을 준다"고 읽히는데, 사실이 아니다.
 */
export function BookSwitcher({ books, activeId }: { books: Book[]; activeId: string | null }) {
  const [pending, startTransition] = useTransition();
  const pathname = usePathname();
  const area = AREAS.find((a) => a.key === areaOf(pathname));

  if (!area?.usesBook || books.length === 0) return null;

  return (
    // 좁은 화면에서는 "북" 글자를 떼고 폭을 묶는다 — 북 이름이 길면 헤더가 통째로
    // 두 줄로 접혀 차트와 표가 그만큼 밀려 내려갔다.
    <label className="flex items-center gap-1.5 text-[11px] text-dim">
      <span className="hidden sm:inline">북</span>
      <select
        aria-label="북 선택"
        value={activeId ?? ""}
        disabled={pending}
        onChange={(e) => {
          const id = e.target.value;
          startTransition(() => {
            void switchBook(id);
          });
        }}
        className="max-w-24 rounded-lg border border-border bg-surface px-2 py-1 text-xs text-text outline-none focus:border-accent disabled:opacity-50 sm:max-w-none"
      >
        {books.map((book) => (
          <option key={book.id} value={book.id}>
            {book.name}
            {book.status === "closed" ? " (마감)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
