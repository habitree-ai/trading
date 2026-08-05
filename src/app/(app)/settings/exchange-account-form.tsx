"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import {
  saveOkxAccount,
  type ExchangeAccountState,
} from "@/app/(app)/settings/actions";

const INPUT =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent";
const LABEL = "block text-xs text-dim mb-1";

function Submit({ replacing }: { replacing: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? "저장 중…" : replacing ? "키 교체" : "키 등록"}
    </button>
  );
}

export function ExchangeAccountForm({ replacing }: { replacing: boolean }) {
  const [state, action] = useActionState<ExchangeAccountState, FormData>(saveOkxAccount, {});

  return (
    <form action={action} className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="okx-label">
            이름
          </label>
          <input id="okx-label" className={INPUT} name="label" placeholder="예) OKX 본계정" />
        </div>
        <div>
          <label className={LABEL} htmlFor="okx-key">
            API Key *
          </label>
          <input
            id="okx-key"
            className={INPUT}
            name="api_key"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="okx-secret">
            Secret Key *
          </label>
          <input
            id="okx-secret"
            className={INPUT}
            name="api_secret"
            type="password"
            autoComplete="new-password"
            required
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="okx-passphrase">
            Passphrase *
          </label>
          <input
            id="okx-passphrase"
            className={INPUT}
            name="passphrase"
            type="password"
            autoComplete="new-password"
            required
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Submit replacing={replacing} />
        {state.error ? <span className="text-sm text-loss">{state.error}</span> : null}
        {state.message ? <span className="text-sm text-dim">{state.message}</span> : null}
      </div>
    </form>
  );
}
