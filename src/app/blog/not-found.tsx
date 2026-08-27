import Link from "next/link";

/** 루트의 not-found 는 대시보드(로그인 뒤)로 보낸다 — 공개 페이지에서는 여기로 돌아와야 한다. */
export default function BlogNotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <h1 className="text-lg font-semibold">없는 글입니다</h1>
      <p className="mt-2 text-sm text-dim">주소가 바뀌었거나 지워진 노트·문서입니다.</p>
      <Link
        href="/blog"
        className="mt-5 flex min-h-11 items-center rounded-lg bg-accent px-5 text-sm font-medium text-white"
      >
        목록으로
      </Link>
    </div>
  );
}
