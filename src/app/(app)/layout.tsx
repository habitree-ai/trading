import { AppNav } from "@/app/(app)/app-nav";
import { BookSwitcher } from "@/app/(app)/book-switcher";
import { ThemeToggle } from "@/app/(app)/theme-toggle";
import { signOut } from "@/app/login/actions";
import { getActiveBook, listBooks } from "@/lib/queries";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const books = await listBooks();
  const activeBook = await getActiveBook(books);

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-border bg-surface/90 px-4 py-3 backdrop-blur">
        <span className="text-sm font-semibold tracking-tight">트레이딩 누적기록</span>
        <BookSwitcher books={books} activeId={activeBook?.id ?? null} />
        <div className="ml-auto flex items-center gap-3">
          <ThemeToggle />
          <form action={signOut}>
            <button type="submit" className="text-xs text-dim hover:text-text">
              로그아웃
            </button>
          </form>
        </div>
      </header>

      <div className="flex flex-1 flex-col md:flex-row">
        <AppNav />
        <main className="min-w-0 flex-1 px-4 py-6 md:px-6">{children}</main>
      </div>
    </div>
  );
}
