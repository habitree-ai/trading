"use client";

import { useTransition } from "react";

import { switchBook } from "@/app/(app)/books/actions";
import type { Book } from "@/lib/domain";

export function BookSwitcher({ books, activeId }: { books: Book[]; activeId: string | null }) {
  const [pending, startTransition] = useTransition();

  if (books.length === 0) return null;

  return (
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
      className="rounded-lg border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent disabled:opacity-50"
    >
      {books.map((book) => (
        <option key={book.id} value={book.id}>
          {book.name}
          {book.status === "closed" ? " (마감)" : ""}
        </option>
      ))}
    </select>
  );
}
