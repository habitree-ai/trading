"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { BasisLine, EventChip } from "@/app/(app)/trades/new/basis-line";
import { deleteJournalNote } from "@/app/(app)/trades/new/journal-actions";
import { NoteChart, PositionChart } from "@/app/(app)/trades/new/journal-charts";
import {
  ANNOTATION_KIND_LABEL,
  RESULT_LABEL,
  SIDE_LABEL,
  type JournalEvent,
  type JournalNote,
  type Trade,
  type TradeAnnotation,
} from "@/lib/domain";
import { dateTime, pnlClass, signed } from "@/lib/format";
import { isOpenTrade } from "@/lib/metrics";

/**
 * 기록 한 건 — 포지션 기록은 거래 행 자체, 포지션 추가 기록과 일반 기록은 journal_notes 행.
 *
 * `at` 은 목록을 세우는 시각이다. 포지션 기록은 마지막으로 고친 때(updated_at)라 동기화가
 * 평가손익을 고칠 때도 오른다 — 들고 있는 포지션이 위에 오는 셈이라 그대로 둔다.
 * 추가 기록은 거래를 같이 든다 — 배지와 차트가 그 거래의 것이다.
 */
export type JournalEntry =
  | { kind: "position"; at: string; trade: Trade }
  | { kind: "position-note"; at: string; note: JournalNote; trade: Trade; event: JournalEvent }
  | { kind: "free"; at: string; note: JournalNote };

const NO_ANNOTATIONS: TradeAnnotation[] = [];

const CHIP = "rounded border px-1.5 py-0.5 text-[11px]";

function entryId(entry: JournalEntry): string {
  return entry.kind === "position" ? entry.trade.id : entry.note.id;
}

/** 포지션 배지 — 거래 행 기록과 추가 기록이 같은 모양으로 그 거래를 가리킨다. */
function PositionBadge({ trade }: { trade: Trade }) {
  return (
    <Link
      href={`/trades/new?trade=${trade.id}`}
      title="이 포지션에 이어서 기록하기"
      className={`${CHIP} border-accent/40 text-accent`}
    >
      포지션 #{trade.seq} · {trade.symbol}{" "}
      <span className={trade.side === "long" ? "text-profit" : "text-loss"}>{SIDE_LABEL[trade.side]}</span>
      {" · "}
      {isOpenTrade(trade) ? (
        <>
          보유중{" "}
          <span className={`tnum ${pnlClass(trade.unrealized_pnl)}`}>{signed(trade.unrealized_pnl)}</span>
        </>
      ) : (
        <>
          {RESULT_LABEL[trade.result]}{" "}
          <span className={`tnum ${pnlClass(trade.realized_pnl ?? trade.pnl)}`}>
            {signed(trade.realized_pnl ?? trade.pnl)}
          </span>
        </>
      )}
    </Link>
  );
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
          const chartable = entry.kind !== "free" || entry.note.symbol !== null;
          const emotion = entry.kind === "position" ? entry.trade.emotion : entry.note.emotion;

          return (
            <li key={id} className="rounded-xl border border-border bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="tnum text-dim">{dateTime(entry.at)}</span>
                {entry.kind === "position" ? (
                  <PositionBadge trade={entry.trade} />
                ) : entry.kind === "position-note" ? (
                  <>
                    <PositionBadge trade={entry.trade} />
                    <EventChip event={entry.event} />
                    <BasisLine event={entry.event} basis={entry.note.basis} />
                  </>
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
                  {entry.kind !== "position" ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        const ok = window.confirm(
                          entry.kind === "free"
                            ? "이 기록을 삭제할까요? 차트 메모도 함께 지워집니다."
                            : "이 추가 기록을 삭제할까요? 진입 기록과 차트 메모는 남습니다.",
                        );
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
                  {entry.kind !== "free" ? (
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
