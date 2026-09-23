import Link from "next/link";

import { FreeRecordForm } from "@/app/(app)/trades/new/journal-form";
import { JournalList, type JournalEntry } from "@/app/(app)/trades/new/journal-list";
import type { TradeAnnotation } from "@/lib/domain";
import type { FieldSuggestions } from "@/lib/queries";

/**
 * 일반 기록 — 매매와 무관하게 적은 관찰·감정(journal_notes 중 trade_id 없는 것, REQ-0075).
 *
 * 폼과 목록은 기록 추가 화면의 것을 그대로 쓴다. 저장·삭제·차트 메모가 같은 경로라 두 화면
 * 어디서 적어도 양쪽에 같이 보인다.
 */
export function GeneralNotes({
  entries,
  annotations,
  bookId,
  userId,
  suggestions,
  symbols,
  now,
  backHref,
}: {
  entries: JournalEntry[];
  annotations: Record<string, TradeAnnotation[]>;
  bookId: string;
  userId: string;
  suggestions: FieldSuggestions;
  symbols: string[];
  now: number;
  /** 좁은 화면에서 목록으로 돌아가는 링크 */
  backHref: string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link href={backHref} className="text-xs text-dim hover:text-text lg:hidden">
          ← 목록
        </Link>
        <h2 className="text-base font-medium">
          일반 기록 <span className="text-sm font-normal text-dim">— 매매와 무관한 관찰·감정, 최신순</span>
        </h2>
      </div>
      <FreeRecordForm bookId={bookId} userId={userId} suggestions={suggestions} symbols={symbols} now={now} />
      <JournalList entries={entries} annotations={annotations} now={now} />
    </div>
  );
}
