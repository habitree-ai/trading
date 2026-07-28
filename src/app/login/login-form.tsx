"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { signIn, signInWithGoogle, signUp, type AuthState } from "@/app/login/actions";

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

/** 구글 브랜드 가이드의 4색 G — 색을 바꾸면 안 되므로 값을 그대로 박는다. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="h-4 w-4">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  );
}

function GoogleButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium disabled:opacity-50"
    >
      <GoogleMark />
      {pending ? "구글로 이동 중…" : "구글 계정으로 계속하기"}
    </button>
  );
}

export function LoginForm({ next }: { next: string }) {
  const [signInState, signInAction] = useActionState<AuthState, FormData>(signIn, {});
  const [signUpState, signUpAction] = useActionState<AuthState, FormData>(signUp, {});
  const [googleState, googleAction] = useActionState<AuthState, FormData>(signInWithGoogle, {});
  const message = googleState.error ?? signInState.error ?? signUpState.error ?? signUpState.notice;
  const isError = Boolean(googleState.error ?? signInState.error ?? signUpState.error);

  return (
    <div className="mt-8 space-y-3">
      <form action={googleAction}>
        <input type="hidden" name="next" value={next} />
        <GoogleButton />
      </form>

      <div className="flex items-center gap-3 py-1 text-xs text-dim">
        <span className="h-px flex-1 bg-border" />
        또는 이메일로
        <span className="h-px flex-1 bg-border" />
      </div>

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
