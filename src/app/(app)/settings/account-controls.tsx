"use client";

import { useTransition } from "react";

import { deleteOkxAccount, linkBook } from "@/app/(app)/settings/actions";
import type { Book } from "@/lib/domain";

/** 거래소 계정이 들어올 북을 고른다. 안 고르면(빈 값) 어느 북에도 들어오지 않는다. */
export function BookLinkSelect({
  books,
  linkedBookId,
}: {
  books: Book[];
  linkedBookId: string | null;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <select
      aria-label="동기화 받을 북"
      value={linkedBookId ?? ""}
      disabled={pending || books.length === 0}
      onChange={(e) => {
        const id = e.target.value;
        startTransition(() => void linkBook(id === "" ? null : id));
      }}
      className="rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
    >
      <option value="">연결 안 함</option>
      {books.map((book) => (
        <option key={book.id} value={book.id}>
          {book.name}
          {book.status === "closed" ? " (마감)" : ""}
        </option>
      ))}
    </select>
  );
}

export function DeleteAccountButton({ label }: { label: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        const ok = window.confirm(
          `'${label}' 계정의 API 키를 삭제합니다. 연결된 북의 동기화가 멈춥니다. 계속할까요?`,
        );
        if (ok) startTransition(() => void deleteOkxAccount());
      }}
      className="rounded-lg border border-loss/40 px-2.5 py-1 text-xs text-loss disabled:opacity-50"
    >
      키 삭제
    </button>
  );
}
