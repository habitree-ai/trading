import Link from "next/link";

import { getBlogViewer } from "@/lib/senior/admin";
import { listSeniorCharts } from "@/lib/senior/charts";
import { SENIOR_DOCS } from "@/lib/senior/docs";
import { SENIOR_NOTE_STATUS_LABEL } from "@/lib/senior/fields";
import { listSeniorNotes, type SeniorNote, type SeniorNoteStatus } from "@/lib/senior/notes";
import { listSeniorPosts, type SeniorPost } from "@/lib/senior/posts";

interface Filter {
  q: string;
  status: SeniorNoteStatus | "";
  tag: string;
}

/** 필터를 URL 로 — 새로고침해도, 링크를 건네도 같은 목록이 보인다. */
function href(next: Partial<Filter>, base: Filter): string {
  const f = { ...base, ...next };
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.status) params.set("status", f.status);
  if (f.tag) params.set("tag", f.tag);
  const qs = params.toString();
  return qs ? `/blog?${qs}` : "/blog";
}

function matches(note: SeniorNote, post: SeniorPost | undefined, filter: Filter): boolean {
  if (filter.status && note.status !== filter.status) return false;
  if (filter.tag && !note.tags.includes(filter.tag)) return false;
  const needle = filter.q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [
    post ? `${post.title} ${post.board} ${post.date}` : "",
    note.quote,
    note.think,
    note.apply,
    note.differ,
    note.ask,
    note.tags.join(" "),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(needle);
}

function snippet(note: SeniorNote): string {
  return (note.think || note.quote).replace(/\s+/g, " ").trim().slice(0, 90);
}

export default async function BlogHome({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; tag?: string }>;
}) {
  const raw = await searchParams;
  const filter: Filter = {
    q: raw.q ?? "",
    status: raw.status === "draft" || raw.status === "done" ? raw.status : "",
    tag: raw.tag ?? "",
  };

  const [notes, viewer] = await Promise.all([listSeniorNotes(), getBlogViewer()]);
  const posts = listSeniorPosts();
  const charts = listSeniorCharts();
  const byId = new Map(posts.map((p) => [p.id, p]));

  const visible = notes.filter((n) => matches(n, n.post_id ? byId.get(n.post_id) : undefined, filter));
  const tags = [...new Set(notes.flatMap((n) => n.tags))].sort((a, b) => a.localeCompare(b, "ko"));
  const done = notes.filter((n) => n.status === "done").length;
  const covered = new Set(notes.map((n) => n.post_id).filter(Boolean)).size;
  const filtering = filter.q !== "" || filter.status !== "" || filter.tag !== "";

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">정리 문서</h1>
          <p className="mt-1 text-sm text-dim">
            네이버 블로그 pillion21(알바트로스) 760편, 2006~2026. 전량을 읽고 정리한 것이다.
            본문은 원저자의 것이라 여기 없다 — 각 글은 네이버 원문으로 잇는다.
          </p>
        </header>
        <div className="grid gap-2 sm:grid-cols-3">
          {SENIOR_DOCS.map((doc) => (
            <Link
              key={doc.slug}
              href={`/blog/docs/${doc.slug}`}
              className="rounded-xl border border-border bg-surface p-4 transition-colors hover:border-beta"
            >
              <h2 className="text-[13px] font-medium">{doc.title}</h2>
              <p className="mt-1 text-[11.5px] leading-snug text-dim">{doc.desc}</p>
            </Link>
          ))}
        </div>
      </section>

      {charts.length > 0 ? (
        <section className="space-y-3">
          <header>
            <h2 className="text-xl font-semibold tracking-tight">시세 대조 차트</h2>
            <p className="mt-1 text-sm text-dim">
              글이 말하는 매매를 그때 시세로 되짚은 것. 봉 데이터를 내장한 인터랙티브 차트 —
              일봉·1시간봉, 이벤트 마커, 봉 데이터 표와 CSV. 새 탭에서 열린다.
            </p>
          </header>
          <div className="grid gap-2 sm:grid-cols-2">
            {charts.map((c) => (
              <div key={c.name} className="rounded-xl border border-border bg-surface p-4">
                <a
                  href={`/blog/charts/${encodeURIComponent(c.name)}.html`}
                  target="_blank"
                  rel="noopener"
                  className="block hover:text-accent"
                >
                  <h3 className="text-[13px] font-medium">{c.title}</h3>
                  <p className="tnum mt-1 text-[11.5px] leading-snug text-dim">
                    {c.symbol} · 「{c.post.title}」 {c.post.date} · {c.post.board}
                  </p>
                </a>
                {c.hasOptions ? (
                  <a
                    href={`/blog/charts/${encodeURIComponent(c.name)}_옵션.html`}
                    target="_blank"
                    rel="noopener"
                    className="mt-2 inline-block rounded-lg border border-border px-2 py-0.5 text-[11.5px] text-dim hover:border-beta hover:text-text"
                  >
                    옵션 자료 — VXN 차트 · 스트래들 % · 이론가 표 ↗
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-3">
        <header className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">내 생각</h2>
            <p className="mt-1 text-sm text-dim">
              원문을 읽는 곳이 아니라 원문에 내 답을 다는 곳. 다섯 칸 — 인용 / 내 생각 / 나에게
              적용하면 / 다른 점 / 남는 질문.
            </p>
          </div>
          <p className="tnum text-[11px] text-dim">
            노트 {notes.length} · 다룬 글 {covered} · 정리됨 {done} · 전체 글 {posts.length}
          </p>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <form action="/blog" className="flex items-center gap-1.5">
            {filter.status ? <input type="hidden" name="status" value={filter.status} /> : null}
            {filter.tag ? <input type="hidden" name="tag" value={filter.tag} /> : null}
            <input
              name="q"
              type="search"
              defaultValue={filter.q}
              placeholder="노트 검색 — 제목·본문·태그"
              className="w-56 rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent"
            />
            <button
              type="submit"
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-dim hover:text-text"
            >
              검색
            </button>
          </form>
          <nav aria-label="상태" className="flex gap-1 rounded-xl bg-surface-2 p-1">
            {(["", "draft", "done"] as const).map((s) => (
              <Link
                key={s || "all"}
                href={href({ status: s }, filter)}
                aria-current={filter.status === s ? "page" : undefined}
                className={`rounded-lg px-2.5 py-1 text-xs ${
                  filter.status === s ? "bg-surface font-medium text-text shadow-sm" : "text-dim hover:text-text"
                }`}
              >
                {s ? SENIOR_NOTE_STATUS_LABEL[s] : "전체"}
              </Link>
            ))}
          </nav>
          {filtering ? (
            <Link href="/blog" className="text-xs text-dim hover:text-text">
              필터 지우기
            </Link>
          ) : null}
        </div>

        {tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <Link
                key={t}
                href={href({ tag: filter.tag === t ? "" : t }, filter)}
                className={`rounded px-1.5 py-0.5 text-[11px] ${
                  filter.tag === t ? "bg-accent/15 text-accent" : "bg-surface-2 text-dim hover:text-text"
                }`}
              >
                #{t}
              </Link>
            ))}
          </div>
        ) : null}

        {visible.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
            {notes.length === 0
              ? viewer.admin
                ? "아직 노트가 없습니다. 위의 ＋ 새 노트로 시작하세요."
                : "아직 노트가 없습니다."
              : "조건에 맞는 노트가 없습니다."}
          </p>
        ) : (
          <ul className="grid gap-2 md:grid-cols-2">
            {visible.map((note) => {
              const post = note.post_id ? byId.get(note.post_id) : undefined;
              const text = snippet(note);
              return (
                <li key={note.id}>
                  <Link
                    href={`/blog/notes/${note.id}`}
                    className="block h-full rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-dim">
                      {post ? (
                        <>
                          <span className="tnum">{post.date}</span>
                          <span className="rounded border border-border px-1.5">{post.board}</span>
                        </>
                      ) : (
                        <span>{note.post_id ? `글 ${note.post_id}` : "글 미지정"}</span>
                      )}
                      <span
                        className={`ml-auto rounded px-1.5 py-0.5 ${
                          note.status === "done" ? "bg-profit/15 text-profit" : "bg-surface-2"
                        }`}
                      >
                        {SENIOR_NOTE_STATUS_LABEL[note.status]}
                      </span>
                    </div>
                    <h3 className="mt-1.5 text-[13.5px] leading-snug font-medium">
                      {post?.title ?? "(글을 고르지 않은 노트)"}
                    </h3>
                    {text ? <p className="mt-1 text-xs leading-relaxed text-dim">{text}</p> : null}
                    {note.tags.length > 0 ? (
                      <p className="mt-2 flex flex-wrap gap-1 text-[11px] text-dim">
                        {note.tags.map((t) => (
                          <span key={t}>#{t}</span>
                        ))}
                      </p>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
