import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "트레이딩 누적기록",
  description: "캡쳐를 올리면 거래가 누적되고 대시보드가 갱신되는 매매일지",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  /*
   * 모바일 브라우저의 주소창 색을 앱 배경과 맞춘다 — 스크롤할 때 위쪽에 다른 색
   * 띠가 남으면 화면이 잘려 보인다. 두 값 다 globals.css 의 `--bg` 와 같은 색이다.
   *
   * `maximumScale`/`userScalable` 은 일부러 건드리지 않는다. 확대를 막으면
   * 촘촘한 숫자 표를 눈으로 키워 볼 방법이 사라진다.
   */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1116" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // 인라인 스크립트가 하이드레이션 전에 data-theme을 바꿀 수 있어 경고를 끈다.
    <html lang="ko" data-theme="dark" className="h-full antialiased" suppressHydrationWarning>
      <head>
        {/* 저장된 화면 모드를 첫 페인트 전에 적용한다 — 늦으면 다크→라이트 깜빡임이 보인다. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if(localStorage.getItem("theme")==="light")document.documentElement.setAttribute("data-theme","light")}catch(e){}})()`,
          }}
        />
      </head>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
