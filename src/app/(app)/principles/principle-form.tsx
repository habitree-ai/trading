"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

import { createPrinciple, type PrincipleFormState } from "@/app/(app)/principles/actions";
import { PRINCIPLE_CATEGORIES, PRINCIPLE_CATEGORY_LABEL } from "@/lib/domain";

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
      {pending ? "추가하는 중…" : "원칙 추가"}
    </button>
  );
}

export function PrincipleForm({ bookId }: { bookId: string }) {
  const [state, action] = useActionState<PrincipleFormState, FormData>(createPrinciple, {});
  const form = useRef<HTMLFormElement>(null);

  // 추가에 성공하면 칸을 비운다 — 원칙은 한 번에 여러 개를 이어 적게 된다.
  useEffect(() => {
    if (state.message) form.current?.reset();
  }, [state.message]);

  return (
    <form ref={form} action={action} className="mt-3 space-y-3">
      <input type="hidden" name="book_id" value={bookId} />

      <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
        <div>
          <label className={LABEL} htmlFor="principle-category">
            묶음
          </label>
          <select id="principle-category" name="category" className={INPUT} defaultValue="risk">
            {PRINCIPLE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {PRINCIPLE_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL} htmlFor="principle-title">
            원칙 *
          </label>
          <input
            id="principle-title"
            name="title"
            className={INPUT}
            placeholder="예) 한 거래 손실은 자금의 2%를 넘기지 않는다"
            required
          />
        </div>
      </div>

      <div>
        <label className={LABEL} htmlFor="principle-detail">
          왜 이 원칙인지
        </label>
        <textarea
          id="principle-detail"
          name="detail"
          rows={2}
          className={INPUT}
          placeholder="어겼을 때 무슨 일이 있었는지 적어 두면 다음에 손이 멈춥니다."
        />
      </div>

      <div className="flex items-center gap-3">
        <Submit />
        {state.error ? <span className="text-sm text-loss">{state.error}</span> : null}
        {state.message ? <span className="text-sm text-dim">{state.message}</span> : null}
      </div>
    </form>
  );
}
