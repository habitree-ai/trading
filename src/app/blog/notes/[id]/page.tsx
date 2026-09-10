import Link from "next/link";
import { notFound } from "next/navigation";

import { NoteForm } from "@/app/blog/note-form";
import { date } from "@/lib/format";
import { getBlogViewer } from "@/lib/senior/admin";
import { listSeniorChartsForPost } from "@/lib/senior/charts";
import { SENIOR_NOTE_FIELDS, SENIOR_NOTE_STATUS_LABEL } from "@/lib/senior/fields";
import { getSeniorNote } from "@/lib/senior/notes";
import { findSeniorPost, listSeniorPosts } from "@/lib/senior/posts";
import { SENIOR_TRANSCRIPT_STATUS_LABEL, listSeniorTranscriptsForPost } from "@/lib/senior/transcripts";

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
  const transcripts = listSeniorTranscriptsForPost(note.post_id);
  const linked = note.links.map((lid) => ({ id: lid, post: findSeniorPost(lid) }));

  return (
    <article className="space-y-6">
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

      {/* 두 시선 — 왼쪽에 선배님의 글, 오른쪽에 내 생각. 좁은 화면에서는 위아래로 쌓인다. */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {SENIOR_NOTE_FIELDS.map((f) => {
          const body = note[f.key].trim();
          const senior = f.key === "quote";
          return (
            <section
              key={f.key}
              className={`rounded-xl border bg-surface p-4 ${senior ? "border-border" : "border-accent/40"}`}
            >
              <h2 className="text-[11px] font-semibold tracking-widest text-dim uppercase">{f.label}</h2>
              <p
                className={`mt-2 text-[14px] leading-relaxed whitespace-pre-line ${
                  body === "" ? "text-dim italic" : senior ? "text-dim" : ""
                }`}
              >
                {body === "" ? f.empty : body}
              </p>
            </section>
          );
        })}
      </div>

      {transcripts.map((t) => (
        <section key={t.name}>
          <h2 className="text-sm font-medium">이 글의 이미지와 판독 — {t.items.length}장</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-dim">
            이미지는 네이버 원본을 그 자리에서 띄운다(저장하지 않는다). 오른쪽은 손글씨를 읽은 판독이며 [?] 는
            확신 없는 낱말, [판독 불가] 는 못 읽은 곳. 고치는 곳은 <span className="tnum">선배님/전사/{t.name}.html</span>
            (페이지 안에서 고치고 HTML 저장).
          </p>
          <ol className="mt-2 space-y-3">
            {t.items.map((it) => (
              <li key={it.seq} className="rounded-xl border border-border bg-surface p-3">
                <div className="flex flex-wrap items-baseline gap-2 text-[11px] text-dim">
                  <span className="text-[13px] font-semibold text-text">
                    {it.seq} · {it.date}
                  </span>
                  <span className={`rounded px-1.5 py-0.5 ${it.missing ? "bg-loss/15 text-loss" : "bg-surface-2"}`}>
                    {it.missing ? "원본 없음" : SENIOR_TRANSCRIPT_STATUS_LABEL[it.status]}
                  </span>
                </div>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  {it.missing || !it.naverUrl ? (
                    <p className="rounded-lg border border-dashed border-border p-6 text-center text-[12px] leading-relaxed text-dim">
                      원본 이미지 없음 — 네이버 주소가 404.
                    </p>
                  ) : (
                    <a href={it.naverUrl} target="_blank" rel="noreferrer noopener" className="block">
                      {/* 네이버는 다른 사이트 Referer 를 403 으로 막고 Referer 가 없으면 준다 — 원본을 복사하지 않고 그 자리에서 띄운다. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={it.naverUrl}
                        alt={`${t.title} 이미지 ${it.seq} — ${it.date}`}
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        className="w-full rounded-lg border border-border"
                      />
                    </a>
                  )}
                  <div className="min-w-0">
                    <p className="text-[13px] leading-relaxed whitespace-pre-line">
                      {it.text.trim() !== "" ? it.text : "(판독 없음)"}
                    </p>
                    {it.caption ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[11px] text-dim">선배님 본문 — 이 이미지 바로 뒤 문단</summary>
                        <p className="mt-1 border-l-2 border-border pl-3 text-[12.5px] leading-relaxed whitespace-pre-line text-dim">
                          {it.caption}
                        </p>
                      </details>
                    ) : null}
                    {it.notes ? <p className="mt-2 text-[11px] leading-relaxed text-dim">판독 메모 · {it.notes}</p> : null}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}

      {charts.length > 0 ? (
        <section>
          <h2 className="text-sm font-medium">이 글의 시세 대조 차트</h2>
          <ul className="mt-1.5 space-y-1.5">
            {charts.map((c) => (
              <li key={c.name} className="rounded-xl border border-border bg-surface px-3 py-2 text-sm">
                <a
                  href={`/blog/charts/${encodeURIComponent(c.name)}.html`}
                  target="_blank"
                  rel="noopener"
                  className="block hover:text-accent"
                >
                  <span className="font-medium">{c.title}</span>
                  <span className="tnum ml-2 text-[11px] text-dim">{c.symbol}</span>
                </a>
                {c.hasOptions ? (
                  <a
                    href={`/blog/charts/${encodeURIComponent(c.name)}_옵션.html`}
                    target="_blank"
                    rel="noopener"
                    className="mt-1 inline-block text-[11.5px] text-dim hover:text-text"
                  >
                    옵션 자료 — VXN 차트 · 스트래들 % · 이론가 표 ↗
                  </a>
                ) : null}
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
