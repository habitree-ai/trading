"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { saveRBase, type RBaseState } from "@/app/(app)/settings/actions";

const INPUT =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent";
const LABEL = "block text-xs text-dim mb-1";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? "저장 중…" : "지금부터 적용"}
    </button>
  );
}

/** 기준 R·예상 수수료율 입력 — 지금 값을 미리 채워 두고, 저장하면 새 이력 행이 된다. */
export function RBaseForm({ amount, feePct }: { amount: number | null; feePct: number | null }) {
  const [state, action] = useActionState<RBaseState, FormData>(saveRBase, {});

  return (
    <form action={action} className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="r-base-amount">
            기준 R (USDT) *
          </label>
          <input
            id="r-base-amount"
            className={INPUT}
            name="amount"
            inputMode="decimal"
            defaultValue={amount ?? ""}
            placeholder="예) 10"
            required
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="r-base-fee">
            예상 수수료율 (%, 한쪽 체결) *
          </label>
          <input
            id="r-base-fee"
            className={INPUT}
            name="fee_pct"
            inputMode="decimal"
            defaultValue={feePct ?? 0.05}
            required
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Submit />
        {state.error ? <span className="text-sm text-loss">{state.error}</span> : null}
        {state.message ? <span className="text-sm text-dim">{state.message}</span> : null}
      </div>
    </form>
  );
}
