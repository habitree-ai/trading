"use client";

import { useState, useTransition } from "react";

import { startFlat, type FlatStartState } from "@/app/(app)/flat/actions";

/** 중립 기어 — 매매 버튼을 누르듯 무포지션을 내가 눌러서 든다. */
export function StartFlatButton() {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<FlatStartState>({});

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setState(await startFlat());
          })
        }
        className="rounded-xl bg-accent px-8 py-4 text-lg font-semibold text-white disabled:opacity-50"
      >
        {pending ? "넣는 중…" : "무포지션 시작"}
      </button>
      {state.error ? <p className="text-sm text-loss">{state.error}</p> : null}
    </div>
  );
}
