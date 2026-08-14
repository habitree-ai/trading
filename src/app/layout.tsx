import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "트레이딩 누적기록",
  description: "캡쳐를 올리면 거래가 누적되고 대시보드가 갱신되는 매매일지",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
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
