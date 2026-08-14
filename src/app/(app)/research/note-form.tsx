"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

import { createResearchNote, type ResearchFormState } from "@/app/(app)/research/actions";
import { RESEARCH_NOTE_CATEGORIES, RESEARCH_NOTE_CATEGORY_LABEL } from "@/lib/domain";

const INPUT =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent";
const LABEL = "block text-xs text-dim mb-1";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? "추가하는 중…" : "노트 추가"}
    </button>
  );
}

export function NoteForm({ symbol }: { symbol: string }) {
  const [state, action] = useActionState<ResearchFormState, FormData>(createResearchNote, {});
  const form = useRef<HTMLFormElement>(null);

  // 추가에 성공하면 칸을 비운다 — 자료는 한 번에 여러 건을 이어 적게 된다.
  useEffect(() => {
    if (state.message) form.current?.reset();
  }, [state.message]);

  return (
    <form ref={form} action={action} className="mt-3 space-y-3">
      <input type="hidden" name="symbol" value={symbol} />

      <div className="grid gap-3 sm:grid-cols-[9rem_1fr_6rem]">
        <div>
          <label className={LABEL} htmlFor="note-category">
            묶음
          </label>
          <select id="note-category" name="category" className={INPUT} defaultValue="fundamental">
            {RESEARCH_NOTE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {RESEARCH_NOTE_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL} htmlFor="note-title">
            제목 *
          </label>
          <input
            id="note-title"
            name="title"
            className={INPUT}
            placeholder="예) 현물 ETF 순유입 3주 연속 — 수급의 축"
            required
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="note-importance">
            중요도
          </label>
          <select id="note-importance" name="importance" className={INPUT} defaultValue="2">
            <option value="3">핵심</option>
            <option value="2">보통</option>
            <option value="1">참고</option>
          </select>
        </div>
      </div>

      <div>
        <label className={LABEL} htmlFor="note-body">
          내용
        </label>
        <textarea
          id="note-body"
          name="body"
          rows={3}
          className={INPUT}
          placeholder="상황과 맥락 — 이 자료가 매매에 왜 중요한지까지 적어 두면 나중에 다시 읽힙니다."
        />
      </div>

      <div>
        <label className={LABEL} htmlFor="note-source">
          출처 링크
        </label>
        <input
          id="note-source"
          name="source_url"
          className={INPUT}
          placeholder="https:// 로 시작하는 원문 주소"
        />
      </div>

      <div className="flex items-center gap-3">
        <Submit />
        {state.error ? <span className="text-sm text-loss">{state.error}</span> : null}
        {state.message ? <span className="text-sm text-dim">{state.message}</span> : null}
      </div>
    </form>
  );
}
