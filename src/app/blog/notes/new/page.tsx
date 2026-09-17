import { redirect } from "next/navigation";

import { NoteForm } from "@/app/blog/note-form";
import { getBlogViewer } from "@/lib/senior/admin";
import { listSeniorNotes } from "@/lib/senior/notes";
import { listSeniorPosts } from "@/lib/senior/posts";

/**
 * 새 노트 — 관리자만. 비로그인은 로그인으로, 관리자가 아닌 계정은 목록으로.
 *
 * `?post=<글 번호>` 는 정리 문서 표의 「＋노트」에서 온다. 대상 글을 채워 연다. 그 글에
 * 이미 노트가 있으면(옛 화면에서 다시 누른 경우) 새로 만들지 않고 그 노트로 보낸다.
 */
export default async function NewSeniorNotePage({
  searchParams,
}: {
  searchParams: Promise<{ post?: string }>;
}) {
  const { post } = await searchParams;
  const postId = post && /^\d+$/.test(post) ? post : null;
  const here = postId ? `/blog/notes/new?post=${postId}` : "/blog/notes/new";

  const viewer = await getBlogViewer();
  if (!viewer.admin) redirect(viewer.email ? "/blog" : `/login?next=${encodeURIComponent(here)}`);

  if (postId) {
    const existing = (await listSeniorNotes()).find((n) => n.post_id === postId);
    if (existing) redirect(`/blog/notes/${existing.id}`);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">새 노트</h1>
      <NoteForm posts={listSeniorPosts()} initialPostId={postId} />
    </div>
  );
}
