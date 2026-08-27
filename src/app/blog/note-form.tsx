"use client";

import Link from "next/link";
import { useActionState, useMemo, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";

import {
  createSeniorNote,
  deleteSeniorNote,
  updateSeniorNote,
  type SeniorNoteFormState,
} from "@/app/blog/actions";
import { PostPicker } from "@/app/blog/post-picker";
import { SENIOR_NOTE_FIELDS } from "@/lib/senior/fields";
import type { SeniorNote } from "@/lib/senior/notes";
import type { SeniorPost } from "@/lib/senior/posts";

const INPUT =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent";
const LABEL = "block text-sm font-medium";
const HINT = "mt-0.5 mb-1.5 text-[11.5px] leading-snug text-dim";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? "저장하는 중…" : "저장"}
    </button>
  );
}

/**
 * 노트 폼 — 새로 쓰기와 고치기가 같은 폼이다. `note` 가 있으면 고치기.
 *
 * 대상 글과 연결되는 글은 상태로 들고 hidden 으로 보낸다 — 글 번호를 손으로 치는 칸은
 * 없다. 760편에서 찾아 고르는 것뿐이다.
 */
export function NoteForm({ note, posts }: { note?: SeniorNote; posts: SeniorPost[] }) {
  const [state, action] = useActionState<SeniorNoteFormState, FormData>(
    note ? updateSeniorNote : createSeniorNote,
    {},
  );
  const [postId, setPostId] = useState<string | null>(note?.post_id ?? null);
  const [links, setLinks] = useState<string[]>(note?.links ?? []);
  const [pending, startTransition] = useTransition();

  const byId = useMemo(() => new Map(posts.map((p) => [p.id, p])), [posts]);
  const post = postId ? byId.get(postId) : undefined;

  return (
    <form action={action} className="space-y-6">
      {note ? <input type="hidden" name="note_id" value={note.id} /> : null}
      <input type="hidden" name="post_id" value={postId ?? ""} />
      {links.map((id) => (
        <input key={id} type="hidden" name="links" value={id} />
      ))}

      <section className="rounded-xl border border-border bg-surface p-4">
        <p className="text-[10px] font-semibold tracking-widest text-dim uppercase">대상 글</p>
        {postId ? (
          <div className="mt-1">
            <h2 className="text-base leading-snug font-semibold">
              {post?.title ?? `글 ${postId}`}
            </h2>
            {post ? (
              <p className="mt-1 flex flex-wrap gap-2 text-[11px] text-dim">
                <span className="rounded border border-border px-1.5">{post.board}</span>
                <span className="tnum">{post.date}</span>
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {post ? (
                <a
                  href={post.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-border px-2.5 py-1 text-dim hover:text-text"
                >
                  네이버 원문 ↗
                </a>
              ) : null}
              <button
                type="button"
                onClick={() => setPostId(null)}
                className="rounded-lg border border-border px-2.5 py-1 text-dim hover:text-text"
              >
                글 바꾸기
              </button>
            </div>
          </div>
        ) : posts.length > 0 ? (
          <div className="mt-2">
            <PostPicker
              posts={posts}
              exclude={links}
              onPick={setPostId}
              placeholder="760편에서 글 찾기 — 제목·게시판·날짜"
            />
          </div>
        ) : (
          <p className="mt-2 text-xs text-dim">
            글 색인이 없어 글을 고를 수 없습니다. 글 없이도 노트는 저장됩니다.
          </p>
        )}
      </section>

      {SENIOR_NOTE_FIELDS.map((f) => (
        <div key={f.key}>
          <label htmlFor={`f_${f.key}`} className={LABEL}>
            {f.label}
          </label>
          <p className={HINT}>{f.hint}</p>
          <textarea
            id={`f_${f.key}`}
            name={f.key}
            rows={f.rows}
            defaultValue={note?.[f.key] ?? ""}
            placeholder={f.placeholder}
            className={`${INPUT} ${f.key === "quote" ? "border-l-2 border-l-accent" : ""}`}
          />
        </div>
      ))}

      <div>
        <p className={LABEL}>연결되는 글</p>
        <p className={HINT}>
          같은 이야기가 나오는 다른 글을 걸어 둡니다. 20년치 안에서 반복되는 지점을 찾는
          장치입니다.
        </p>
        {links.length > 0 ? (
          <ul className="mb-2 space-y-1">
            {links.map((id) => {
              const p = byId.get(id);
              return (
                <li
                  key={id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm"
                >
                  <span className="tnum text-[11px] text-dim">{p?.date ?? "-"}</span>
                  <span className="min-w-0 flex-1 truncate">{p?.title ?? `글 ${id}`}</span>
                  <button
                    type="button"
                    onClick={() => setLinks(links.filter((x) => x !== id))}
                    aria-label="연결 빼기"
                    className="text-dim hover:text-loss"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {posts.length > 0 ? (
          <PostPicker
            posts={posts}
            exclude={[...links, ...(postId ? [postId] : [])]}
            onPick={(id) => setLinks([...links, id])}
            placeholder="글 검색해서 추가"
          />
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
        <div>
          <label htmlFor="f_tags" className={LABEL}>
            태그
          </label>
          <p className={HINT}>쉼표로 구분. 나중에 주제별로 모아 볼 때 씁니다.</p>
          <input
            id="f_tags"
            name="tags"
            defaultValue={note?.tags.join(", ") ?? ""}
            placeholder="레버리지, 손절, 심리"
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="f_status" className={LABEL}>
            상태
          </label>
          <p className={HINT}>다른 점 칸까지 채웠으면 정리됨.</p>
          <select id="f_status" name="status" defaultValue={note?.status ?? "draft"} className={INPUT}>
            <option value="draft">초안</option>
            <option value="done">정리됨</option>
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Submit />
        <Link
          href={note ? `/blog/notes/${note.id}` : "/blog"}
          className="rounded-lg border border-border px-3 py-2 text-sm text-dim hover:text-text"
        >
          취소
        </Link>
        {note ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (window.confirm("이 노트를 지웁니다. 되돌릴 수 없습니다.")) {
                startTransition(() => void deleteSeniorNote(note.id));
              }
            }}
            className="ml-auto rounded-lg border border-loss/40 px-3 py-2 text-sm text-loss disabled:opacity-40"
          >
            삭제
          </button>
        ) : null}
        {state.error ? <p className="w-full text-sm text-loss">{state.error}</p> : null}
      </div>
    </form>
  );
}
