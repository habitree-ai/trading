import { redirect } from "next/navigation";

import { NoteForm } from "@/app/blog/note-form";
import { getBlogViewer } from "@/lib/senior/admin";
import { listSeniorPosts } from "@/lib/senior/posts";

/** 새 노트 — 관리자만. 비로그인은 로그인으로, 관리자가 아닌 계정은 목록으로. */
export default async function NewSeniorNotePage() {
  const viewer = await getBlogViewer();
  if (!viewer.admin) redirect(viewer.email ? "/blog" : "/login?next=/blog/notes/new");

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">새 노트</h1>
      <NoteForm posts={listSeniorPosts()} />
    </div>
  );
}
