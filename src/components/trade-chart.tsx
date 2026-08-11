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
  type SeriesMarker,
  TickMarkType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

import { createAnnotation } from "@/app/(app)/trades/annotation-actions";
import { AnnotationList } from "@/components/annotation-list";
import {
  AnnotationPrimitive,
  type AnnotationColorMap,
  type AnnotationDraft,
} from "@/components/chart-annotations";
import { formatDuration, measure, type MeasurePoint } from "@/components/measure-tool";
import { ANNOTATION_DOT_CLASS } from "@/lib/annotations";
import {
  ANNOTATION_COLORS,
  ANNOTATION_COLOR_LABEL,
  type AnnotationColor,
  type AnnotationKind,
  type ChartPoint,
  type TradeAnnotation,
  type TradeFill,
} from "@/lib/domain";
import { num, signed } from "@/lib/format";
import { BAR_MS, pickBar, windowFor, type Bar as OkxBar, type Candle } from "@/lib/okx";

/** 화면에 노출하는 보기 — 자동은 거래 길이에 맞춰 봉을 고른다. */
type View = "auto" | "15m" | "1H" | "4H" | "1D";

const VIEW_LABEL: Record<View, string> = {
  auto: "진입~종료",
  "15m": "15분봉",
  "1H": "1시간봉",
  "4H": "4시간봉",
  "1D": "일봉",
};

/** 거래 구간 앞뒤로 붙이는 여유 봉 수 — 차트 분석이 되려면 맥락이 있어야 한다. */
const PAD_BARS = 60;

/**
 * 지금 켜 둔 도구. 한 번에 하나만 켠다 — 도구가 켜져 있으면 차트의 드래그 이동을 끄기
 * 때문에, 둘이 동시에 켜지면 어느 쪽이 포인터를 받는지 화면에서 알 수 없다.
 */
type Tool = "none" | "measure" | AnnotationKind;

const DRAW_TOOLS: { tool: AnnotationKind; label: string; hint: string }[] = [
  { tool: "text", label: "T 텍스트", hint: "차트를 눌러 그 자리에 메모를 답니다" },
  { tool: "hline", label: "— 수평선", hint: "차트를 눌러 그 가격에 가로선을 긋습니다" },
  { tool: "line", label: "／ 추세선", hint: "두 지점을 끌어 선을 긋습니다" },
  { tool: "rect", label: "□ 박스", hint: "끌어서 구간을 감쌉니다" },
];

/** 이보다 짧게 끌면 그릴 뜻이 없었던 것으로 본다 — 클릭 한 번에 길이 0짜리 선이 남지 않게. */
const MIN_DRAG_PX = 4;

function toChartPoint(point: MeasurePoint): ChartPoint {
  return { t: point.time, p: point.price };
}

/** 차트 색은 CSS 토큰에서 읽는다 — 라이트/다크 전환을 한 곳에서 관리하기 위해. */
function readTheme(el: HTMLElement) {
  const s = getComputedStyle(el);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    text: v("--text-dim") || "#8b95a3",
    grid: v("--border") || "#2a3039",
    surface: v("--surface") || "#161a21",
    up: v("--profit") || "#26c281",
    down: v("--loss") || "#f0616d",
    accent: v("--accent") || "#5b8cff",
    beta: v("--beta") || "#f5b23c",
  };
}

/** 메모 색 토큰을 실제 색으로 푼다 — 캔버스는 CSS 변수를 읽지 못한다. */
function annotationColors(theme: ReturnType<typeof readTheme>): AnnotationColorMap {
  return { accent: theme.accent, profit: theme.up, loss: theme.down, beta: theme.beta };
}

interface MeasureState {
  from: MeasurePoint;
  to: MeasurePoint;
  /** 화면 좌표 — 사각형을 그리는 데 쓴다. */
  box: { x1: number; y1: number; x2: number; y2: number };
  done: boolean;
}

export function TradeChart({
  tradeId,
  symbol,
  side,
  entryAt,
  exitAt,
  entryPrice,
  exitPrice,
  stopPrice,
  fills = [],
  annotations = [],
}: {
  /** 메모를 어느 거래에 붙일지 — 차트에서 바로 저장한다 */
  tradeId: string;
  symbol: string;
  side: "long" | "short";
  entryAt: string;
  exitAt: string | null;
  entryPrice: number | null;
  exitPrice: number | null;
  stopPrice: number | null;
  /**
   * 낱개 체결. 분할 체결이면 `entryPrice`/`exitPrice`는 가중평균가라
   * 어느 한 시점의 가격이 아니다 — 그대로 찍으면 캔들 밖으로 떠오른다.
   * 체결이 있으면 실제 좌표에 찍고, 평균가는 가로 기준선으로만 표시한다.
   */
  fills?: TradeFill[];
  /** 이 거래에 남긴 차트 메모 — 복기에서 그때 무엇을 봤는지 되짚는 자리다 */
  annotations?: TradeAnnotation[];
}) {
  const entryMs = Date.parse(entryAt);
  const exitMs = exitAt ? Date.parse(exitAt) : null;

  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const layerRef = useRef<AnnotationPrimitive | null>(null);

  const [view, setView] = useState<View>("auto");
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tool, setTool] = useState<Tool>("none");
  const [state, setState] = useState<MeasureState | null>(null);

  /** 그리는 중이거나 라벨을 기다리는 메모 — 점선으로 미리 그려진다. */
  const [pending, setPending] = useState<AnnotationDraft | null>(null);
  /** 라벨 입력창을 열어 둔 상태인가 */
  const [asking, setAsking] = useState(false);
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<AnnotationColor>("accent");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const bar: OkxBar = useMemo(
    () => (view === "auto" ? pickBar(Math.max((exitMs ?? entryMs) - entryMs, BAR_MS["1m"])) : view),
    [view, entryMs, exitMs],
  );
  const barSeconds = BAR_MS[bar] / 1000;

  /* ---------- 차트 생성 (한 번만) ---------- */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const theme = readTheme(host);
    const chart = createChart(host, {
      height: 360,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: theme.text,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: theme.grid, style: LineStyle.Dotted },
        horzLines: { color: theme.grid, style: LineStyle.Dotted },
      },
      // 트레이딩뷰 기본값 — 십자선이 봉에 붙지 않고 마우스를 그대로 따라간다.
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
        // 라이브러리는 시간축을 UTC로 찍는다. 앱 전체가 KST 기준이라 눈금도 맞춘다.
        tickMarkFormatter: (t: Time, type: TickMarkType) =>
          formatTick((t as UTCTimestamp) * 1000, type),
      },
      localization: {
        locale: "ko-KR",
        // 축과 십자선 라벨을 한국 시간으로 찍는다.
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

    // 메모는 시리즈 플러그인으로 붙인다 — 차트가 다시 그려질 때마다 좌표가 함께 따라온다.
    const layer = new AnnotationPrimitive(annotationColors(theme));
    series.attachPrimitive(layer);

    chartRef.current = chart;
    seriesRef.current = series;
    layerRef.current = layer;

    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: host.clientWidth });
    });
    observer.observe(host);
    chart.applyOptions({ width: host.clientWidth });

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      layerRef.current = null;
    };
  }, []);

  /* ---------- 메모 반영 ---------- */
  useEffect(() => {
    layerRef.current?.setData(annotations, pending);
  }, [annotations, pending]);

  /* ---------- 캔들 로딩 ---------- */
  useEffect(() => {
    let cancelled = false;

    async function load() {
      // 앞뒤 60봉 — 거래 구간이 화면 가운데 1/3에 놓인다. 직전 추세와 청산 뒤 움직임까지
      // 들어와야 "그때 시장이 어땠는지"를 읽을 수 있다.
      const { from, to } = windowFor(entryMs, exitMs, bar, PAD_BARS);
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
  }, [symbol, bar, entryMs, exitMs]);

  /* ---------- 데이터·마커·기준선 반영 ---------- */
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const host = hostRef.current;
    if (!chart || !series || !host || !candles) return;

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

    // 체결 좌표에 마커를 찍는다. 평균가는 어느 시점의 가격도 아니라 점으로 쓰지 않는다.
    const points =
      fills.length > 0
        ? fills.map((f) => ({
            role: f.role,
            ms: Date.parse(f.filled_at),
            price: f.price,
          }))
        : [
            ...(entryPrice !== null
              ? [{ role: "open" as const, ms: entryMs, price: entryPrice }]
              : []),
            ...(exitPrice !== null && exitMs !== null
              ? [{ role: "close" as const, ms: exitMs, price: exitPrice }]
              : []),
          ];

    const opens = points.filter((p) => p.role === "open");
    const closes = points.filter((p) => p.role === "close");

    const markers: SeriesMarker<Time>[] = points.map((p) => {
      const isOpen = p.role === "open";
      const group = isOpen ? opens : closes;
      const order = group.indexOf(p) + 1;
      return {
        time: (Math.floor(p.ms / BAR_MS[bar]) * BAR_MS[bar] / 1000) as UTCTimestamp,
        position: isOpen ? "belowBar" : "aboveBar",
        shape: isOpen ? "arrowUp" : "arrowDown",
        color: isOpen ? theme.accent : theme.beta,
        text: `${isOpen ? "진입" : "청산"}${group.length > 1 ? ` ${order}` : ""} ${num(p.price)}`,
      };
    });
    const markerApi = createSeriesMarkers(series, markers);

    const lines = [
      stopPrice !== null && { price: stopPrice, color: theme.down, title: "손절" },
      entryPrice !== null && { price: entryPrice, color: theme.accent, title: fills.length > 2 ? "평균진입" : "진입" },
      exitPrice !== null && { price: exitPrice, color: theme.beta, title: fills.length > 2 ? "평균청산" : "청산" },
    ]
      .filter((l): l is { price: number; color: string; title: string } => Boolean(l))
      .map((l) =>
        series.createPriceLine({
          price: l.price,
          color: l.color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: l.title,
        }),
      );

    chart.timeScale().fitContent();

    return () => {
      markerApi.detach();
      for (const line of lines) series.removePriceLine(line);
    };
  }, [candles, fills, entryPrice, exitPrice, stopPrice, entryMs, exitMs, bar]);

  /* ---------- 측정(자)·메모 도구 ---------- */
  const toPoint = useCallback((x: number, y: number): MeasurePoint | null => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return null;

    const time = chart.timeScale().coordinateToTime(x);
    const price = series.coordinateToPrice(y);
    if (time === null || price === null) return null;
    return { time: time as number, price };
  }, []);

  useEffect(() => {
    // 차트 캔버스는 포인터 이벤트를 자기가 붙잡고 위로 올려보내지 않는다.
    // 도구를 켠 동안에만 투명한 판을 덮고 거기서 드래그를 받는다.
    const host = overlayRef.current;
    // 라벨을 적는 중에는 새 도형을 시작하지 않는다 — 적던 것이 지워져 버린다.
    if (!host || tool === "none" || asking) return;

    // 측정은 결과를 화면에만 남기고, 나머지는 메모로 저장한다.
    const kind = tool === "measure" ? null : tool;
    const dragging = kind === null || kind === "line" || kind === "rect";

    let start: { point: MeasurePoint; x: number; y: number } | null = null;

    const local = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const ask = () => {
      setLabel("");
      setNoteError(null);
      setAsking(true);
    };

    const onDown = (e: PointerEvent) => {
      const { x, y } = local(e);
      const point = toPoint(x, y);
      if (!point) return;
      e.preventDefault();

      // 한 점짜리 메모 — 누른 자리에서 바로 라벨을 묻는다.
      if (kind !== null && !dragging) {
        setPending({ kind, points: [toChartPoint(point)], text: null, color });
        ask();
        return;
      }

      start = { point, x, y };
      host.setPointerCapture(e.pointerId);

      if (kind === null) {
        setState({ from: point, to: point, box: { x1: x, y1: y, x2: x, y2: y }, done: false });
      } else {
        const at = toChartPoint(point);
        setPending({ kind, points: [at, at], text: null, color });
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!start) return;
      const { x, y } = local(e);
      const point = toPoint(x, y);
      if (!point) return;

      if (kind === null) {
        setState({
          from: start.point,
          to: point,
          box: { x1: start.x, y1: start.y, x2: x, y2: y },
          done: false,
        });
      } else {
        setPending({
          kind,
          points: [toChartPoint(start.point), toChartPoint(point)],
          text: null,
          color,
        });
      }
    };

    const onUp = (e: PointerEvent) => {
      if (!start) return;
      const { x, y } = local(e);
      const moved = Math.abs(x - start.x) + Math.abs(y - start.y);
      start = null;

      if (kind === null) {
        // 손을 떼면 결과를 남긴다 — 트레이딩뷰처럼 다시 끌면 새로 잰다.
        setState((s) => (s ? { ...s, done: true } : s));
        return;
      }
      // 끌지 않고 눌렀다 뗀 것 — 길이 0짜리 도형을 남기지 않는다.
      if (moved < MIN_DRAG_PX) {
        setPending(null);
        return;
      }
      ask();
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
  }, [tool, asking, color, toPoint]);

  // 도구를 켠 동안에는 차트의 드래그 이동을 꺼야 도형을 그릴 수 있다.
  useEffect(() => {
    chartRef.current?.applyOptions({
      handleScroll: tool === "none",
      handleScale: tool === "none",
    });
  }, [tool]);

  /** 도구를 갈아 끼운다 — 같은 것을 다시 누르면 끈다. 그리던 것은 버린다. */
  const pickTool = (next: Tool) => {
    setTool((current) => (current === next ? "none" : next));
    setState(null);
    setPending(null);
    setAsking(false);
    setNoteError(null);
  };

  const cancelDraft = () => {
    setPending(null);
    setAsking(false);
    setNoteError(null);
  };

  const saveDraft = () => {
    if (!pending) return;
    const text = label.trim();
    if (pending.kind === "text" && text === "") {
      setNoteError("메모 내용을 입력해 주세요.");
      return;
    }

    startSaving(async () => {
      const result = await createAnnotation({
        tradeId,
        kind: pending.kind,
        points: pending.points,
        text: text === "" ? null : text,
        color: pending.color,
      });
      if (result.error) {
        setNoteError(result.error);
        return;
      }
      cancelDraft();
    });
  };

  const result = state ? measure(state.from, state.to, barSeconds) : null;
  const held =
    exitPrice !== null && entryPrice !== null
      ? ((exitPrice - entryPrice) / entryPrice) * (side === "long" ? 1 : -1)
      : null;

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-medium">
          당시 차트 <span className="font-normal text-dim">— {symbol}-USDT 무기한 · OKX</span>
        </h2>

        <div className="ml-auto flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => pickTool("measure")}
            className={`rounded-lg border px-2.5 py-1 text-xs ${
              tool === "measure"
                ? "border-accent bg-accent text-white"
                : "border-border text-dim hover:text-text"
            }`}
            title="드래그로 두 지점 사이의 가격·비율·기간을 잽니다"
          >
            📏 측정
          </button>
          <span className="mx-1 w-px self-stretch bg-border" aria-hidden />
          {DRAW_TOOLS.map((t) => (
            <button
              key={t.tool}
              type="button"
              onClick={() => pickTool(t.tool)}
              className={`rounded-lg border px-2.5 py-1 text-xs ${
                tool === t.tool
                  ? "border-accent bg-accent text-white"
                  : "border-border text-dim hover:text-text"
              }`}
              title={t.hint}
            >
              {t.label}
            </button>
          ))}
          {/* 색은 메모 도구를 켰을 때만 고른다 — 측정에는 쓰이지 않는다. */}
          {tool !== "none" && tool !== "measure" ? (
            <span className="ml-1 flex items-center gap-1">
              {ANNOTATION_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={ANNOTATION_COLOR_LABEL[c]}
                  aria-pressed={color === c}
                  title={ANNOTATION_COLOR_LABEL[c]}
                  onClick={() => setColor(c)}
                  className={`size-4 rounded-full ${ANNOTATION_DOT_CLASS[c]} ${
                    color === c ? "ring-2 ring-text ring-offset-1 ring-offset-surface" : ""
                  }`}
                />
              ))}
            </span>
          ) : null}
          <span className="mx-1 w-px self-stretch bg-border" aria-hidden />
          {(Object.keys(VIEW_LABEL) as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`rounded-lg border px-2.5 py-1 text-xs ${
                view === v ? "border-accent text-accent" : "border-border text-dim hover:text-text"
              }`}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
      </div>

      <p className="mt-1 text-xs text-dim">
        {view === "auto" ? `${bar} 봉 자동 선택 · ` : ""}
        앞뒤 {PAD_BARS}봉 ·{" "}
        진입 {num(entryPrice)} → 청산 {exitPrice === null ? "—" : num(exitPrice)}
        {held !== null ? (
          <span className={held >= 0 ? "text-profit" : "text-loss"}> ({signed(held * 100, 2)}%)</span>
        ) : null}
      </p>

      <div className="relative mt-3">
        <div ref={hostRef} className="w-full" />

        {/*
          측정 중에만 덮는 판 — 차트가 드래그를 가로채지 않도록 이벤트를 먼저 받는다.
          라이브러리가 캔버스를 자체 z-index로 얹으므로 그 위로 올려야 포인터가 닿는다.
        */}
        <div
          ref={overlayRef}
          className={`absolute inset-0 ${tool === "none" ? "pointer-events-none" : "cursor-crosshair"}`}
          style={{ touchAction: tool === "none" ? undefined : "none", zIndex: 5 }}
        />

        {/* 라벨 입력 — 차트 아래쪽에 고정한다. 누른 자리에 띄우면 가장자리에서 잘린다. */}
        {asking && pending ? (
          <div
            className="absolute inset-x-2 bottom-2 rounded-lg border border-border bg-surface p-2 shadow-lg"
            style={{ zIndex: 7 }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveDraft();
                  if (e.key === "Escape") cancelDraft();
                }}
                placeholder={
                  pending.kind === "text" ? "메모 내용" : "라벨 — 없어도 됩니다"
                }
                className="min-w-40 flex-1 rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent"
              />
              <button
                type="button"
                disabled={saving}
                onClick={saveDraft}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {saving ? "저장 중…" : "저장"}
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={cancelDraft}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-dim disabled:opacity-50"
              >
                취소
              </button>
            </div>
            {noteError ? <p className="mt-1 text-[11px] text-loss">{noteError}</p> : null}
          </div>
        ) : null}

        {/* 측정 사각형 — 차트 위에 겹쳐 그린다. 포인터 이벤트는 아래로 통과시킨다. */}
        {state && result ? (
          <div
            className="pointer-events-none absolute rounded-sm border"
            style={{
              zIndex: 6,
              left: Math.min(state.box.x1, state.box.x2),
              top: Math.min(state.box.y1, state.box.y2),
              width: Math.abs(state.box.x2 - state.box.x1),
              height: Math.abs(state.box.y2 - state.box.y1),
              borderColor: result.up ? "var(--profit)" : "var(--loss)",
              background: result.up
                ? "color-mix(in srgb, var(--profit) 14%, transparent)"
                : "color-mix(in srgb, var(--loss) 14%, transparent)",
            }}
          >
            <div
              className="tnum absolute left-1/2 -translate-x-1/2 rounded-md px-2 py-1 text-center text-[11px] whitespace-nowrap text-white shadow"
              style={{
                top: state.box.y2 >= state.box.y1 ? "calc(100% + 6px)" : undefined,
                bottom: state.box.y2 < state.box.y1 ? "calc(100% + 6px)" : undefined,
                background: result.up ? "var(--profit)" : "var(--loss)",
              }}
            >
              <div className="font-semibold">
                {signed(result.priceDelta)} (
                {result.pctDelta === null ? "—" : signed(result.pctDelta * 100, 2) + "%"})
              </div>
              <div className="opacity-90">
                {formatDuration(result.durationMs)} · {result.bars}봉
              </div>
            </div>
          </div>
        ) : null}

        {error ? (
          <p className="absolute inset-0 flex items-center justify-center bg-surface/80 text-xs text-loss">
            {error}
          </p>
        ) : loading && !candles ? (
          <p className="absolute inset-0 flex items-center justify-center text-xs text-dim">
            캔들 불러오는 중…
          </p>
        ) : candles && candles.length === 0 ? (
          <p className="absolute inset-0 flex items-center justify-center bg-surface/80 text-center text-xs text-dim">
            이 구간의 캔들이 없습니다. OKX에 해당 기간 데이터가 없거나 종목명이 다를 수 있습니다.
          </p>
        ) : null}
      </div>

      <p className="mt-2 text-[11px] text-dim">
        {tool === "measure" ? (
          <b className="text-accent">
            측정 중 — 차트를 끌어 두 지점 사이의 가격·비율·기간을 재세요. 다시 누르면 끕니다.
          </b>
        ) : tool !== "none" ? (
          <b className="text-accent">
            {DRAW_TOOLS.find((t) => t.tool === tool)?.hint} — 메모는 (시각, 가격)에 붙어 봉을
            바꿔도 같은 자리를 가리킵니다. 다시 누르면 끕니다.
          </b>
        ) : (
          <>
            휠로 확대·축소, 드래그로 이동, 축을 끌면 배율이 바뀝니다. ▲ 진입 · ▼ 청산 지점에
            가격을 적었고, 가로 점선은 손절가와 평균 체결가입니다.
          </>
        )}
      </p>

      <AnnotationList annotations={annotations} />
    </section>
  );
}

const KST_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** 시간축 눈금 — 라이브러리가 알려준 눈금 종류에 맞춰 KST로 찍는다. */
function formatTick(ms: number, type: TickMarkType): string {
  const p: Record<string, string> = {};
  for (const part of KST_PARTS.formatToParts(new Date(ms))) p[part.type] = part.value;
  if (p.hour === "24") p.hour = "00";

  switch (type) {
    case TickMarkType.Year:
      return p.year;
    case TickMarkType.Month:
      return `${Number(p.month)}월`;
    case TickMarkType.DayOfMonth:
      return `${Number(p.day)}일`;
    case TickMarkType.TimeWithSeconds:
      return `${p.hour}:${p.minute}:${p.second}`;
    default:
      return `${p.hour}:${p.minute}`;
  }
}

const KST_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Seoul",
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 축·십자선 라벨은 서버 렌더링과 무관하지만, 표기를 앱 전체와 맞춘다. */
function formatKst(ms: number, withTime: boolean): string {
  const p: Record<string, string> = {};
  for (const part of KST_FMT.formatToParts(new Date(ms))) p[part.type] = part.value;
  if (p.hour === "24") p.hour = "00";
  const date = `${p.year}.${p.month}.${p.day}`;
  return withTime ? `${date} ${p.hour}:${p.minute}` : date;
}
