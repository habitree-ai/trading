"use client";

import { useState } from "react";

import type { SeniorPost } from "@/lib/senior/posts";

const INPUT =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent";

/**
 * 760편에서 글 하나 고르기 — 제목·게시판·날짜로 찾는다.
 *
 * 목록이 통째로 내려와 브라우저에서 거른다. 편집 폼에서만 쓰이므로 읽는 사람은
 * 이 무게를 지지 않는다.
 */
export function PostPicker({
  posts,
  exclude,
  onPick,
  placeholder,
}: {
  posts: SeniorPost[];
  exclude: string[];
  onPick: (id: string) => void;
  placeholder: string;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const hits = needle
    ? posts
        .filter(
          (p) =>
            !exclude.includes(p.id) &&
            `${p.title} ${p.board} ${p.date}`.toLowerCase().includes(needle),
        )
        .slice(0, 40)
    : [];

  return (
    <div className="relative">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className={INPUT}
      />
      {needle ? (
        <div className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-border bg-surface shadow-lg">
          {hits.length === 0 ? (
            <p className="p-4 text-center text-xs text-dim">검색 결과가 없습니다.</p>
          ) : (
            hits.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onPick(p.id);
                  setQ("");
                }}
                className="block w-full border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-surface-2"
              >
                <span className="tnum text-[11px] text-dim">{p.date}</span>
                <span className="ml-2 text-[11px] text-dim">{p.board}</span>
                <span className="block text-sm">{p.title}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
