"use client";

/**
 * 루트 레이아웃까지 터졌을 때의 마지막 그물.
 *
 * 이 경계는 `<html>`·`<body>` 를 스스로 그려야 한다 — 루트 레이아웃이 살아 있지 않다는
 * 뜻이기 때문이다. 그래서 전역 CSS 도 못 믿고 색을 직접 박는다.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="ko">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0e1116",
          color: "#e6e9ee",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
          padding: "2rem",
        }}
      >
        <div>
          <h2 style={{ fontSize: "1.05rem", margin: 0 }}>앱을 시작하지 못했습니다</h2>
          <p style={{ fontSize: "0.85rem", color: "#8b95a3" }}>
            새로고침해도 같으면 아래 코드와 함께 알려 주세요.
            {error.digest ? ` (${error.digest})` : ""}
          </p>
          <button
            type="button"
            onClick={() => unstable_retry()}
            style={{
              minHeight: "2.75rem",
              padding: "0 1.25rem",
              borderRadius: "0.5rem",
              border: 0,
              background: "#5b8cff",
              color: "#fff",
              fontSize: "0.875rem",
            }}
          >
            다시 시도
          </button>
        </div>
      </body>
    </html>
  );
}
