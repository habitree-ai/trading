"use client";

import { useActionState, useState } from "react";

import { seedPrincipleFromFinding, type SeedState } from "@/app/(app)/diagnosis/actions";
import { PRINCIPLE_CATEGORIES, PRINCIPLE_CATEGORY_LABEL } from "@/lib/domain";

const INPUT =
  "w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent";

/**
 * 발견을 원칙으로 옮기는 자리.
 *
 * 한 번 누르면 바로 들어가게 하지 않는다 — 앱이 지어 준 문장으로 된 규칙은 지켜지지
 * 않는다. 근거 수치는 앱이 채우고 문구는 본인이 고쳐 쓴다.
 */
export function SeedButton({
  findingId,
  bookId,
  bookName,
  draft,
  seeded,
}: {
  findingId: string;
  bookId: string | null;
  bookName: string | null;
  draft: { category: string; title: string; detail: string };
  /** 이미 옮겼으면 그 성적 — 판단 건수와 어겼을 때 손익 */
  seeded: { judged: number; broken: number; brokenPnl: number | null } | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<SeedState, FormData>(
    seedPrincipleFromFinding,
    {},
  );

  if (seeded) {
    return (
      <p className="mt-3 border-t border-border pt-2.5 text-[11px] text-dim">
        원칙에 있음 ·{" "}
        {seeded.judged === 0
          ? "아직 판단한 거래가 없습니다 — 거래를 열면 체크리스트에 뜹니다"
          : `판단 ${seeded.judged}건 · 어김 ${seeded.broken}건${
              seeded.brokenPnl === null ? "" : ` (${seeded.brokenPnl > 0 ? "+" : ""}${Math.round(seeded.brokenPnl)})`
            }`}
      </p>
    );
  }

  if (!bookId) {
    return (
      <p className="mt-3 border-t border-border pt-2.5 text-[11px] text-dim">
        북을 먼저 만들어야 원칙으로 옮길 수 있습니다.
      </p>
    );
  }

  if (state.message) {
    return (
      <p className="mt-3 border-t border-border pt-2.5 text-[11px] text-profit">{state.message}</p>
    );
  }

  return (
    <div className="mt-3 border-t border-border pt-2.5">
      {open ? (
        <form action={action} className="space-y-2">
          <input type="hidden" name="finding_id" value={findingId} />
          <input type="hidden" name="book_id" value={bookId} />
          <div className="flex gap-2">
            <select name="category" defaultValue={draft.category} className={`${INPUT} w-28`}>
              {PRINCIPLE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {PRINCIPLE_CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
            <input
              name="title"
              defaultValue={draft.title}
              className={INPUT}
              placeholder="지킬 규칙을 한 문장으로"
            />
          </div>
          <textarea name="detail" defaultValue={draft.detail} rows={2} className={INPUT} />
          {state.error ? <p className="text-[11px] text-loss">{state.error}</p> : null}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
            >
              {pending ? "추가 중…" : "원칙 추가"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg border border-border px-3 py-1 text-xs text-dim"
            >
              취소
            </button>
            <span className="text-[11px] text-dim">
              {bookName ? `'${bookName}' 북에 들어갑니다` : ""}
            </span>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-border px-2.5 py-1 text-xs text-dim hover:text-text"
        >
          원칙으로 옮기기
        </button>
      )}
    </div>
  );
}
