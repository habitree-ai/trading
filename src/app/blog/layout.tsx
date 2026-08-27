import type { Metadata } from "next";
import Link from "next/link";

import { ThemeToggle } from "@/app/(app)/theme-toggle";
import { getBlogViewer } from "@/lib/senior/admin";
import { SENIOR_DOCS } from "@/lib/senior/docs";

export const metadata: Metadata = {
  title: "선배님의 20년 — 정리와 내 생각",
  description:
    "네이버 블로그 pillion21 760편(2006~2026)을 읽고 정리한 문서와, 그 원문에 다는 내 생각 노트",
};

/**
 * 공개 페이지의 껍데기 — `(app)` 레이아웃 밖이다.
 *
 * 앱 레이아웃은 북 목록을 읽으며 로그인을 전제하므로 그 아래 둘 수 없다. 여기에는
 * 북 선택도 로그아웃도 없다. 관리자로 로그인해 있으면 새 노트 버튼과 앱으로 가는 링크가
 * 붙고, 아니면 로그인 링크 하나만 있다.
 */
export default async function BlogLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getBlogViewer();

  return (
    <div className="flex flex-1 flex-col">
      <div className="sticky top-0 z-20 border-b border-border bg-surface/90 backdrop-blur">
        <header className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
          <Link href="/blog" className="text-sm font-semibold tracking-tight whitespace-nowrap">
            선배님의 20년
            <span className="ml-2 hidden text-xs font-normal text-dim sm:inline">정리와 내 생각</span>
          </Link>

          <nav aria-label="정리 문서" className="scroll-x flex gap-1">
            {SENIOR_DOCS.map((doc) => (
              <Link
                key={doc.slug}
                href={`/blog/docs/${doc.slug}`}
                className="rounded-lg px-2.5 py-1.5 text-xs whitespace-nowrap text-dim hover:bg-surface-2 hover:text-text"
              >
                {doc.title}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            {viewer.admin ? (
              <>
                <span className="rounded border border-beta/50 px-1.5 py-0.5 text-[10px] text-beta">
                  관리자
                </span>
                <Link
                  href="/blog/notes/new"
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium whitespace-nowrap text-white"
                >
                  ＋ 새 노트
                </Link>
                <Link href="/dashboard" className="text-xs whitespace-nowrap text-dim hover:text-text">
                  앱 →
                </Link>
              </>
            ) : viewer.email ? null : (
              // 로그인했지만 관리자가 아닌 계정에게 로그인 링크는 뜻이 없다 — 읽기 전용이 곧 답이다.
              <Link href="/login?next=/blog" className="text-xs text-dim hover:text-text">
                로그인
              </Link>
            )}
            <ThemeToggle />
          </div>
        </header>
      </div>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
