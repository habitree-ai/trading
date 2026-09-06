"use client";

import { useState } from "react";

import { CapturePanel } from "@/app/(app)/trades/new/capture-panel";
import type { FieldSuggestions } from "@/lib/queries";

/**
 * 캡쳐로 거래를 직접 등록하는 옛 경로 — 접어 둔다.
 *
 * 기록은 포지션 기록·일반 기록 둘뿐이다(REQ-0048). 거래소 연동이 없는 북에서 숫자까지 손으로
 * 넣어야 할 때만 이게 필요하다. 펼치기 전에는 아예 그리지 않는다 — 그 안의 거래 폼이 기록
 * 폼과 같은 칸 id(근거·복기·감정)를 쓰므로, 같이 그리면 라벨이 엉뚱한 칸을 가리킨다.
 */
export function LegacyCapture(props: { bookId: string; userId: string; suggestions: FieldSuggestions }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl border border-dashed border-border p-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-dim hover:text-text"
      >
        {open ? "▾" : "▸"} 캡쳐로 거래 직접 등록{" "}
        <span className="text-dim/70">— 거래소 연동이 없는 북에서 숫자까지 손으로 넣을 때</span>
      </button>
      {open ? (
        <div className="mt-3">
          <CapturePanel {...props} />
        </div>
      ) : null}
    </section>
  );
}
