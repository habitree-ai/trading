"use client";

import { useState, useTransition } from "react";

import { runOkxSync, type SyncState } from "@/app/(app)/trades/actions";

export function OkxSyncButton() {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<SyncState>({});

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setState({});
            setState(await runOkxSync());
          })
        }
        className="rounded-lg border border-border px-3 py-2 text-sm text-dim hover:text-text disabled:opacity-50"
      >
        {pending ? "받는 중…" : "OKX 동기화"}
      </button>
      {state.error ? <span className="text-xs text-loss">{state.error}</span> : null}
      {state.message ? <span className="text-xs text-dim">{state.message}</span> : null}
    </div>
  );
}
