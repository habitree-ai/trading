import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
      <h1 className="text-lg font-semibold">없는 주소입니다</h1>
      <p className="mt-2 text-sm text-dim">주소가 바뀌었거나 지워진 화면입니다.</p>
      <Link
        href="/dashboard"
        className="mt-5 flex min-h-11 items-center rounded-lg bg-accent px-5 text-sm font-medium text-white"
      >
        대시보드로
      </Link>
    </main>
  );
}
