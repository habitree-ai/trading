"use client";

import { useState, useTransition } from "react";

import {
  deleteAnnotation,
  setAnnotationLocked,
  updateAnnotationText,
} from "@/app/(app)/trades/annotation-actions";
import { ANNOTATION_DOT_CLASS } from "@/lib/annotations";
import { ANNOTATION_KIND_LABEL, isPositionKind, type TradeAnnotation } from "@/lib/domain";
import { DASH, dateTime, num } from "@/lib/format";
import { positionMetrics } from "@/lib/position-tool";

function isoOf(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * 가리키는 가격 — 두 점짜리는 어디서 어디까지인지 함께 보인다.
 *
 * 손익 툴은 세 점이 각각 진입·손절·목표라 범위로 읽으면 뜻이 어긋난다. 목록에서
 * 훑을 때 알고 싶은 건 어느 자리에 걸었고 몇 대 일이었나이므로 그것만 적는다.
 */
function priceRange(annotation: TradeAnnotation): string {
  const [first, second, third] = annotation.points;

  if (isPositionKind(annotation.kind) && second && third) {
    const m = positionMetrics({
      side: annotation.kind,
      entry: first.p,
      stop: second.p,
      target: third.p,
    });
    return `진입 ${num(first.p)} · 손익비 ${m?.rr === undefined || m?.rr === null ? DASH : num(m.rr, 2)}`;
  }

  return second ? `${num(first.p)} → ${num(second.p)}` : num(first.p);
}

/**
 * 차트에 남긴 메모 목록.
 *
 * 차트 위 도형만으로는 무엇을 적어 뒀는지 훑을 수가 없다 — 확대해 가며 찾아야 한다.
 * 복기는 목록으로 읽고, 자리는 차트에서 본다.
 *
 * 잠금은 여기에만 둔다. 잠근 메모는 차트에서 집히지 않으니(그래야 그 위에서도 차트가
 * 밀린다) 차트 쪽에는 풀 자리가 없다.
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
          {a.locked ? (
            <span
              className="rounded border border-beta/40 px-1.5 py-0.5 text-[10px] text-beta"
              title="잠겨 있어 차트에서 끌리지 않습니다"
            >
              잠김
            </span>
          ) : null}

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
            title={
              a.locked
                ? "풀면 차트에서 다시 끌어 옮길 수 있습니다"
                : "잠그면 차트를 만져도 밀리지 않습니다"
            }
            onClick={() =>
              startTransition(async () => void (await setAnnotationLocked(a.id, !a.locked)))
            }
            className="text-dim hover:text-text disabled:opacity-50"
          >
            {a.locked ? "잠금 해제" : "잠금"}
          </button>
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
