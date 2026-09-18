"use client";

import { useEffect, useRef, useState } from "react";

import { applyDocFilter, buildDocIndex, DOC_BODY_ID, type DocIndex } from "@/lib/senior/doc-filter";

// 노트 편집 화면의 글 고르기(`post-picker.tsx`)와 같은 입력칸 모양.
const INPUT =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent";

/**
 * 정리 문서 검색칸 — 글 표의 행을 제자리에서 접는다.
 *
 * 색인은 마운트 때 본문 DOM 에서 한 번 만든다(서버가 보낸 HTML 을 그대로 쓴다 — 767행을
 * prop 으로 다시 내려보내면 페이지 무게가 두 배가 된다). JS 가 없으면 이 칸이 없고 문서는
 * 전부 보인다.
 */
export function DocSearch() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState(0);
  const index = useRef<DocIndex | null>(null);

  useEffect(() => {
    const root = document.getElementById(DOC_BODY_ID);
    if (root === null) return;
    index.current = buildDocIndex(root);
    return () => {
      // 떠날 때 접어 둔 것을 펴 둔다 — 같은 DOM 이 남아 있는 경로는 없지만 상태를 남기지 않는다.
      if (index.current !== null) applyDocFilter(index.current, "");
      index.current = null;
    };
  }, []);

  const search = (value: string) => {
    setQ(value);
    if (index.current !== null) setHits(applyDocFilter(index.current, value).posts);
  };

  return (
    <div className="mb-5 max-w-sm">
      <input
        type="search"
        value={q}
        onChange={(e) => search(e.target.value)}
        placeholder="제목·게시판·날짜·logNo 로 찾기"
        aria-label="글 검색"
        autoComplete="off"
        className={INPUT}
      />
      {q.trim() === "" ? null : (
        <p className="mt-1.5 text-xs text-dim" aria-live="polite">
          {hits === 0 ? "맞는 글이 없습니다." : `${hits}편`}
        </p>
      )}
    </div>
  );
}
