"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { generateBriefing, type ResearchFormState } from "@/app/(app)/research/actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg border border-border px-4 py-2 text-sm text-dim hover:text-text disabled:opacity-50"
    >
      {pending ? "브리핑 작성 중…" : "AI 브리핑 생성"}
    </button>
  );
}

/**
 * 최신 스냅샷·헤드라인을 AI가 정리해 브리핑 노트로 남긴다.
 *
 * 호출마다 비용이 들어 자동으로 돌지 않는다 — 버튼이 유일한 트리거다.
 */
export function BriefingButton({ symbol }: { symbol: string }) {
  const [state, action] = useActionState<ResearchFormState, FormData>(generateBriefing, {});

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="symbol" value={symbol} />
      <Submit />
      {state.error ? <span className="text-sm text-loss">{state.error}</span> : null}
      {state.message ? <span className="text-sm text-dim">{state.message}</span> : null}
    </form>
  );
}
