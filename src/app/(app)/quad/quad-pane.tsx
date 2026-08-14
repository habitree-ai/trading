"use client";

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  TickMarkType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  AnnotationPrimitive,
  type AnnotationDraft,
} from "@/components/chart-annotations";
import {
  annotationColors,
  formatKst,
  formatTick,
  readTheme,
} from "@/components/trade-chart";
import { pointCount } from "@/lib/annotations";
import {
  type AnnotationKind,
  type ChartPoint,
  type TradeAnnotation,
} from "@/lib/domain";
import { num } from "@/lib/format";
import { handleMovesTime, type AnnotationHit } from "@/lib/hit-test";
import { edgePointIndex } from "@/lib/position-tool";
import { BARS, BAR_MS, floorToBar, type Bar, type Candle } from "@/lib/okx";

/**
 * 한 창에 담는 봉 수.
 *
 * 4개 창이 동시에 당겨도 창당 3페이지 — OKX 한도(IP당 20회/2초) 안에 넉넉히 든다.
 * 더 길게 보려면 창을 넓히는 게 아니라 봉 단위를 키우는 화면이다.
 */
const PANE_BARS = 220;

const BAR_LABEL: Record<Bar, string> = {
  "1m": "1분",
  "5m": "5분",
  "15m": "15분",
  "30m": "30분",
  "1H": "1시간",
  "4H": "4시간",
  "1D": "일봉",
};

/** trade-chart와 같은 기준 — 이보다 짧게 끌면 그릴 뜻이 없었던 것으로 본다. */
const MIN_DRAG_PX = 4;

interface PanePoint {
  time: number;
  price: number;
}

function toChartPoint(point: PanePoint): ChartPoint {
  return { t: point.time, p: point.price };
}

/**
 * 4분할의 한 창.
 *
 * 그리기 상태(도형·초안·선택·되돌리기)는 전부 부모(quad-chart)가 들고 있고, 이 창은
 * 자기 차트의 좌표 변환과 포인터만 맡는다 — 좌표가 (시각, 가격)이라 어느 창에서
 * 그리든 나머지 창이 같은 데이터를 그대로 그린다.
 */
export function QuadPane({
  className,
  symbol,
  bar,
  onBarChange,
  now,
  resetTick,
  tool,
  asking,
  annotations,
  shown,
  draft,
  selected,
  onClickPoint,
  onDragDraft,
  onDragCommit,
  onDragCancel,
  onSelect,
  onMovePreview,
  onMoveEnd,
}: {
  /** 그리드 안 자리 지정(order 등) — 부모가 ㄹ자 배치를 만드는 데 쓴다. */
  className?: string;
  symbol: string;
  bar: Bar;
  onBarChange: (bar: Bar) => void;
  /** 지금(ms) — 서버 값에서 출발해 부모가 주기적으로 올린다. 봉이 넘어가면 새로 받는다. */
  now: number;
  /** Alt+R 카운터 — 오를 때마다 확대·이동·축 배율을 처음 보기로 되돌린다. */
  resetTick: number;
  tool: "none" | AnnotationKind;
  /** 라벨 입력 중 — 그동안 새 도형을 시작하지 않는다(trade-chart와 같은 이유). */
  asking: boolean;
  /** 저장된 도형 원본 — 집기(히트 판정)의 기준. 끌기 미리보기에는 흔들리지 않는다. */
  annotations: TradeAnnotation[];
  /** 화면에 그릴 도형 — 끌고 있는 것만 새 좌표로 갈아 끼운 배열. */
  shown: TradeAnnotation[];
  draft: AnnotationDraft | null;
  selected: string | null;
  /** 클릭형 도구(텍스트·수평선·손익)의 한 점 — 부모가 점을 모아 완성을 판단한다. */
  onClickPoint: (point: ChartPoint) => void;
  /** 드래그형 도구(추세선·박스)의 미리보기 — 네 창 모두에 점선으로 뜬다. */
  onDragDraft: (points: [ChartPoint, ChartPoint]) => void;
  onDragCommit: (points: [ChartPoint, ChartPoint]) => void;
  onDragCancel: () => void;
  onSelect: (id: string | null) => void;
  onMovePreview: (id: string, points: ChartPoint[]) => void;
  onMoveEnd: (
    id: string,
    kind: AnnotationKind,
    origin: ChartPoint[],
    points: ChartPoint[],
    movedPx: number,
  ) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const layerRef = useRef<AnnotationPrimitive | null>(null);

  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /*
   * 부모가 주는 콜백은 렌더마다 새로 만들어진다. 포인터 처리기 effect의 의존성에
   * 넣으면 초안이 바뀔 때마다(끌 때마다) 처리기를 떼었다 붙이게 되므로, ref에 담아
   * 최신 것을 읽는다.
   */
  const cbRef = useRef({ onClickPoint, onDragDraft, onDragCommit, onDragCancel, onSelect, onMovePreview, onMoveEnd });
  useEffect(() => {
    cbRef.current = { onClickPoint, onDragDraft, onDragCommit, onDragCancel, onSelect, onMovePreview, onMoveEnd };
  });

  const barSeconds = BAR_MS[bar] / 1000;

  /* ---------- 차트 생성 (한 번만) — trade-chart와 같은 설정 ---------- */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const theme = readTheme(host);
    const chart = createChart(host, {
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
        tickMarkFormatter: (t: Time, type: TickMarkType) =>
          formatTick((t as UTCTimestamp) * 1000, type),
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

    const layer = new AnnotationPrimitive(annotationColors(theme));
    series.attachPrimitive(layer);

    chartRef.current = chart;
    seriesRef.current = series;
    layerRef.current = layer;

    // 4분할은 창 크기가 화면을 따라 변한다 — 너비뿐 아니라 높이도 맞춘다.
    const apply = () =>
      chart.applyOptions({ width: host.clientWidth, height: host.clientHeight });
    const observer = new ResizeObserver(apply);
    observer.observe(host);
    apply();

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      layerRef.current = null;
    };
  }, []);

  /* ---------- 공유 도형 반영 — 어느 창에서 그리든 이 effect가 네 창을 함께 그린다 ---------- */
  useEffect(() => {
    layerRef.current?.setData(shown, draft, null);
  }, [shown, draft]);

  useEffect(() => {
    layerRef.current?.setSelected(selected);
  }, [selected]);

  /* ---------- 캔들 로딩 — 끝을 봉 눈금에 스냅해 같은 봉 안에서는 캐시를 탄다 ---------- */
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const to = floorToBar(now, bar);
      const from = to - BAR_MS[bar] * PANE_BARS;
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(
          `/api/candles?symbol=${encodeURIComponent(symbol)}&bar=${bar}&from=${from}&to=${to}`,
        );
        const json: unknown = await res.json();
        if (!res.ok) {
          const message =
            typeof json === "object" && json !== null && "error" in json
              ? String((json as { error: unknown }).error)
              : "캔들을 가져오지 못했습니다.";
          throw new Error(message);
        }
        if (!cancelled) setCandles((json as { candles: Candle[] }).candles);
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
  }, [symbol, bar, now]);

  /* ---------- 데이터 반영 — 보기(심볼·봉)가 바뀐 첫 로드에만 화면을 다시 맞춘다 ---------- */
  const fitKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || !candles) return;

    series.setData(
      candles.map((c) => ({
        time: (c.t / 1000) as UTCTimestamp,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      })),
    );

    // 봉이 넘어가 새 캔들이 붙을 때마다 fitContent 하면 보고 있던 배율이 풀린다.
    const key = `${symbol}|${bar}`;
    if (fitKeyRef.current !== key) {
      fitKeyRef.current = key;
      chart.timeScale().fitContent();
    }
  }, [candles, symbol, bar]);

  // 도구를 켠 동안에는 차트의 드래그 이동을 꺼야 도형을 그릴 수 있다.
  useEffect(() => {
    chartRef.current?.applyOptions({
      handleScroll: tool === "none",
      handleScale: tool === "none",
    });
  }, [tool]);

  /* ---------- Alt+R — 트레이딩뷰의 차트 초기화와 같은 되돌림 ---------- */
  useEffect(() => {
    // 0은 마운트 직후다 — 눌러서 오른 값에만 반응한다.
    if (resetTick === 0) return;
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    // 가격 축을 손으로 끌면 자동 배율이 꺼진 채 남는다 — 되돌릴 때 함께 켠다.
    series.priceScale().applyOptions({ autoScale: true });
    chart.timeScale().resetTimeScale();
    chart.timeScale().fitContent();
  }, [resetTick]);

  const toPoint = useCallback((x: number, y: number): PanePoint | null => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return null;

    const time = chart.timeScale().coordinateToTime(x);
    const price = series.coordinateToPrice(y);
    if (time === null || price === null) return null;
    return { time: time as number, price };
  }, []);

  /* ---------- 그리기 — trade-chart의 상태 머신에서 저장만 부모로 넘긴 판 ---------- */
  useEffect(() => {
    const host = overlayRef.current;
    if (!host || tool === "none" || asking) return;

    const kind = tool;
    const needed = pointCount(kind);
    // 두 점짜리(추세선·박스)만 끌어서 그린다. 한 점은 한 번, 세 점은 세 번 누른다.
    const dragging = needed === 2;

    let start: { point: PanePoint; x: number; y: number } | null = null;
    let last: PanePoint | null = null;

    const local = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onDown = (e: PointerEvent) => {
      const { x, y } = local(e);
      const point = toPoint(x, y);
      if (!point) return;
      e.preventDefault();

      if (!dragging) {
        // 점 모으기는 부모 몫 — 창을 옮겨 다니며 찍어도 (시각, 가격)이라 이어진다.
        cbRef.current.onClickPoint(toChartPoint(point));
        return;
      }

      start = { point, x, y };
      last = point;
      host.setPointerCapture(e.pointerId);
      const at = toChartPoint(point);
      cbRef.current.onDragDraft([at, at]);
    };

    const onMove = (e: PointerEvent) => {
      if (!start) return;
      const { x, y } = local(e);
      const point = toPoint(x, y);
      if (!point) return;
      last = point;
      cbRef.current.onDragDraft([toChartPoint(start.point), toChartPoint(point)]);
    };

    const onUp = (e: PointerEvent) => {
      if (!start) return;
      const { x, y } = local(e);
      const moved = Math.abs(x - start.x) + Math.abs(y - start.y);
      const from = start.point;
      const to = last;
      start = null;
      last = null;

      // 끌지 않고 눌렀다 뗀 것 — 길이 0짜리 도형을 남기지 않는다.
      if (moved < MIN_DRAG_PX || to === null) {
        cbRef.current.onDragCancel();
        return;
      }
      cbRef.current.onDragCommit([toChartPoint(from), toChartPoint(to)]);
    };

    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointercancel", onUp);

    return () => {
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointercancel", onUp);
    };
  }, [tool, asking, toPoint]);

  /* ---------- 이미 그린 도형 집어 옮기기 — trade-chart와 같은 캡처 순서 ---------- */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || tool !== "none") return;

    let drag: {
      hit: AnnotationHit;
      kind: AnnotationKind;
      from: ChartPoint;
      origin: ChartPoint[];
      at: { x: number; y: number };
      moved: number;
    } | null = null;
    let current: ChartPoint[] = [];

    const local = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onDown = (e: PointerEvent) => {
      const { x, y } = local(e);
      const hit = layerRef.current?.findHit(x, y);
      if (!hit) {
        cbRef.current.onSelect(null);
        return;
      }

      const target = annotations.find((a) => a.id === hit.id);
      const from = toPoint(x, y);
      if (!target || !from) return;

      drag = {
        hit,
        kind: target.kind,
        from: toChartPoint(from),
        origin: target.points,
        at: { x, y },
        moved: 0,
      };
      current = target.points;
      cbRef.current.onSelect(hit.id);

      // 차트가 이 누름을 '팬 시작'으로 받지 않게 캡처 단계에서 끊는다.
      e.stopPropagation();
      e.preventDefault();
    };

    const swallow = (e: Event) => {
      if (!drag) return;
      e.stopPropagation();
      e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      const d = drag;
      if (!d) return;

      const { x, y } = local(e);
      const at = toPoint(x, y);
      if (!at) return;

      const dt = at.time - d.from.t;
      const dp = at.price - d.from.p;
      const withTime = handleMovesTime(d.kind);
      const side = d.hit.target;

      if (side === "left" || side === "right") {
        // 가로 폭만 늘이고 줄인다 — 이 창의 봉 하나만큼은 남겨 상자가 뒤집히지 않게.
        const edge = edgePointIndex(d.origin, side);
        const others = d.origin.filter((_, i) => i !== edge).map((p) => p.t);
        const limit =
          side === "left"
            ? Math.max(...others) - barSeconds
            : Math.min(...others) + barSeconds;
        const moved = d.origin[edge].t + dt;
        const t = side === "left" ? Math.min(moved, limit) : Math.max(moved, limit);

        current = d.origin.map((point, i) => (i === edge ? { t, p: point.p } : point));
      } else {
        current = d.origin.map((point, i) => {
          if (side === "body") return { t: point.t + dt, p: point.p + dp };
          if (i !== side) return point;
          return withTime ? { t: point.t + dt, p: point.p + dp } : { t: point.t, p: point.p + dp };
        });
      }

      d.moved = Math.max(d.moved, Math.abs(x - d.at.x) + Math.abs(y - d.at.y));
      cbRef.current.onMovePreview(d.hit.id, current);
    };

    const onUp = () => {
      const d = drag;
      if (!d) return;
      drag = null;
      cbRef.current.onMoveEnd(d.hit.id, d.kind, d.origin, current, d.moved);
    };

    host.addEventListener("pointerdown", onDown, true);
    host.addEventListener("mousedown", swallow, true);
    host.addEventListener("touchstart", swallow, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    return () => {
      host.removeEventListener("pointerdown", onDown, true);
      host.removeEventListener("mousedown", swallow, true);
      host.removeEventListener("touchstart", swallow, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [tool, annotations, toPoint, barSeconds]);

  const lastClose = candles && candles.length > 0 ? candles[candles.length - 1].c : null;

  return (
    <div
      className={`flex h-72 flex-col overflow-hidden rounded-xl border border-border bg-surface md:h-auto md:min-h-0 ${className ?? ""}`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
        <select
          value={bar}
          onChange={(e) => onBarChange(e.target.value as Bar)}
          className="rounded-lg border border-border bg-surface px-2 py-1 text-xs text-text"
          aria-label="봉 단위"
        >
          {BARS.map((b) => (
            <option key={b} value={b}>
              {BAR_LABEL[b]}
            </option>
          ))}
        </select>
        {lastClose !== null ? (
          <span className="tnum ml-auto text-[11px] text-dim">종가 {num(lastClose)}</span>
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0" />

        {/* 도구를 켠 동안에만 포인터를 받는 판 — 차트의 팬·줌을 가로챈다. */}
        <div
          ref={overlayRef}
          className={`absolute inset-0 ${tool === "none" ? "pointer-events-none" : "cursor-crosshair"}`}
          style={{ touchAction: tool === "none" ? undefined : "none", zIndex: 5 }}
        />

        {error ? (
          <p className="absolute inset-0 flex items-center justify-center bg-surface/80 px-2 text-center text-xs text-loss">
            {error}
          </p>
        ) : loading && !candles ? (
          <p className="absolute inset-0 flex items-center justify-center text-xs text-dim">
            캔들 불러오는 중…
          </p>
        ) : candles && candles.length === 0 ? (
          <p className="absolute inset-0 flex items-center justify-center bg-surface/80 px-2 text-center text-xs text-dim">
            캔들이 없습니다. 종목명이 다르거나 OKX에 데이터가 없을 수 있습니다.
          </p>
        ) : null}
      </div>
    </div>
  );
}
