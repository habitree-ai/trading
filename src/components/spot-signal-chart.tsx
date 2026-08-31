"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  type UTCTimestamp,
} from "lightweight-charts";

/**
 * 현물신호 상세 차트 — 신호 봉 주변 1H 캔들에 발생 지점을 마커로 찍는다.
 *
 * 복기 차트(trade-chart)의 주석·측정 도구까지는 필요 없어 얇게 따로 둔다.
 * 캔들은 /api/upbit-candles 프록시에서 — 브라우저가 업비트를 직접 부르면 CORS 에 걸린다.
 */

const H1 = 3600_000;

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function SpotSignalChart({ market, barTs }: { market: string; barTs: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const signalMs = Date.parse(barTs);
    // 신호 뒤 48봉까지 보되, 미래·진행 중 봉은 요청하지 않는다.
    const to = Math.min(signalMs + 48 * H1, Math.floor(Date.now() / H1) * H1);

    const chart = createChart(host, {
      height: 380,
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#8b8f98", attributionLogo: false },
      grid: {
        vertLines: { color: "rgba(128,128,128,0.12)" },
        horzLines: { color: "rgba(128,128,128,0.12)" },
      },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: "rgba(128,128,128,0.25)" },
      rightPriceScale: { borderColor: "rgba(128,128,128,0.25)" },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      borderVisible: false,
    });

    let disposed = false;
    (async () => {
      try {
        const res = await fetch(`/api/upbit-candles?market=${market}&unit=60&count=168&to=${to}`);
        const json = (await res.json()) as { candles?: Candle[]; error?: string };
        if (!res.ok || !json.candles) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (disposed) return;

        series.setData(
          json.candles.map((k) => ({
            time: (k.t / 1000) as UTCTimestamp,
            open: k.o,
            high: k.h,
            low: k.l,
            close: k.c,
          })),
        );
        createSeriesMarkers(series, [
          {
            time: (signalMs / 1000) as UTCTimestamp,
            position: "belowBar",
            color: "#f0a020",
            shape: "arrowUp",
            text: "신호",
          },
        ]);
        chart.timeScale().fitContent();
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => {
      disposed = true;
      chart.remove();
    };
  }, [market, barTs]);

  if (error) {
    return (
      <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-dim">
        차트를 불러오지 못했습니다: {error}
      </p>
    );
  }
  return <div ref={hostRef} className="h-[380px] w-full" />;
}
