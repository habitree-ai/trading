"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { createBook, type BookFormState } from "@/app/(app)/books/actions";

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
      {pending ? "만드는 중…" : "북 만들기"}
    </button>
  );
}

export function BookForm() {
  const [state, action] = useActionState<BookFormState, FormData>(createBook, {});

  return (
    <form action={action} className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="book-name">
            북 이름 *
          </label>
          <input id="book-name" className={INPUT} name="name" placeholder="예) 선물 3차" required />
        </div>
        <div>
          <label className={LABEL} htmlFor="book-capital">
            초기자금 *
          </label>
          <input
            id="book-capital"
            className={`${INPUT} tnum`}
            name="initial_capital"
            inputMode="decimal"
            placeholder="예) 500"
            required
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="book-exchange">
            거래소
          </label>
          <input id="book-exchange" className={INPUT} name="exchange" placeholder="예) Bybit" />
        </div>
        <div>
          <label className={LABEL} htmlFor="book-currency">
            기준 통화
          </label>
          <input id="book-currency" className={INPUT} name="base_currency" defaultValue="USDT" />
        </div>
        <div>
          <label className={LABEL} htmlFor="book-start">
            시작일
          </label>
          <input id="book-start" className={INPUT} name="start_date" type="date" />
        </div>
        <div>
          <label className={LABEL} htmlFor="book-memo">
            메모
          </label>
          <input id="book-memo" className={INPUT} name="memo" placeholder="운용 원칙 등" />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Submit />
        {state.error ? <span className="text-sm text-loss">{state.error}</span> : null}
      </div>
    </form>
  );
}
