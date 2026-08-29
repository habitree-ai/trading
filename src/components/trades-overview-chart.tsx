"use client";

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type SeriesMarker,
  type TickMarkType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";

import { formatKst, formatTick, readTheme } from "@/components/trade-chart";
import { dateTime } from "@/lib/format";
import { BARS, BAR_MS, type Bar, type Candle } from "@/lib/okx";
import { type OverviewTrade, barFits, mostTradedSymbol, overviewWindow } from "@/lib/trade-overview";

/**
 * 화살표 크기 — 기본(1)보다 작게.
 *
 * 전체 구간에는 화살표가 수십 개 올라간다. 행 차트 크기 그대로면 이웃 봉의 것끼리 겹쳐
 * 어느 봉의 것인지 안 읽힌다. 글자도 붙이지 않는다 — 위치만 보는 차트다.
 */
const MARKER_SIZE = 0.75;

/** 한 봉에 찍힌 화살표들 — 클릭한 봉에서 거래를 되찾는 색인. 같은 봉에 여럿이면 가격으로 가른다. */
type MarkerIndex = Map<number, { id: string; price: number }[]>;

/**
 * 전체 차트 — 한 종목의 거래 전부를 캔들 한 장 위에 진입 ▲ · 청산 ▼ 으로 찍는다.
 *
 * 행마다 펼치는 `TradeChart` 와 달리 거래량·RSI·메모·도구가 없다. 어디서 들어가고
 * 어디서 나왔는지의 **분포**를 보는 자리라 캔들과 화살표만 남긴다. 캔들은 같은
 * `/api/candles` 프록시로 받는다. 화살표를 누르면 `onPick` 으로 그 거래를 알린다.
 */
export function TradesOverviewChart({
  trades,
  preferredSymbol = null,
  now,
  onPick,
}: {
  /** 목록의 거래 전부 — 종목은 안에서 가른다 */
  trades: readonly OverviewTrade[];
  /** 표에서 골라 둔 종목 필터. 있으면 그 종목을 먼저 보여준다 */
  preferredSymbol?: string | null;
  /** 페이지를 그린 시각(ms) — 보유중인 거래의 끝. `TradeChart` 와 같은 이유로 서버가 준다 */
  now: number;
  /** 화살표를 눌렀을 때 — 표가 그 거래의 행 차트를 편다 */
  onPick?: (tradeId: string) => void;
}) {
  const symbols = useMemo(() => [...new Set(trades.map((t) => t.symbol))].sort(), [trades]);
  const [picked, setPicked] = useState<string | null>(null);
  // 패널 안에서 고른 것 > 표의 종목 필터 > 거래가 가장 많은 종목.
  const symbol =
    (picked !== null && symbols.includes(picked) ? picked : null) ??
    (preferredSymbol !== null && symbols.includes(preferredSymbol) ? preferredSymbol : null) ??
    mostTradedSymbol(trades);

  const shown = useMemo(
    () =>
      trades
        .filter((t) => t.symbol === symbol)
        .slice()
        .sort((a, b) => Date.parse(a.entry_at) - Date.parse(b.entry_at)),
    [trades, symbol],
  );
  /** 손으로 고른 봉. null 이면 자동 */
  const [manualBar, setManualBar] = useState<Bar | null>(null);
  const auto = useMemo(() => overviewWindow(shown, now), [shown, now]);
  // 손으로 고른 봉이 상한을 넘으면(종목을 바꿔 구간이 길어진 경우) 자동으로 되돌린다.
  const usable = manualBar !== null && auto !== null && barFits(auto.spanMs, manualBar) ? manualBar : null;
  const range = useMemo(() => overviewWindow(shown, now, usable), [shown, now, usable]);
  const from = range?.from ?? null;
  const to = range?.to ?? null;
  const bar = range?.bar ?? null;

  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const indexRef = useRef<MarkerIndex>(new Map());
  // 클릭 처리기는 차트를 만들 때 한 번 붙는다 — 최신 onPick 은 ref 로 읽는다.
  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  /**
   * 받은 캔들은 요청 키(종목·봉·구간)와 함께 둔다.
   *
   * 종목을 바꾸면 새 캔들이 올 때까지 이전 종목의 캔들이 남는데, 키가 다르면 없는 것으로
   * 읽어 화살표가 엉뚱한 캔들 위에 찍히지 않는다 — 효과 안에서 지우는 호출이 필요 없다.
   */
  const key = symbol !== null && bar !== null ? `${symbol}|${bar}|${from}|${to}` : null;
  const [loaded, setLoaded] = useState<{ key: string; candles: Candle[] } | null>(null);
  const candles = loaded !== null && loaded.key === key ? loaded.candles : null;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /* ---------- 차트 생성 — 한 번 ---------- */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const theme = readTheme(host);
    const chart = createChart(host, {
      height: 420,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: theme.text,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: theme.grid, style: LineStyle.Dotted },
        horzLines: { color: theme.grid, style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: theme.text, width: 1, style: LineStyle.Dashed, labelBackgroundColor: theme.accent },
        horzLine: { color: theme.text, width: 1, style: LineStyle.Dashed, labelBackgroundColor: theme.accent },
      },
      rightPriceScale: { borderColor: theme.grid },
      timeScale: {
        borderColor: theme.grid,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (t: Time, type: TickMarkType) => formatTick((t as UTCTimestamp) * 1000, type),
      },
      localization: {
        locale: "ko-KR",
        timeFormatter: (t: Time) => formatKst((t as UTCTimestamp) * 1000, true),
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: theme.up,
      downColor: theme.down,
      borderUpColor: theme.up,
      borderDownColor: theme.down,
      wickUpColor: theme.up,
      wickDownColor: theme.down,
    });

    /** 마우스가 가리키는 봉의 화살표들 — 없으면 빈 배열 */
    const under = (param: MouseEventParams<Time>) =>
      param.time === undefined ? [] : (indexRef.current.get(param.time as number) ?? []);

    // 화살표 자체는 클릭 이벤트를 내지 않는다 — 클릭한 봉에 찍힌 화살표를 색인에서 되찾는다.
    // 같은 봉에 여럿이면 클릭한 가격에 가장 가까운 거래다.
    const onClick = (param: MouseEventParams<Time>) => {
      const hits = under(param);
      if (hits.length === 0 || !param.point) return;
      const price = series.coordinateToPrice(param.point.y);
      const best =
        price === null
          ? hits[0]
          : hits.reduce((a, b) => (Math.abs(b.price - price) < Math.abs(a.price - price) ? b : a));
      onPickRef.current?.(best.id);
    };
    // 화살표가 있는 봉 위에서는 손가락 커서 — 누를 수 있다는 신호.
    const onMove = (param: MouseEventParams<Time>) => {
      host.style.cursor = under(param).length > 0 ? "pointer" : "";
    };
    chart.subscribeClick(onClick);
    chart.subscribeCrosshairMove(onMove);

    chartRef.current = chart;
    seriesRef.current = series;

    const observer = new ResizeObserver(() => chart.applyOptions({ width: host.clientWidth }));
    observer.observe(host);
    chart.applyOptions({ width: host.clientWidth });

    return () => {
      observer.disconnect();
      chart.unsubscribeClick(onClick);
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  /* ---------- 캔들 로딩 — 종목·구간이 바뀔 때 ---------- */
  useEffect(() => {
    if (key === null || symbol === null || from === null || to === null || bar === null) return;
    // 좁혀진 타입은 아래 함수 선언 안까지 따라오지 않는다 — 값으로 붙잡아 둔다.
    const request = { key, url: `/api/candles?symbol=${encodeURIComponent(symbol)}&bar=${bar}&from=${from}&to=${to}` };
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(request.url);
        const json: unknown = await res.json();
        if (!res.ok) {
          const message =
            typeof json === "object" && json !== null && "error" in json
              ? String((json as { error: unknown }).error)
              : "캔들을 가져오지 못했습니다.";
          throw new Error(message);
        }
        if (!cancelled) setLoaded({ key: request.key, candles: (json as { candles: Candle[] }).candles });
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "알 수 없는 오류");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [key, symbol, from, to, bar]);

  /* ---------- 캔들·화살표 반영 ---------- */
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const host = hostRef.current;
    if (!chart || !series || !host || !candles || bar === null) return;

    const theme = readTheme(host);
    series.setData(
      candles.map((c) => ({
        time: (c.t / 1000) as UTCTimestamp,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      })),
    );

    // 화살표는 봉 눈금에 맞춰 찍는다 — 봉 사이 시각은 축에 없다.
    const onBar = (iso: string) => (Math.floor(Date.parse(iso) / BAR_MS[bar]) * BAR_MS[bar]) / 1000;
    const markers: SeriesMarker<Time>[] = [];
    const index: MarkerIndex = new Map();
    const put = (sec: number, id: string, price: number) => {
      const list = index.get(sec) ?? [];
      list.push({ id, price });
      index.set(sec, list);
    };
    for (const t of shown) {
      if (t.entry_price !== null) {
        const sec = onBar(t.entry_at);
        markers.push({ time: sec as UTCTimestamp, position: "belowBar", shape: "arrowUp", color: theme.accent, size: MARKER_SIZE });
        put(sec, t.id, t.entry_price);
      }
      if (t.exit_at !== null && t.exit_price !== null) {
        const sec = onBar(t.exit_at);
        markers.push({ time: sec as UTCTimestamp, position: "aboveBar", shape: "arrowDown", color: theme.beta, size: MARKER_SIZE });
        put(sec, t.id, t.exit_price);
      }
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    const markerApi = createSeriesMarkers(series, markers);
    indexRef.current = index;

    chart.timeScale().fitContent();
    return () => {
      markerApi.detach();
      indexRef.current = new Map();
    };
  }, [candles, shown, bar]);

  const first = shown[0] ?? null;
  const last = shown[shown.length - 1] ?? null;
  const hasOpen = shown.some((t) => t.exit_at === null);
  const SELECT =
    "rounded-lg border border-border bg-surface px-2 py-1 text-xs text-text outline-none focus:border-accent";

  return (
    <div className="space-y-2 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-dim">
        {symbols.length > 1 ? (
          <select
            aria-label="전체 차트 종목"
            className={SELECT}
            value={symbol ?? ""}
            onChange={(e) => setPicked(e.target.value)}
          >
            {symbols.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : (
          <span className="font-medium text-text">{symbol}</span>
        )}
        {/* 봉 단위 — 자동이 기본. 4,000봉을 넘기는 봉은 앞쪽 거래가 잘려 고를 수 없다. */}
        <select
          aria-label="전체 차트 봉 단위"
          className={SELECT}
          value={usable ?? "auto"}
          onChange={(e) => setManualBar(e.target.value === "auto" ? null : (e.target.value as Bar))}
        >
          <option value="auto">자동{auto ? ` (${auto.bar})` : ""}</option>
          {BARS.map((b) => (
            <option key={b} value={b} disabled={auto !== null && !barFits(auto.spanMs, b)}>
              {b}봉
            </option>
          ))}
        </select>
        {first ? (
          <span className="tnum">
            {shown.length}건 · {dateTime(first.entry_at)} ~ {hasOpen ? "보유중" : dateTime(last?.exit_at ?? null)}
          </span>
        ) : null}
        <span className="ml-auto">
          <span className="text-accent">▲</span> 진입 · <span className="text-beta">▼</span> 청산 · 누르면 행 차트
        </span>
      </div>

      <div className="relative">
        <div ref={hostRef} />
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-dim">
            캔들을 불러오는 중…
          </div>
        ) : null}
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-loss">{error}</div>
        ) : null}
        {!loading && !error && shown.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-dim">
            그릴 거래가 없습니다.
          </div>
        ) : null}
      </div>
    </div>
  );
}
