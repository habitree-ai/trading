"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { signIn, signUp, type AuthState } from "@/app/login/actions";

const INPUT =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent";

function SubmitButton({ label, variant }: { label: string; variant: "primary" | "ghost" }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={
        variant === "primary"
          ? "w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          : "w-full rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50"
      }
    >
      {pending ? "처리 중…" : label}
    </button>
  );
}

export function LoginForm({ next }: { next: string }) {
  const [signInState, signInAction] = useActionState<AuthState, FormData>(signIn, {});
  const [signUpState, signUpAction] = useActionState<AuthState, FormData>(signUp, {});
  const message = signInState.error ?? signUpState.error ?? signUpState.notice;
  const isError = Boolean(signInState.error ?? signUpState.error);

  return (
    <div className="mt-8 space-y-3">
      <form action={signInAction} className="space-y-3">
        <input type="hidden" name="next" value={next} />
        <input
          className={INPUT}
          name="email"
          type="email"
          autoComplete="email"
          placeholder="이메일"
          required
        />
        <input
          className={INPUT}
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="비밀번호"
          required
        />
        <SubmitButton label="로그인" variant="primary" />
      </form>

      <form action={signUpAction}>
        {/* 위 폼과 값을 공유할 수 없어 브라우저 자동완성에 기대지 않고 다시 받는다. */}
        <details className="rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm text-dim">계정이 없으신가요?</summary>
          <div className="mt-3 space-y-3">
            <input className={INPUT} name="email" type="email" placeholder="이메일" required />
            <input
              className={INPUT}
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder="비밀번호 (8자 이상)"
              required
            />
            <SubmitButton label="가입하기" variant="ghost" />
          </div>
        </details>
      </form>

      {message ? (
        <p className={`text-sm ${isError ? "text-loss" : "text-profit"}`}>{message}</p>
      ) : null}
    </div>
  );
}
