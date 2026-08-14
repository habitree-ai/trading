"use client";

import { useEffect, useRef, useState } from "react";

/**
 * TradingView 공식 임베드 스크립트. 이 스크립트가 자기 script 태그의 텍스트 내용을
 * JSON 설정으로 읽어, 같은 컨테이너 안에 차트 iframe을 주입한다.
 * 자세한 선택 근거와 제약은 docs/tradingview.md 참고.
 */
const EMBED_SRC =
  "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

/** 위젯 아래 attribution 줄 높이 — 공식 스니펫의 calc(100% - 32px)와 같은 값. */
const COPYRIGHT_PX = 32;

export function TradingViewWidget({ symbol }: { symbol: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  /*
   * 앱의 화면 모드는 <html data-theme>이 진실 원천이다(헤더 토글이 바꾼다).
   * 렌더 중 문서 속성을 읽으면 서버 HTML과 어긋난다(하이드레이션 불일치).
   * null(미정)로 시작해 이펙트에서 확정하고, 그 전에는 위젯을 만들지 않는다.
   */
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    const apply = () =>
      setTheme(root.getAttribute("data-theme") === "light" ? "light" : "dark");
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || theme === null) return;

    // 공식 스니펫과 같은 구조를 DOM으로 직접 조립한다 — JSON 설정이 script 태그의
    // "텍스트 내용"으로 들어가는 형태라 JSX로는 표현할 수 없다.
    const container = document.createElement("div");
    container.className = "tradingview-widget-container";
    container.style.height = "100%";
    container.style.width = "100%";

    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = `calc(100% - ${COPYRIGHT_PX}px)`;
    widget.style.width = "100%";

    // attribution 링크는 무료 위젯 사용 조건이다 — 지우면 안 된다.
    const copyright = document.createElement("div");
    copyright.className = "tradingview-widget-copyright";
    const link = document.createElement("a");
    link.href = "https://kr.tradingview.com/";
    link.rel = "noopener nofollow";
    link.target = "_blank";
    link.textContent = "Track all markets on TradingView";
    copyright.appendChild(link);

    const script = document.createElement("script");
    script.src = EMBED_SRC;
    script.type = "text/javascript";
    script.async = true;
    script.text = JSON.stringify({
      autosize: true, // 컨테이너 크기를 그대로 따른다 — 높이는 page.tsx가 잡는다
      symbol,
      interval: "60",
      timezone: "Asia/Seoul",
      theme, // 위젯은 만든 뒤 테마를 바꿀 API가 없다 — 테마가 바뀌면 새로 만든다
      style: "1",
      locale: "kr",
      allow_symbol_change: true,
      hide_side_toolbar: false, // 그리기 도구 툴바를 켠다
      support_host: "https://www.tradingview.com",
    });

    container.append(widget, copyright, script);
    host.appendChild(container);

    return () => {
      // StrictMode 이중 마운트·테마 전환 — 이전 위젯(iframe 포함)을 통째로 걷어낸다.
      host.replaceChildren();
    };
  }, [theme, symbol]);

  return <div ref={hostRef} className="h-full w-full" />;
}
