import Link from "next/link";
import { notFound } from "next/navigation";

import { NoteForm } from "@/app/blog/note-form";
import { date } from "@/lib/format";
import { getBlogViewer } from "@/lib/senior/admin";
import { listSeniorChartsForPost } from "@/lib/senior/charts";
import { SENIOR_NOTE_FIELDS, SENIOR_NOTE_STATUS_LABEL } from "@/lib/senior/fields";
import { getSeniorNote } from "@/lib/senior/notes";
import { findSeniorPost, listSeniorPosts } from "@/lib/senior/posts";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string }>;
}

/** 노트 한 장 — 읽기. 관리자가 `?edit=1` 로 열면 같은 자리에 폼이 뜬다. */
export default async function SeniorNotePage({ params, searchParams }: Props) {
  const [{ id }, { edit }, viewer] = await Promise.all([params, searchParams, getBlogViewer()]);
  const note = await getSeniorNote(id);
  if (!note) notFound();

  if (edit === "1" && viewer.admin) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">노트 고치기</h1>
        <NoteForm note={note} posts={listSeniorPosts()} />
      </div>
    );
  }

  const post = findSeniorPost(note.post_id);
  const charts = listSeniorChartsForPost(post?.url);
  const linked = note.links.map((lid) => ({ id: lid, post: findSeniorPost(lid) }));
  const filled = SENIOR_NOTE_FIELDS.filter((f) => note[f.key].trim() !== "");

  return (
    <article className="mx-auto max-w-2xl space-y-6">
      <header className="rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-dim">
          <span className="font-semibold tracking-widest uppercase">대상 글</span>
          <span
            className={`ml-auto rounded px-1.5 py-0.5 ${
              note.status === "done" ? "bg-profit/15 text-profit" : "bg-surface-2"
            }`}
          >
            {SENIOR_NOTE_STATUS_LABEL[note.status]}
          </span>
        </div>
        <h1 className="mt-1 text-lg leading-snug font-semibold">
          {post?.title ?? (note.post_id ? `글 ${note.post_id}` : "(글을 고르지 않은 노트)")}
        </h1>
        {post ? (
          <p className="mt-1 flex flex-wrap gap-2 text-[11px] text-dim">
            <span className="rounded border border-border px-1.5">{post.board}</span>
            <span className="tnum">{post.date}</span>
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
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
          {viewer.admin ? (
            <Link
              href={`/blog/notes/${note.id}?edit=1`}
              className="rounded-lg border border-accent px-2.5 py-1 text-accent"
            >
              고치기
            </Link>
          ) : null}
        </div>
      </header>

      {filled.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-dim">
          아직 아무 칸도 채우지 않은 노트입니다.
        </p>
      ) : (
        filled.map((f) => (
          <section key={f.key}>
            <h2 className="text-sm font-medium">{f.label}</h2>
            <p
              className={`mt-1.5 text-[14px] leading-relaxed whitespace-pre-line ${
                f.key === "quote"
                  ? "rounded-r-lg border-l-2 border-accent bg-surface-2 px-4 py-3 text-dim"
                  : ""
              }`}
            >
              {note[f.key]}
            </p>
          </section>
        ))
      )}

      {charts.length > 0 ? (
        <section>
          <h2 className="text-sm font-medium">이 글의 시세 대조 차트</h2>
          <ul className="mt-1.5 space-y-1.5">
            {charts.map((c) => (
              <li key={c.name}>
                <a
                  href={`/blog/charts/${encodeURIComponent(c.name)}.html`}
                  target="_blank"
                  rel="noopener"
                  className="block rounded-xl border border-border bg-surface px-3 py-2 text-sm transition-colors hover:border-beta"
                >
                  <span className="font-medium">{c.title}</span>
                  <span className="tnum ml-2 text-[11px] text-dim">{c.symbol}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {linked.length > 0 ? (
        <section>
          <h2 className="text-sm font-medium">연결되는 글</h2>
          <ul className="mt-1.5 space-y-1">
            {linked.map(({ id: lid, post: p }) => (
              <li key={lid} className="flex items-center gap-2 text-sm">
                <span className="tnum text-[11px] text-dim">{p?.date ?? "-"}</span>
                <span className="min-w-0 flex-1 truncate">{p?.title ?? `글 ${lid}`}</span>
                {p ? (
                  <a href={p.url} target="_blank" rel="noreferrer" className="text-xs text-dim hover:text-text">
                    ↗
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-[11px] text-dim">
        {note.tags.map((t) => (
          <Link key={t} href={`/blog?tag=${encodeURIComponent(t)}`} className="hover:text-text">
            #{t}
          </Link>
        ))}
        <span className="tnum ml-auto">
          작성 {date(note.created_at)} · 수정 {date(note.updated_at)}
        </span>
      </footer>
    </article>
  );
}
