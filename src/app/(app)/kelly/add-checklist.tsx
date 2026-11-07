"use client";

import { useState, useSyncExternalStore, useTransition } from "react";

import { recordLeg, type RecordLegInput } from "@/app/(app)/kelly/leg-actions";
import type { CheckItem } from "@/lib/legs";
import { CHECK_LABEL, type TraderLevel } from "@/lib/mer-check";

const LEVELS: readonly TraderLevel[] = [1, 2, 3];
const LEVEL_KEY = "kelly.traderLevel";

/* 레벨은 브라우저에 기억한다. 서버는 값을 모르므로 첫 렌더는 null(확인 불가)로 맞추고 붙은 뒤 읽는다. */
const listeners = new Set<() => void>();

function readLevel(): TraderLevel | null {
  try {
    const v = Number(localStorage.getItem(LEVEL_KEY));
    return LEVELS.find((l) => l === v) ?? null;
  } catch {
    return null;
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  window.addEventListener("storage", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", fn);
  };
}

function writeLevel(level: TraderLevel): void {
  try {
    localStorage.setItem(LEVEL_KEY, String(level));
  } catch {
    // 저장이 막히면 이번 화면에서만 못 바꾼다
  }
  listeners.forEach((fn) => fn());
}

/** 기억된 레벨 — 체크리스트 판정(evaluateAddChecklist 의 level)에 넣는다. */
export function useTraderLevel(): [TraderLevel | null, (level: TraderLevel) => void] {
  const level = useSyncExternalStore(subscribe, readLevel, () => null);
  return [level, writeLevel];
}

export interface AddChecklistProps {
  /** evaluateAddChecklist 의 8줄 */
  items: CheckItem[];
  level: TraderLevel | null;
  onLevelChange: (level: TraderLevel) => void;
  /** 기록할 다리 — 추가가·수량을 못 정했으면 null(버튼 비활성) */
  leg: Omit<RecordLegInput, "checklist" | "note"> | null;
}

const MARK: Record<"yes" | "no" | "unknown", { text: string; cls: string }> = {
  yes: { text: "✓ 예", cls: "text-profit" },
  no: { text: "✗ 아니오", cls: "text-loss" },
  unknown: { text: "? 확인 불가", cls: "text-dim" },
};

/**
 * 추가 진입 체크리스트 8줄 + 「다리 기록」(REQ-0102). 8줄 모두 예일 때만 통과다.
 * 미통과여도 기록은 남긴다 — 규칙을 어긴 추가도 복기 재료다.
 */
export function AddChecklist({ items, level, onLevelChange, leg }: AddChecklistProps) {
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const broken = items.filter((i) => i.ok === false).length;
  const unknown = items.filter((i) => i.ok === null).length;
  const allOk = items.length > 0 && broken === 0 && unknown === 0;

  const submit = () => {
    if (leg === null) return;
    setMessage(null);
    startTransition(async () => {
      const res = await recordLeg({ ...leg, checklist: items, note: note.trim() === "" ? null : note });
      if (res.ok) {
        setNote("");
        setMessage({ ok: true, text: `다리 ${res.legNo} 기록했습니다.` });
      } else {
        setMessage({ ok: false, text: res.error });
      }
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs text-dim">레벨</span>
        {LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => onLevelChange(l)}
            className={`rounded-lg border px-3 py-1 tnum ${
              level === l ? "border-accent text-accent" : "border-border text-dim hover:text-text"
            }`}
          >
            {l}
          </button>
        ))}
      </div>
      {level === 1 ? <p className="text-sm text-loss">레벨 1 — 피라미딩 금지, 시뮬레이션만</p> : null}

      <ol className="space-y-1 text-sm">
        {items.map((i, idx) => {
          const mark = MARK[i.ok === true ? "yes" : i.ok === false ? "no" : "unknown"];
          return (
            <li key={i.key} className="flex flex-wrap items-baseline gap-x-2 border-t border-border/60 py-1">
              <span className="w-4 text-xs text-dim tnum">{idx + 1}</span>
              <span className={`w-20 shrink-0 ${mark.cls}`}>{mark.text}</span>
              <span>{CHECK_LABEL[i.key]}</span>
              <span className="min-w-0 break-words text-xs text-dim tnum">{i.detail}</span>
            </li>
          );
        })}
      </ol>

      {allOk ? (
        <p className="text-sm text-profit">8줄 모두 예 — 추가 조건 충족</p>
      ) : (
        <p className="text-sm text-loss">
          규칙 {broken}개 어김{unknown > 0 ? ` · 확인 불가 ${unknown}개` : ""} — 기록은 남습니다
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent sm:max-w-sm"
          value={note}
          placeholder="메모(선택)"
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          type="button"
          onClick={submit}
          disabled={leg === null || pending}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "기록 중…" : "다리 기록"}
        </button>
      </div>
      {message ? <p className={`text-sm ${message.ok ? "text-profit" : "text-loss"}`}>{message.text}</p> : null}
    </div>
  );
}
