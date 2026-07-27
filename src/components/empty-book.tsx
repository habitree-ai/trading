import Link from "next/link";

/** 북이 하나도 없을 때 모든 화면이 공유하는 안내. */
export function EmptyBook() {
  return (
    <div className="mx-auto max-w-md rounded-xl border border-dashed border-border p-10 text-center">
      <p className="text-sm text-dim">
        아직 북이 없습니다. 계좌나 기간별로 일지를 나누는 단위입니다.
      </p>
      <Link
        href="/books"
        className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
      >
        첫 북 만들기
      </Link>
    </div>
  );
}
