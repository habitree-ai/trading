import { AppNav, AreaTabs, ScreenTabs } from "@/app/(app)/app-nav";
import { BookSwitcher } from "@/app/(app)/book-switcher";
import { ThemeToggle } from "@/app/(app)/theme-toggle";
import { signOut } from "@/app/login/actions";
import { getActiveBook, listBooks } from "@/lib/queries";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const books = await listBooks();
  const activeBook = await getActiveBook(books);

  return (
    <div className="flex flex-1 flex-col">
      {/*
        헤더와 (좁은 화면의) 화면 목록을 한 덩어리로 고정한다.
        따로 고정하면 아래쪽 시작 위치를 헤더 높이만큼 상수로 적어야 하는데, 그 상수는
        손가락 입력이라 버튼이 커지거나 글꼴이 바뀌는 것만으로도 어긋난다.
      */}
      <div className="sticky top-0 z-20 border-b border-border bg-surface/90 backdrop-blur">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
          <span className="hidden text-sm font-semibold tracking-tight sm:inline">
            트레이딩 누적기록
          </span>
          <AreaTabs />
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <BookSwitcher books={books} activeId={activeBook?.id ?? null} />
            <ThemeToggle />
            <form action={signOut}>
              <button
                type="submit"
                aria-label="로그아웃"
                className="text-xs text-dim hover:text-text"
              >
                <span className="hidden sm:inline">로그아웃</span>
                <span aria-hidden className="sm:hidden">
                  ⏻
                </span>
              </button>
            </form>
          </div>
        </header>
        <ScreenTabs />
      </div>

      <div className="flex flex-1 flex-col md:flex-row">
        <AppNav />
        <main className="min-w-0 flex-1 px-4 py-6 md:px-6">{children}</main>
      </div>
    </div>
  );
}
