"use client";

/*
 * 현재 모드는 <html data-theme>이 진실 원천이다 — 루트 레이아웃의 인라인 스크립트가
 * 첫 페인트 전에 저장값을 반영하고, 이 버튼은 속성만 뒤집는다. 컴포넌트가 테마 상태를
 * 들고 있으면 서버는 저장값을 몰라 하이드레이션이 어긋나므로, 마크업은 늘 같게 두고
 * 어느 라벨을 보여줄지는 CSS(data-theme 조상 선택자)로 가른다.
 *
 * 좁은 화면에서는 글자를 떼고 아이콘만 남긴다 — 헤더 한 줄에 북 선택까지 들어가야 한다.
 */
export function ThemeToggle() {
  return (
    <button
      type="button"
      aria-label="화면 모드 전환"
      onClick={() => {
        const root = document.documentElement;
        const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
        root.setAttribute("data-theme", next);
        try {
          localStorage.setItem("theme", next);
        } catch {
          // 저장이 막혀도 이번 세션의 전환은 유지된다
        }
      }}
      className="text-xs whitespace-nowrap text-dim hover:text-text"
    >
      {/* 라벨은 "누르면 바뀔 모드"를 보여준다. */}
      <span aria-hidden className="[[data-theme=light]_&]:hidden">
        ☀️<span className="ml-1 hidden sm:inline">라이트</span>
      </span>
      <span aria-hidden className="[[data-theme=dark]_&]:hidden">
        🌙<span className="ml-1 hidden sm:inline">다크</span>
      </span>
    </button>
  );
}
