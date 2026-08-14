"use client";

import { useState, useTransition } from "react";

import { deleteResearchNote, updateResearchNote } from "@/app/(app)/research/actions";
import {
  RESEARCH_NOTE_CATEGORIES,
  RESEARCH_NOTE_CATEGORY_LABEL,
  type ResearchNote,
} from "@/lib/domain";
import { dateTime } from "@/lib/format";

const INPUT =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent";

export function NoteRow({ note }: { note: ResearchNote }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // 저장에 성공하면 폼을 닫는다 — 결과를 보고 닫아야 하므로 액션 안에서 처리한다.
  async function save(formData: FormData) {
    const result = await updateResearchNote({}, formData);
    if (result.error) setError(result.error);
    else {
      setError(null);
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <form action={save} className="rounded-lg border border-accent bg-surface p-3">
        <input type="hidden" name="note_id" value={note.id} />
        <div className="grid gap-2 sm:grid-cols-[9rem_1fr_6rem]">
          <select name="category" className={INPUT} defaultValue={note.category}>
            {RESEARCH_NOTE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {RESEARCH_NOTE_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <input name="title" className={INPUT} defaultValue={note.title} required />
          <select name="importance" className={INPUT} defaultValue={String(note.importance)}>
            <option value="3">핵심</option>
            <option value="2">보통</option>
            <option value="1">참고</option>
          </select>
        </div>
        <textarea
          name="body"
          rows={3}
          className={`${INPUT} mt-2`}
          defaultValue={note.body ?? ""}
          placeholder="내용"
        />
        <input
          name="source_url"
          className={`${INPUT} mt-2`}
          defaultValue={note.source_url ?? ""}
          placeholder="https:// 로 시작하는 원문 주소"
        />
        <div className="mt-2 flex items-center gap-2 text-xs">
          <button
            type="submit"
            className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white"
          >
            저장
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setEditing(false);
            }}
            className="rounded-lg border border-border px-3 py-1.5 text-dim hover:text-text"
          >
            취소
          </button>
          {error ? <span className="text-loss">{error}</span> : null}
        </div>
      </form>
    );
  }

  return (
    <article className="rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-start gap-2">
        <p className="text-sm font-medium">{note.title}</p>
        {note.importance === 3 ? (
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-accent">핵심</span>
        ) : note.importance === 1 ? (
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-dim">참고</span>
        ) : null}
      </div>

      {note.body ? (
        <p className="mt-1 text-xs whitespace-pre-line text-dim">{note.body}</p>
      ) : null}

      <p className="tnum mt-2 text-[11px] text-dim">
        {dateTime(note.created_at)}
        {note.source_url ? (
          <>
            {" · "}
            <a
              href={note.source_url}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              출처
            </a>
          </>
        ) : null}
      </p>

      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        <button
          type="button"
          onClick={() => setEditing(true)}
          disabled={pending}
          className="rounded-lg border border-border px-2.5 py-1 text-dim hover:text-text disabled:opacity-40"
        >
          수정
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (window.confirm("이 노트를 삭제합니다. 계속할까요?")) {
              startTransition(() => void deleteResearchNote(note.id));
            }
          }}
          className="rounded-lg border border-loss/40 px-2.5 py-1 text-loss disabled:opacity-40"
        >
          삭제
        </button>
      </div>
    </article>
  );
}
