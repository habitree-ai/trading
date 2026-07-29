"use client";

import { useTransition } from "react";

import { closeBook, deleteBook, reopenBook, setOkxSync, switchBook } from "@/app/(app)/books/actions";
import type { Book } from "@/lib/domain";
import { num, pct, pnlClass, signedPct } from "@/lib/format";
import type { BookMetrics } from "@/lib/metrics";

export function BookRow({
  book,
  metrics,
  isActive,
}: {
  book: Book;
  metrics: BookMetrics;
  isActive: boolean;
}) {
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<void>) => startTransition(() => void fn());

  return (
    <article
      className={`rounded-xl border bg-surface p-4 ${
        isActive ? "border-accent" : "border-border"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{book.name}</h3>
        {isActive ? (
          <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-white">보는 중</span>
        ) : null}
        {book.status === "closed" ? (
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-dim">마감</span>
        ) : null}
        {book.okx_sync_enabled ? (
          <span className="rounded border border-accent/40 px-1.5 py-0.5 text-[10px] text-accent">
            OKX 동기화
          </span>
        ) : null}
        <span className="text-xs text-dim">
          {book.exchange ?? "거래소 미지정"} · {book.base_currency} · {book.start_date} 시작
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="초기자금" value={num(metrics.initialCapital, 0)} />
        <Stat label="현재자금" value={num(metrics.finalEquity, 0)} />
        <Stat
          label="수익율"
          value={signedPct(metrics.returnPct)}
          className={pnlClass(metrics.returnPct)}
        />
        <Stat label="승률" value={pct(metrics.winRate)} />
        <Stat label="거래" value={`${metrics.closedCount}건`} />
      </dl>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {!isActive ? (
          <Action onClick={() => run(() => switchBook(book.id))} disabled={pending}>
            이 북 보기
          </Action>
        ) : null}
        <Action
          onClick={() => run(() => setOkxSync(book.id, !book.okx_sync_enabled))}
          disabled={pending}
        >
          {book.okx_sync_enabled ? "OKX 동기화 끄기" : "OKX 동기화 켜기"}
        </Action>
        {book.status === "active" ? (
          <Action onClick={() => run(() => closeBook(book.id))} disabled={pending}>
            마감
          </Action>
        ) : (
          <Action onClick={() => run(() => reopenBook(book.id))} disabled={pending}>
            마감 해제
          </Action>
        )}
        <Action
          danger
          disabled={pending}
          onClick={() => {
            const ok = window.confirm(
              `'${book.name}' 북과 그 안의 거래 ${metrics.closedCount + metrics.openCount}건이 모두 삭제됩니다. 되돌릴 수 없습니다. 계속할까요?`,
            );
            if (ok) run(() => deleteBook(book.id));
          }}
        >
          삭제
        </Action>
      </div>
    </article>
  );
}

function Stat({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div>
      <dt className="text-[11px] text-dim">{label}</dt>
      <dd className={`tnum text-sm ${className}`}>{value}</dd>
    </div>
  );
}

function Action({
  children,
  onClick,
  disabled,
  danger = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-2.5 py-1 disabled:opacity-50 ${
        danger ? "border-loss/40 text-loss" : "border-border text-dim hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
