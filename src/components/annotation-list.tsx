"use client";

import { useState, useTransition } from "react";

import { deleteAnnotation, updateAnnotationText } from "@/app/(app)/trades/annotation-actions";
import { ANNOTATION_DOT_CLASS } from "@/lib/annotations";
import { ANNOTATION_KIND_LABEL, type TradeAnnotation } from "@/lib/domain";
import { dateTime, num } from "@/lib/format";

function isoOf(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** 가리키는 가격 — 두 점짜리는 어디서 어디까지인지 함께 보인다. */
function priceRange(annotation: TradeAnnotation): string {
  const [first, second] = annotation.points;
  return second ? `${num(first.p)} → ${num(second.p)}` : num(first.p);
}

/**
 * 차트에 남긴 메모 목록.
 *
 * 차트 위 도형만으로는 무엇을 적어 뒀는지 훑을 수가 없다 — 확대해 가며 찾아야 한다.
 * 복기는 목록으로 읽고, 자리는 차트에서 본다.
 */
export function AnnotationList({ annotations }: { annotations: TradeAnnotation[] }) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (annotations.length === 0) return null;

  const save = (annotation: TradeAnnotation) => {
    startTransition(async () => {
      await updateAnnotationText(annotation.id, draft);
      setEditing(null);
    });
  };

  return (
    <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
      {annotations.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
          <span
            className={`size-2 shrink-0 rounded-full ${ANNOTATION_DOT_CLASS[a.color]}`}
            aria-hidden
          />
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-dim">
            {ANNOTATION_KIND_LABEL[a.kind]}
          </span>

          {editing === a.id ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save(a);
                if (e.key === "Escape") setEditing(null);
              }}
              className="min-w-40 flex-1 rounded border border-accent bg-bg px-2 py-1 outline-none"
            />
          ) : (
            <span className={a.text ? "" : "text-dim"}>{a.text ?? "(라벨 없음)"}</span>
          )}

          <span className="tnum ml-auto text-dim">{priceRange(a)}</span>
          <span className="tnum w-28 text-right text-dim">{dateTime(isoOf(a.points[0].t))}</span>

          {editing === a.id ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => save(a)}
              className="text-accent disabled:opacity-50"
            >
              저장
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setEditing(a.id);
                setDraft(a.text ?? "");
              }}
              className="text-dim hover:text-text"
            >
              고치기
            </button>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={() => startTransition(async () => void (await deleteAnnotation(a.id)))}
            className="text-loss disabled:opacity-50"
          >
            삭제
          </button>
        </li>
      ))}
    </ul>
  );
}
