import { TradingViewWidget } from "@/app/(app)/chart/tradingview-widget";

/*
 * 실시간 관찰용 TradingView 위젯 탭. 복기용 "당시 차트"(trade-chart.tsx)와 무관하다.
 * tradingview.com 본 사이트는 iframe 삽입을 차단하므로 공식 위젯을 쓴다 — docs/tradingview.md.
 */

/** 위젯 초기 심볼과 "트레이딩뷰에서 열기" 링크가 같은 값을 쓴다 — OKX USDT 무기한. */
const DEFAULT_SYMBOL = "OKX:BTCUSDT.P";

export default function ChartPage() {
  return (
    /*
     * 높이는 페이지가 스스로 잡는다. (app) layout의 main은 min-h 체인이라 h-full이
     * 내려오지 않고, layout을 고치면 모든 페이지에 영향이 가기 때문.
     * 고정 껍데기 높이는 globals.css의 --app-chrome이 정본이고, 여기서는 main의
     * 상하 패딩(py-6 = 3rem)만 더 뺀다.
     */
    <div className="flex h-[calc(100dvh_-_var(--app-chrome)_-_3rem)] min-h-[420px] flex-col gap-3">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">실시간 차트</h1>
          <p className="mt-1 text-sm text-dim">
            TradingView Advanced Chart — 심볼 검색·지표·그리기 도구를 그대로 씁니다. 그린
            내용은 저장되지 않습니다.
          </p>
        </div>
        <a
          href={`https://kr.tradingview.com/chart/?symbol=${encodeURIComponent(DEFAULT_SYMBOL)}`}
          target="_blank"
          rel="noopener"
          className="shrink-0 rounded-lg border border-border px-3 py-2 text-sm text-dim hover:text-text"
        >
          트레이딩뷰에서 열기 ↗
        </a>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-surface">
        <TradingViewWidget symbol={DEFAULT_SYMBOL} />
      </div>
    </div>
  );
}
