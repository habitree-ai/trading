import Link from "next/link";

import { SIDE_LABEL, type JournalNote, type Trade } from "@/lib/domain";
import { date, pnlClass, signed } from "@/lib/format";
import { isOpenTrade } from "@/lib/metrics";

export const NOTES_FILTERS = ["all", "no-basis", "no-review"] as const;
export type NotesFilter = (typeof NOTES_FILTERS)[number];

const FILTER_LABEL: Record<NotesFilter, string> = {
  all: "전체",
  "no-basis": "근거 없음",
  "no-review": "복기 없음",
};

/** 복기는 청산된 매매에만 요구한다 — 보유중에 복기가 비어 있는 것은 빠진 게 아니다. */
function matches(trade: Trade, filter: NotesFilter): boolean {
  if (filter === "no-basis") return !trade.rationale;
  if (filter === "no-review") return !isOpenTrade(trade) && !trade.review;
  return true;
}

function href(filter: NotesFilter, tradeId?: string): string {
  const q = new URLSearchParams();
  if (filter !== "all") q.set("filter", filter);
  if (tradeId) q.set("trade", tradeId);
  const s = q.toString();
  return s ? `/notes?${s}` : "/notes";
}

/**
 * 매매 목록 — 한 줄에 무엇을 샀고 결과가 어땠는지, 그리고 근거 첫 줄(트리거)과 기록이 얼마나
 * 채워졌는지. 빈 칸을 찾아 채우는 게 이 목록의 주된 쓰임이라 필터가 "없는 것"을 고른다.
 */
export function TradeList({
  trades,
  notesByTrade,
  selectedId,
  filter,
  generalCount,
  generalActive,
}: {
  trades: Trade[];
  notesByTrade: Record<string, JournalNote[]>;
  selectedId: string | null;
  filter: NotesFilter;
  /** 매매와 무관한 기록 수 — 목록 맨 위 항목으로 연다(REQ-0075) */
  generalCount: number;
  generalActive: boolean;
}) {
  const shown = trades.filter((t) => matches(t, filter));
  return (
    <div className="space-y-2">
      <nav className="flex flex-wrap gap-1.5" aria-label="필터">
        {NOTES_FILTERS.map((f) => (
          <Link
            key={f}
            href={href(f)}
            aria-current={f === filter ? "page" : undefined}
            className={`rounded-lg border px-2.5 py-1 text-xs ${
              f === filter ? "border-accent bg-accent/10 text-accent" : "border-border text-dim hover:text-text"
            }`}
          >
            {FILTER_LABEL[f]}
            <span className="tnum ml-1 opacity-70">{trades.filter((t) => matches(t, f)).length}</span>
          </Link>
        ))}
      </nav>

      <Link
        href={filter === "all" ? "/notes?view=general" : `/notes?filter=${filter}&view=general`}
        aria-current={generalActive ? "true" : undefined}
        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
          generalActive ? "border-accent bg-accent/5" : "border-border bg-surface hover:border-dim"
        }`}
      >
        <span aria-hidden>📝</span>
        <span className="font-medium">일반 기록</span>
        <span className="text-dim">매매와 무관한 관찰·감정</span>
        <span className="tnum ml-auto text-dim">{generalCount}</span>
      </Link>

      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-dim">
          해당하는 매매가 없습니다.
        </p>
      ) : (
        <ul className="max-h-[calc(100vh-14rem)] space-y-1 overflow-y-auto pr-1">
          {shown.map((t) => {
            const open = isOpenTrade(t);
            const pnl = t.realized_pnl ?? t.pnl;
            const trigger = t.rationale?.split("\n")[0]?.trim() ?? "";
            const noteCount = notesByTrade[t.id]?.length ?? 0;
            const active = t.id === selectedId;
            return (
              <li key={t.id}>
                <Link
                  href={href(filter, t.id)}
                  aria-current={active ? "true" : undefined}
                  className={`block rounded-lg border px-3 py-2 ${
                    active ? "border-accent bg-accent/5" : "border-border bg-surface hover:border-dim"
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span className="tnum text-dim">{date(t.entry_at)}</span>
                    <span className="font-medium">{t.symbol}</span>
                    <span className={t.side === "long" ? "text-profit" : "text-loss"}>{SIDE_LABEL[t.side]}</span>
                    <span className={`tnum ml-auto ${open ? "text-dim" : pnlClass(pnl)}`}>
                      {open ? "보유중" : signed(pnl)}
                    </span>
                  </div>
                  <p className={`mt-1 truncate text-xs ${trigger ? "" : "text-dim/70"}`}>
                    {trigger || "근거 없음"}
                  </p>
                  <div className="mt-1 flex gap-2 text-[11px] text-dim">
                    {open ? null : t.review ? (
                      <span className="text-profit">복기 ✓</span>
                    ) : (
                      <span className="text-beta">복기 없음</span>
                    )}
                    {noteCount > 0 ? <span>기록 {noteCount}</span> : null}
                    {t.image_paths.length > 0 ? <span>사진 {t.image_paths.length}</span> : null}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
