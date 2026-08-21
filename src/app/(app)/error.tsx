"use client";

/**
 * 화면 하나가 터져도 앱 전체가 죽지 않게 한다.
 *
 * 예전에는 쿼리가 하나만 실패해도 Next 기본 오류 화면이 통째로 떠서, 헤더도 메뉴도
 * 사라지고 주소창을 고쳐야 돌아올 수 있었다. 여기서 잡으면 껍데기(헤더·사이드바)는
 * 살아 있고 본문 자리만 오류 카드로 바뀐다.
 *
 * 원인이 일시적인 경우(네트워크 끊김, 세션 갱신 타이밍)가 대부분이라 다시 시도를
 * 앞에 둔다 — `unstable_retry` 는 서버 컴포넌트를 다시 불러 온다.
 */
export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const needsLogin = error.message.includes("인증이 필요합니다");

  return (
    <div className="mx-auto max-w-md py-12 text-center">
      <h2 className="text-lg font-semibold">이 화면을 불러오지 못했습니다</h2>
      <p className="mt-2 text-sm text-dim">
        {needsLogin
          ? "로그인 세션이 만료됐을 수 있습니다. 다시 로그인해 주세요."
          : "잠시 뒤 다시 시도해 주세요. 계속 같은 화면이면 아래 코드와 함께 알려 주세요."}
      </p>
      {error.digest ? (
        <p className="tnum mt-2 text-[11px] text-dim">오류 코드 {error.digest}</p>
      ) : null}

      <div className="mt-5 flex justify-center gap-2">
        <button
          type="button"
          onClick={() => unstable_retry()}
          className="min-h-11 rounded-lg bg-accent px-5 text-sm font-medium text-white"
        >
          다시 시도
        </button>
        {needsLogin ? (
          <a
            href="/login"
            className="flex min-h-11 items-center rounded-lg border border-border px-5 text-sm"
          >
            로그인
          </a>
        ) : null}
      </div>
    </div>
  );
}
