"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { deleteJournalNote } from "@/app/(app)/trades/new/journal-actions";
import { NoteChart, PositionChart } from "@/app/(app)/trades/new/journal-charts";
import {
  ANNOTATION_KIND_LABEL,
  RESULT_LABEL,
  SIDE_LABEL,
  type JournalNote,
  type Trade,
  type TradeAnnotation,
} from "@/lib/domain";
import { dateTime, pnlClass, signed } from "@/lib/format";
import { isOpenTrade } from "@/lib/metrics";

/**
 * 기록 한 건 — 포지션 기록은 거래 행 자체, 일반 기록은 journal_notes 행.
 *
 * `at` 은 목록을 세우는 시각이다. 포지션 기록은 마지막으로 고친 때(updated_at)라 동기화가
 * 평가손익을 고칠 때도 오른다 — 들고 있는 포지션이 위에 오는 셈이라 그대로 둔다.
 */
export type JournalEntry =
  | { kind: "position"; at: string; trade: Trade }
  | { kind: "free"; at: string; note: JournalNote };

const NO_ANNOTATIONS: TradeAnnotation[] = [];

const CHIP = "rounded border px-1.5 py-0.5 text-[11px]";

function entryId(entry: JournalEntry): string {
  return entry.kind === "position" ? entry.trade.id : entry.note.id;
}

/** 차트에 남긴 메모를 한 줄씩 — 도형은 종류만, 텍스트·라벨은 그 내용까지. */
function MemoChips({ annotations }: { annotations: TradeAnnotation[] }) {
  if (annotations.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-1" aria-label="차트 메모">
      {annotations.map((a) => (
        <li key={a.id} className={`${CHIP} border-border text-dim`}>
          {ANNOTATION_KIND_LABEL[a.kind]}
          {a.text ? <span className="text-text"> · {a.text}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * 최근 기록 — 두 종류를 합쳐 최신순으로.
 *
 * 각 행이 "무엇에 대한 기록인지"(포지션 배지 / 일반·종목)와 적은 내용, 그리고 차트에 남긴
 * 메모를 함께 보여 준다. 「차트」로 그 차트를 다시 연다 — 한 번에 하나만(OKX 요청이 겹치지 않게).
 */
export function JournalList({
  entries,
  annotations,
  now,
}: {
  entries: JournalEntry[];
  /** 소유자(거래 id · 기록 id)별 차트 메모 */
  annotations: Record<string, TradeAnnotation[]>;
  now: number;
}) {
  const [openChart, setOpenChart] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (entries.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-dim">
        아직 기록이 없습니다. 위에서 첫 기록을 남겨 주세요.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {error ? <p className="text-xs text-loss">{error}</p> : null}
      <ul className="space-y-2">
        {entries.map((entry) => {
          const id = entryId(entry);
          const memos = annotations[id] ?? NO_ANNOTATIONS;
          const chartOpen = openChart === id;
          const chartable = entry.kind === "position" || entry.note.symbol !== null;
          const emotion = entry.kind === "position" ? entry.trade.emotion : entry.note.emotion;

          return (
            <li key={id} className="rounded-xl border border-border bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="tnum text-dim">{dateTime(entry.at)}</span>
                {entry.kind === "position" ? (
                  <Link
                    href={`/trades/new?trade=${entry.trade.id}`}
                    title="이 포지션에 이어서 기록하기"
                    className={`${CHIP} border-accent/40 text-accent`}
                  >
                    포지션 #{entry.trade.seq} · {entry.trade.symbol}{" "}
                    <span className={entry.trade.side === "long" ? "text-profit" : "text-loss"}>
                      {SIDE_LABEL[entry.trade.side]}
                    </span>
                    {" · "}
                    {isOpenTrade(entry.trade) ? (
                      <>
                        보유중{" "}
                        <span className={`tnum ${pnlClass(entry.trade.unrealized_pnl)}`}>
                          {signed(entry.trade.unrealized_pnl)}
                        </span>
                      </>
                    ) : (
                      <>
                        {RESULT_LABEL[entry.trade.result]}{" "}
                        <span className={`tnum ${pnlClass(entry.trade.realized_pnl ?? entry.trade.pnl)}`}>
                          {signed(entry.trade.realized_pnl ?? entry.trade.pnl)}
                        </span>
                      </>
                    )}
                  </Link>
                ) : (
                  <span className={`${CHIP} border-border text-dim`}>
                    일반{entry.note.symbol ? ` · ${entry.note.symbol}` : ""}
                  </span>
                )}
                {emotion ? <span className={`${CHIP} border-beta/40 text-beta`}>감정 · {emotion}</span> : null}

                <span className="ml-auto flex items-center gap-2">
                  {chartable ? (
                    <button
                      type="button"
                      aria-expanded={chartOpen}
                      onClick={() => setOpenChart((cur) => (cur === id ? null : id))}
                      className={`rounded-md border px-2 py-1 ${
                        chartOpen ? "border-accent bg-accent text-white" : "border-border text-accent hover:border-accent"
                      }`}
                    >
                      {chartOpen ? "차트 닫기" : "차트"}
                    </button>
                  ) : null}
                  {entry.kind === "free" ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        const ok = window.confirm("이 기록을 삭제할까요? 차트 메모도 함께 지워집니다.");
                        if (!ok) return;
                        startTransition(async () => {
                          const result = await deleteJournalNote(entry.note.id);
                          setError(result.error ?? null);
                          if (!result.error && openChart === id) setOpenChart(null);
                        });
                      }}
                      className="text-[11px] text-loss/70 hover:text-loss disabled:opacity-50"
                    >
                      삭제
                    </button>
                  ) : null}
                </span>
              </div>

              <div className="mt-2 space-y-1 text-sm whitespace-pre-wrap">
                {entry.kind === "position" ? (
                  <>
                    {entry.trade.rationale ? (
                      <p>
                        <span className="mr-1 text-xs text-dim">근거</span>
                        {entry.trade.rationale}
                      </p>
                    ) : null}
                    {entry.trade.review ? (
                      <p>
                        <span className="mr-1 text-xs text-dim">복기</span>
                        {entry.trade.review}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p>{entry.note.body}</p>
                )}
              </div>

              <MemoChips annotations={memos} />

              {chartOpen ? (
                <div className="mt-3">
                  {entry.kind === "position" ? (
                    <PositionChart trade={entry.trade} now={now} />
                  ) : entry.note.symbol ? (
                    <NoteChart noteId={entry.note.id} symbol={entry.note.symbol} now={now} />
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
