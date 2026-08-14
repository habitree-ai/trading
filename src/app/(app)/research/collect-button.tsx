"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { runCollect, type ResearchFormState } from "@/app/(app)/research/actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? "수집하는 중…" : "지금 수집"}
    </button>
  );
}

/** 현재 심볼의 스냅샷을 즉시 수집한다 — 소스 4곳을 걷어 한 장으로 적재. */
export function CollectButton({ symbol }: { symbol: string }) {
  const [state, action] = useActionState<ResearchFormState, FormData>(runCollect, {});

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="symbol" value={symbol} />
      <Submit />
      {state.error ? <span className="text-sm text-loss">{state.error}</span> : null}
      {state.message ? <span className="text-sm text-dim">{state.message}</span> : null}
    </form>
  );
}
