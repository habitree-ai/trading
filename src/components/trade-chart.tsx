"use client";

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
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

import {
  createAnnotation,
  deleteAnnotation,
  restoreAnnotation,
  setAnnotationLocked,
  updateAnnotationPoints,
  updateAnnotationStyle,
  updateAnnotationText,
} from "@/app/(app)/trades/annotation-actions";
import { AnnotationList } from "@/components/annotation-list";
import {
  AnnotationPrimitive,
  type AnnotationColorMap,
  type AnnotationDraft,
} from "@/components/chart-annotations";
import { formatDuration, measure, type MeasurePoint } from "@/components/measure-tool";
import {
  describeUndo,
  pushChange,
  type AnnotationChange,
} from "@/lib/annotation-history";
import { ANNOTATION_DOT_CLASS, pointCount } from "@/lib/annotations";
import {
  ANNOTATION_COLORS,
  ANNOTATION_COLOR_LABEL,
  ANNOTATION_KIND_LABEL,
  ANNOTATION_LINE_STYLES,
  ANNOTATION_LINE_STYLE_LABEL,
  isPositionKind,
  type AnnotationColor,
  type AnnotationKind,
  type AnnotationLineStyle,
  type ChartPoint,
  type TradeAnnotation,
  type TradeFill,
} from "@/lib/domain";
import { num, signed } from "@/lib/format";
import { handleMovesTime, type AnnotationHit } from "@/lib/hit-test";
import { rsi } from "@/lib/indicators";
import { formatLevel, levelFields, parseLevel } from "@/lib/annotation-levels";
import { edgePointIndex, positionProblemOf } from "@/lib/position-tool";
import {
  BAR_MS,
  floorToBar,
  pickBar,
  windowFor,
  type Bar as OkxBar,
  type Candle,
} from "@/lib/okx";

/** 화면에 노출하는 보기 — 자동은 거래 길이에 맞춰 봉을 고른다. */
type View = "auto" | "15m" | "1H" | "4H" | "1D";

const VIEW_LABEL: Record<View, string> = {
  auto: "진입~종료",
  "15m": "15분봉",
  "1H": "1시간봉",
  "4H": "4시간봉",
  "1D": "일봉",
};

/** 아직 들고 있는 거래에서는 자동 보기의 끝이 청산이 아니라 지금이다. */
const OPEN_VIEW_LABEL: Record<View, string> = { ...VIEW_LABEL, auto: "진입~현재" };

/** 거래 구간 앞뒤로 붙이는 여유 봉 수 — 차트 분석이 되려면 맥락이 있어야 한다. */
const PAD_BARS = 60;

/**
 * 한 화면에 담는 봉을 기본 보기의 몇 배로 넓힐지.
 *
 * 거래 구간은 사실이라 늘릴 수 없다 — 늘어나는 몫은 전부 앞뒤 여유로 간다.
 * 4분할 차트의 `PANE_BARS`와 같은 배율이라 두 화면이 비슷한 폭을 보여 준다.
 */
const VIEW_SCALE = 2.5;

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
  { tool: "long", label: "▲ 롱 손익", hint: "진입 → 손절 → 목표를 차례로 누릅니다" },
  { tool: "short", label: "▼ 숏 손익", hint: "진입 → 손절 → 목표를 차례로 누릅니다" },
];

/** 손익 툴에서 지금 무엇을 찍을 차례인지 — 찍은 점의 수로 정해진다. */
const POSITION_STEPS = ["진입가를 누르세요", "손절가를 누르세요", "목표가를 누르세요"];

/** 스타일 편집에서 고를 수 있는 선 굵기(px) — 4분할 차트와 같은 선택지. */
const STYLE_WIDTHS = [1, 2, 3];

/** 스타일을 고칠 수 있는 종류 — 손익 툴은 색이 뜻(이익·손실)이라 제외한다. */
function isStylableKind(kind: AnnotationKind): boolean {
  return kind === "hline" || kind === "line" || kind === "rect";
}

/** 이보다 짧게 끌면 그릴 뜻이 없었던 것으로 본다 — 클릭 한 번에 길이 0짜리 선이 남지 않게. */
const MIN_DRAG_PX = 4;

function toChartPoint(point: MeasurePoint): ChartPoint {
  return { t: point.time, p: point.price };
}

/** 끌고 있는 메모 — 놓는 순간 저장한다. */
interface DragState {
  hit: AnnotationHit;
  kind: AnnotationKind;
  /** 끌기 시작한 자리의 차트 좌표 — 여기서부터의 차이를 좌표에 얹는다 */
  from: ChartPoint;
  /** 끌기 전 좌표 — 어긋난 자리에서 놓으면 여기로 되돌린다 */
  origin: ChartPoint[];
  /** 누른 자리의 화면 좌표 — 끌었는지 눌렀는지를 픽셀로 가른다 */
  at: { x: number; y: number };
  moved: number;
}

/** 끈 것으로 볼 최소 거리(px) — 손이 조금 떨렸다고 자리가 바뀌면 곤란하다. */
const MIN_MOVE_PX = 3;

/** 차트 색은 CSS 토큰에서 읽는다 — 라이트/다크 전환을 한 곳에서 관리하기 위해. */
export function readTheme(el: HTMLElement) {
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
export function annotationColors(theme: ReturnType<typeof readTheme>): AnnotationColorMap {
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
  targetPrice = null,
  notional = null,
  now,
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
  /** 목표가(TP1) — 시스템 거래는 진입 주문에 걸었던 값이 그대로 온다 */
  targetPrice?: number | null;
  /** 시트의 `투입` — 손익 툴이 비율을 금액으로 옮기는 데 쓴다. 없으면 비율만 나온다 */
  notional?: number | null;
  /**
   * 페이지를 그린 시각(ms) — 아직 들고 있는 거래를 어디까지 그릴지 정한다.
   *
   * 서버가 내려보낸다. 브라우저에서 읽으면 서버가 그린 화면과 값이 갈리고, 렌더 중에
   * 시계를 읽는 것 자체가 순수하지 않다. 그 사이 흐른 시간은 앞뒤 여유 봉이 덮는다.
   */
  now: number;
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
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const rsiRef = useRef<ISeriesApi<"Line"> | null>(null);
  const layerRef = useRef<AnnotationPrimitive | null>(null);

  const [view, setView] = useState<View>("auto");
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tool, setTool] = useState<Tool>("none");
  const [state, setState] = useState<MeasureState | null>(null);

  /** 그리는 중이거나 라벨을 기다리는 메모 — 점선으로 미리 그려진다. */
  const [pending, setPending] = useState<AnnotationDraft | null>(null);
  /**
   * 손익 툴처럼 여러 번 눌러 완성하는 도형의 중간 좌표.
   *
   * `pending`을 보고 이어 붙이면 될 것 같지만, 포인터 처리기는 도구가 바뀔 때만 다시
   * 붙는다 — 그 안에서 읽는 `pending`은 첫 점에서 멈춰 있는 값이다.
   */
  const stepsRef = useRef<ChartPoint[]>([]);
  /** 라벨 입력창을 열어 둔 상태인가 */
  const [asking, setAsking] = useState(false);
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<AnnotationColor>("accent");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  /** 끌어서 옮기는 중인 메모의 새 좌표 — 놓을 때까지 화면에만 반영한다. */
  const [moving, setMoving] = useState<{ id: string; points: ChartPoint[] } | null>(null);
  /** 눌러서 고르는 중인 메모 — 라벨을 고치거나 지울 수 있다. */
  const [editing, setEditing] = useState<TradeAnnotation | null>(null);
  /**
   * 골라 둔 메모의 id.
   *
   * `editing`과 나눠 둔 이유: 팝오버를 닫아도 고른 상태는 남아야 Del 로 지울 수 있고,
   * 끌어서 옮긴 뒤에는 팝오버 없이 고른 표시만 남아야 한다.
   */
  const [selected, setSelected] = useState<string | null>(null);

  /**
   * 되돌리기 기록 — 화면에만 산다.
   *
   * 새로고침하면 사라진다. 그리다 만 선을 무르는 데 서버 이력표까지 둘 이유가 없고,
   * 트레이딩뷰의 되돌리기도 같은 범위다.
   */
  const [history, setHistory] = useState<AnnotationChange[]>([]);
  const record = (change: AnnotationChange) => {
    setHistory((stack) => pushChange(stack, change));
    setNotice(null);
  };
  /** 되돌린 뒤 남기는 한 줄 — 눌렀는데 아무 말이 없으면 먹었는지 알 수 없다. */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * 더블클릭으로 연 수치 입력 — 값을 손이 아니라 숫자로 넣는다.
   *
   * 끌어서 맞추는 건 눈으로 대충 놓는 일이다. 전고점이나 라운드 넘버처럼 "63,500
   * 정확히"가 필요한 자리에서는 픽셀로 맞출 수가 없다.
   */
  const [levels, setLevels] = useState<{ target: TradeAnnotation; values: string[] } | null>(
    null,
  );

  const openLevels = (target: TradeAnnotation) => {
    setLevels({
      target,
      values: levelFields(target.kind).map((f) => formatLevel(target.points[f.index]?.p)),
    });
    setAsking(false);
    setEditing(null);
    setNoteError(null);
  };

  /**
   * 화면에 그릴 메모 — 끌고 있는 것만 새 좌표로 갈아 끼운다.
   *
   * 저장은 손을 뗄 때 한 번만 한다. 끌 때마다 서버에 보내면 한 번 옮기는 데 수십 번의
   * 왕복이 생기고, 그때마다 페이지가 다시 그려져 끌던 손이 끊긴다.
   */
  const shown = useMemo(
    () =>
      moving === null
        ? annotations
        : annotations.map((a) => (a.id === moving.id ? { ...a, points: moving.points } : a)),
    [annotations, moving],
  );

  /** 차트가 어디까지 보여 줄지 — 청산된 거래는 청산 시각, 들고 있는 거래는 지금. */
  const endMs = exitMs ?? now;

  const bar: OkxBar = useMemo(
    () => (view === "auto" ? pickBar(Math.max(endMs - entryMs, BAR_MS["1m"])) : view),
    [view, entryMs, endMs],
  );
  const barSeconds = BAR_MS[bar] / 1000;

  /**
   * 앞뒤 여유 봉 — 거래 구간까지 합쳐 화면에 담기는 봉이 기본 보기의 `VIEW_SCALE`배가
   * 되도록 정한다. 거래가 길수록 여유도 함께 늘어야 배율이 유지된다.
   */
  const padBars = useMemo(() => {
    const tradeBars = Math.max(1, Math.ceil((endMs - entryMs) / BAR_MS[bar]));
    return Math.round(((tradeBars + PAD_BARS * 2) * VIEW_SCALE - tradeBars) / 2);
  }, [entryMs, endMs, bar]);

  /* ---------- 차트 생성 (한 번만) ---------- */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const theme = readTheme(host);
    const chart = createChart(host, {
      // RSI 패널이 아래에 붙는다 — 늘리지 않으면 캔들 영역이 그만큼 줄어든다.
      height: 480,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: theme.text,
        attributionLogo: false,
        panes: { separatorColor: theme.grid, enableResize: false },
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

    // 거래량 — 본 창 아래쪽에 겹친다. 축은 따로 두되 라벨은 숨긴다(트레이딩뷰 기본과 같다).
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    // RSI(14) — 0~100 지표라 가격 축을 같이 못 쓴다. 아래 패널에 따로 그린다.
    const rsiSeries = chart.addSeries(
      LineSeries,
      {
        color: theme.accent,
        lineWidth: 1,
        priceLineVisible: false,
        priceFormat: { type: "price", precision: 1, minMove: 0.1 },
        // 축을 0~100에 고정한다 — 값에 맞춰 배율이 줄면 30·70 기준선이 화면 밖으로 나간다.
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      },
      1,
    );
    // 30·70 기준선 — 과매수·과매도를 눈으로 가르는 자리다.
    for (const level of [70, 30]) {
      rsiSeries.createPriceLine({
        price: level,
        color: theme.grid,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
      });
    }
    rsiSeries.priceScale().applyOptions({ borderColor: theme.grid });
    chart.panes()[0]?.setStretchFactor(3);
    chart.panes()[1]?.setStretchFactor(1);

    // 메모는 시리즈 플러그인으로 붙인다 — 차트가 다시 그려질 때마다 좌표가 함께 따라온다.
    const layer = new AnnotationPrimitive(annotationColors(theme));
    series.attachPrimitive(layer);

    chartRef.current = chart;
    seriesRef.current = series;
    volumeRef.current = volume;
    rsiRef.current = rsiSeries;
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
      volumeRef.current = null;
      rsiRef.current = null;
      layerRef.current = null;
    };
  }, []);

  /* ---------- 메모 반영 ---------- */
  useEffect(() => {
    layerRef.current?.setData(shown, pending, notional);
  }, [shown, pending, notional]);

  useEffect(() => {
    layerRef.current?.setSelected(selected);
  }, [selected]);

  /* ---------- 캔들 로딩 ---------- */
  useEffect(() => {
    let cancelled = false;

    async function load(end: number) {
      /*
       * 앞뒤 여유(padBars) — 거래 구간이 화면 가운데에 놓인다. 직전 추세와 청산 뒤
       * 움직임까지 들어와야 "그때 시장이 어땠는지"를 읽을 수 있다.
       *
       * 들고 있는 거래의 끝은 봉 눈금에 맞춰 뭉뚱그린다 — 밀리초 그대로 쓰면
       * 새로고침할 때마다 페이지 커서가 달라져 캐시가 통째로 빗나간다.
       */
      const { from, to } = windowFor(
        entryMs,
        exitMs === null ? floorToBar(end, bar) : end,
        bar,
        padBars,
      );
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

    void load(endMs);
    return () => {
      cancelled = true;
    };
  }, [symbol, bar, entryMs, exitMs, endMs, padBars]);

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

    // 거래량은 캔들 방향 색으로, 반투명하게 — 캔들을 가리지 않아야 한다.
    volumeRef.current?.setData(
      candles.map((c) => ({
        time: (c.t / 1000) as UTCTimestamp,
        value: c.v,
        color: (c.c >= c.o ? theme.up : theme.down) + "66",
      })),
    );

    // RSI — 앞 14봉은 재료가 모자라 비어 있다. 선이 그만큼 늦게 시작하는 게 맞다.
    const rsiValues = rsi(candles.map((c) => c.c));
    const rsiData: { time: UTCTimestamp; value: number }[] = [];
    candles.forEach((c, i) => {
      const value = rsiValues[i];
      if (value !== null) rsiData.push({ time: (c.t / 1000) as UTCTimestamp, value });
    });
    rsiRef.current?.setData(rsiData);

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
      targetPrice !== null && { price: targetPrice, color: theme.up, title: "목표" },
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
  }, [candles, fills, entryPrice, exitPrice, stopPrice, targetPrice, entryMs, exitMs, bar]);

  /* ---------- 측정(자)·메모 도구 ---------- */
  const toPoint = useCallback((x: number, y: number): MeasurePoint | null => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return null;

    // RSI 패널 위의 좌표는 본 창의 가격이 아니다 — 그대로 넘기면 축 밖 가격으로 풀린다.
    if (y > chart.paneSize(0).height) return null;

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
    // 두 점짜리(추세선·박스)만 끌어서 그린다. 한 점은 한 번, 세 점은 세 번 누른다.
    const needed = kind === null ? 2 : pointCount(kind);
    const dragging = needed === 2;

    let start: { point: MeasurePoint; x: number; y: number } | null = null;

    const local = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const ask = (problem: string | null) => {
      setLabel("");
      setNoteError(problem);
      setAsking(true);
    };

    const onDown = (e: PointerEvent) => {
      const { x, y } = local(e);
      const point = toPoint(x, y);
      if (!point) return;
      e.preventDefault();

      // 눌러서 완성하는 도형 — 필요한 점이 다 모이면 라벨을 묻는다.
      if (kind !== null && !dragging) {
        const placed = [...stepsRef.current, toChartPoint(point)];
        stepsRef.current = placed;
        setPending({ kind, points: placed, text: null, color });
        if (placed.length >= needed) {
          ask(isPositionKind(kind) ? positionProblemOf(kind, placed) : null);
        }
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
      ask(null);
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

  /* ---------- 이미 그린 메모 집어 옮기기 ---------- */
  useEffect(() => {
    const host = hostRef.current;
    // 도구를 켠 동안에는 위를 덮은 판이 포인터를 받는다 — 여기서 또 잡으면 서로 다툰다.
    if (!host || tool !== "none") return;

    let drag: DragState | null = null;
    let current: ChartPoint[] = [];

    const local = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onDown = (e: PointerEvent) => {
      const { x, y } = local(e);
      // RSI 패널 위에는 도형이 없다 — 가시 범위 밖 가격이 그 영역으로 투영돼 집히는 것을 막는다.
      const hit =
        y > (chartRef.current?.paneSize(0).height ?? y)
          ? undefined
          : layerRef.current?.findHit(x, y);
      if (!hit) {
        // 빈 곳을 누르면 고르던 것을 놓는다.
        setSelected(null);
        setEditing(null);
        setNoteError(null);
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
      // 집는 순간 고른 것으로 본다 — 끌든 안 끌든 무엇을 잡았는지 화면에 드러난다.
      setSelected(hit.id);

      /*
       * 차트가 이 누름을 '팬 시작'으로 받지 않게 캡처 단계에서 끊는다.
       *
       * 라이브러리는 캔버스에서 `mousedown`을 듣는다. 캔버스보다 위(컨테이너)에서
       * 캡처로 받으면 우리가 먼저 보고, 메모를 집은 경우에만 그 아래로 내려보내지
       * 않는다 — 메모가 없는 자리에서는 그대로 통과해 밀기·확대가 살아 있다.
       */
      e.stopPropagation();
      e.preventDefault();
    };

    // 포인터 이벤트를 막아도 브라우저에 따라 호환용 마우스 이벤트가 따라온다.
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
        /*
         * 가로 폭만 늘이고 줄인다 — 값(가격)은 그대로 둔다.
         *
         * 반대편 너머로 끌면 상자가 뒤집히므로 봉 하나만큼은 남겨 둔다.
         */
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
      setMoving({ id: d.hit.id, points: current });
    };

    const onUp = () => {
      const d = drag;
      if (!d) return;
      drag = null;

      // 거의 안 움직였으면 옮긴 게 아니라 고른 것이다 — 고칠 자리를 연다.
      if (d.moved < MIN_MOVE_PX) {
        setMoving(null);
        const target = annotations.find((a) => a.id === d.hit.id);
        if (!target) return;
        setEditing(target);
        setLabel(target.text ?? "");
        setNoteError(null);
        return;
      }

      // 옮긴 자리가 방향과 어긋나면 되돌린다 — 뒤집힌 손익비를 남기지 않는다.
      if (isPositionKind(d.kind)) {
        const problem = positionProblemOf(d.kind, current);
        if (problem !== null) {
          setMoving(null);
          setNoteError(problem);
          return;
        }
      }

      const points = current;
      startSaving(async () => {
        const result = await updateAnnotationPoints(d.hit.id, points);
        if (result.error) {
          setNoteError(result.error);
        } else {
          record({ type: "move", id: d.hit.id, kind: d.kind, before: d.origin });
        }
        setMoving(null);
      });
    };

    // 더블클릭 — 숫자로 값을 넣는 자리를 연다.
    const onDouble = (e: MouseEvent) => {
      const r = host.getBoundingClientRect();
      const y = e.clientY - r.top;
      if (y > (chartRef.current?.paneSize(0).height ?? y)) return;
      const hit = layerRef.current?.findHit(e.clientX - r.left, y);
      if (!hit) return;

      const target = annotations.find((a) => a.id === hit.id);
      if (!target) return;

      e.stopPropagation();
      e.preventDefault();
      setSelected(hit.id);
      openLevels(target);
    };

    host.addEventListener("pointerdown", onDown, true);
    host.addEventListener("dblclick", onDouble, true);
    host.addEventListener("mousedown", swallow, true);
    host.addEventListener("touchstart", swallow, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    return () => {
      host.removeEventListener("pointerdown", onDown, true);
      host.removeEventListener("dblclick", onDouble, true);
      host.removeEventListener("mousedown", swallow, true);
      host.removeEventListener("touchstart", swallow, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [tool, annotations, toPoint]);

  /**
   * 마지막 손질을 무른다.
   *
   * 되돌리기는 "그 전 값으로 되돌리는" 서버 호출 한 번이다. 지운 메모만 예외로,
   * 지워진 id를 그대로 되쓴다 — 새 id로 되살리면 그 메모를 가리키던 앞선 기록들이
   * 통째로 허공을 짚는다.
   */
  const undo = (): boolean => {
    const last = history[history.length - 1];
    if (last === undefined || saving) return false;

    setHistory((stack) => stack.slice(0, -1));
    setNoteError(null);

    startSaving(async () => {
      const result = await (last.type === "create"
        ? deleteAnnotation(last.id)
        : last.type === "delete"
          ? restoreAnnotation(last.before)
          : last.type === "move"
            ? updateAnnotationPoints(last.id, last.before)
            : last.type === "text"
              ? updateAnnotationText(last.id, last.before ?? "")
              : setAnnotationLocked(last.id, last.before));

      if (result.error) {
        setNoteError(result.error);
        return;
      }
      setNotice(describeUndo(last));
      setEditing(null);
      if (last.type === "create") setSelected(null);
    });
    return true;
  };

  /*
   * 최신 `undo`를 ref 에 담아 두고 처리기는 한 번만 붙인다.
   *
   * 기록이 바뀔 때마다 처리기를 다시 붙여도 되지만, 끄는 동안에는 프레임마다 다시
   * 그려지므로 그때마다 window 처리기를 떼었다 붙이게 된다.
   */
  const undoRef = useRef(undo);
  useEffect(() => {
    undoRef.current = undo;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "z") return;
      if (!e.ctrlKey && !e.metaKey) return;
      // 입력칸 안의 Ctrl+Z 는 글자를 무르는 것이지 도형이 아니다.
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      // 무를 게 없으면 브라우저 기본 동작을 가로채지 않는다.
      if (undoRef.current()) e.preventDefault();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---------- Alt+R — 4분할 차트와 같은 보기 초기화 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key.toLowerCase() !== "r" && e.code !== "KeyR") return;
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const chart = chartRef.current;
      const series = seriesRef.current;
      if (!chart || !series) return;
      e.preventDefault();
      // 가격 축을 손으로 끌면 자동 배율이 꺼진 채 남는다 — 되돌릴 때 함께 켠다. RSI 축도 같다.
      series.priceScale().applyOptions({ autoScale: true });
      rsiRef.current?.priceScale().applyOptions({ autoScale: true });
      chart.timeScale().resetTimeScale();
      chart.timeScale().fitContent();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---------- 키보드 ---------- */
  useEffect(() => {
    if (selected === null && tool === "none") return;

    const onKey = (e: KeyboardEvent) => {
      // 입력칸에서 누른 Del·Esc 는 글자를 지우거나 입력을 접는 것이지 도형이 아니다.
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (e.key === "Escape") {
        // 그리다 만 것을 버리고, 골라 둔 것도 놓는다.
        stepsRef.current = [];
        setPending(null);
        setAsking(false);
        setEditing(null);
        setNoteError(null);
        setSelected(null);
        setTool("none");
        return;
      }

      if (selected === null) return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      // Backspace 는 브라우저에서 뒤로 가기로 잡히는 경우가 있다.
      e.preventDefault();

      const before = annotations.find((a) => a.id === selected);
      startSaving(async () => {
        const result = await deleteAnnotation(selected);
        if (result.error) {
          setNoteError(result.error);
          return;
        }
        if (before) record({ type: "delete", before });
        setSelected(null);
        setEditing(null);
      });
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, tool, annotations]);

  // 도구를 켠 동안에는 차트의 드래그 이동을 꺼야 도형을 그릴 수 있다.
  useEffect(() => {
    chartRef.current?.applyOptions({
      handleScroll: tool === "none",
      handleScale: tool === "none",
    });
  }, [tool]);

  const cancelDraft = () => {
    stepsRef.current = [];
    setPending(null);
    setAsking(false);
    setEditing(null);
    setSelected(null);
    setNoteError(null);
  };

  /** 도구를 갈아 끼운다 — 같은 것을 다시 누르면 끈다. 그리던 것은 버린다. */
  const pickTool = (next: Tool) => {
    setTool((current) => (current === next ? "none" : next));
    setState(null);
    cancelDraft();
  };

  /** 골라 둔 메모의 라벨을 고친다. */
  const saveEdit = () => {
    if (!editing) return;
    const text = label.trim();
    if (editing.kind === "text" && text === "") {
      setNoteError("메모 내용을 입력해 주세요.");
      return;
    }

    const before = editing;
    startSaving(async () => {
      const result = await updateAnnotationText(before.id, text);
      if (result.error) {
        setNoteError(result.error);
        return;
      }
      record({ type: "text", id: before.id, kind: before.kind, before: before.text });
      setEditing(null);
    });
  };

  /** 숫자로 적은 값을 좌표에 얹는다 — 시각은 그대로 두고 가격만 바꾼다. */
  const saveLevels = () => {
    if (!levels) return;
    const { target, values } = levels;

    const points = target.points.map((point) => ({ ...point }));
    const fields = levelFields(target.kind);
    for (let i = 0; i < fields.length; i += 1) {
      const price = parseLevel(values[i] ?? "");
      if (price === null) {
        setNoteError(`${fields[i].label}를 숫자로 입력해 주세요.`);
        return;
      }
      points[fields[i].index] = { t: points[fields[i].index].t, p: price };
    }

    if (isPositionKind(target.kind)) {
      const problem = positionProblemOf(target.kind, points);
      if (problem !== null) {
        setNoteError(problem);
        return;
      }
    }

    startSaving(async () => {
      const result = await updateAnnotationPoints(target.id, points);
      if (result.error) {
        setNoteError(result.error);
        return;
      }
      record({ type: "move", id: target.id, kind: target.kind, before: target.points });
      setLevels(null);
    });
  };

  /**
   * 골라 둔 메모의 색·굵기·선 종류를 고친다 — 4분할과 같은 스타일 편집.
   *
   * 화면을 먼저 바꾼다. 버튼의 눌림 표시가 서버 왕복을 기다리면 굼뜨게 느껴지고,
   * 실패하면 오류 문구가 알려 준다(revalidate가 원래 값으로 되돌린다).
   */
  const applyStyle = (style: {
    color?: AnnotationColor;
    lineWidth?: number;
    lineStyle?: AnnotationLineStyle;
  }) => {
    if (!editing) return;
    const before = editing;
    setEditing({
      ...before,
      ...(style.color !== undefined ? { color: style.color } : {}),
      ...(style.lineWidth !== undefined ? { line_width: style.lineWidth } : {}),
      ...(style.lineStyle !== undefined ? { line_style: style.lineStyle } : {}),
    });
    startSaving(async () => {
      const result = await updateAnnotationStyle(before.id, style);
      if (result.error) setNoteError(result.error);
    });
  };

  const removeEdit = () => {
    if (!editing) return;
    const before = editing;
    startSaving(async () => {
      const result = await deleteAnnotation(before.id);
      if (result.error) {
        setNoteError(result.error);
        return;
      }
      record({ type: "delete", before });
      setSelected(null);
      setEditing(null);
    });
  };

  const saveDraft = () => {
    if (!pending) return;
    const text = label.trim();
    if (pending.kind === "text" && text === "") {
      setNoteError("메모 내용을 입력해 주세요.");
      return;
    }
    if (isPositionKind(pending.kind)) {
      const problem = positionProblemOf(pending.kind, pending.points);
      if (problem !== null) {
        setNoteError(problem);
        return;
      }
    }

    const kind = pending.kind;
    startSaving(async () => {
      const result = await createAnnotation({
        tradeId,
        kind,
        points: pending.points,
        text: text === "" ? null : text,
        color: pending.color,
      });
      if (result.error) {
        setNoteError(result.error);
        return;
      }
      if (result.id) record({ type: "create", id: result.id, kind });
      cancelDraft();
      /*
       * 하나 그리면 커서로 돌아간다 — 트레이딩뷰와 같다.
       *
       * 도구가 켜진 채로 두면 방금 그린 것을 끌어 옮기려다 그 위에 또 하나를 그리게
       * 된다. 도구가 켜져 있는 동안에는 판이 포인터를 가로채 기존 도형이 집히지 않기
       * 때문인데, 화면에는 그 사실이 드러나지 않아 "드래그가 안 된다"로 보인다.
       */
      setTool("none");
    });
  };

  const result = state ? measure(state.from, state.to, barSeconds) : null;
  /** 켜져 있는 도구가 메모를 남기는 것이면 그 종류, 아니면 null(꺼짐·측정). */
  const drawKind = tool === "none" || tool === "measure" ? null : tool;
  /**
   * 손익 툴에서 지금 무엇을 찍을 차례인지.
   *
   * 찍힌 점의 수는 `pending`으로 읽는다 — 포인터 처리기가 쓰는 ref 는 다시 그리지 않는다.
   */
  const positionStep =
    drawKind !== null && isPositionKind(drawKind) && !asking
      ? POSITION_STEPS[pending?.points.length ?? 0] ?? null
      : null;
  /*
   * 들고 있는 거래는 마지막 봉의 종가를 지금 값으로 본다.
   *
   * 거래에 적힌 청산가는 없고, 화면에는 이미 지금까지의 봉이 들어와 있다 — 굳이 시세를
   * 한 번 더 부를 이유가 없다.
   */
  const lastClose = candles && candles.length > 0 ? candles[candles.length - 1].c : null;
  const markPrice = exitPrice ?? lastClose;
  const viewLabel = exitAt === null ? OPEN_VIEW_LABEL : VIEW_LABEL;
  const held =
    markPrice !== null && entryPrice !== null
      ? ((markPrice - entryPrice) / entryPrice) * (side === "long" ? 1 : -1)
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
          {/*
            색은 메모 도구를 켰을 때만 고른다. 측정에는 쓰이지 않고, 손익 툴은 이익=초록
            손실=빨강이 뜻 그 자체라 고를 여지가 없다.
          */}
          {drawKind !== null && !isPositionKind(drawKind) ? (
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
          {(Object.keys(viewLabel) as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`rounded-lg border px-2.5 py-1 text-xs ${
                view === v ? "border-accent text-accent" : "border-border text-dim hover:text-text"
              }`}
            >
              {viewLabel[v]}
            </button>
          ))}
        </div>
      </div>

      <p className="mt-1 text-xs text-dim">
        {view === "auto" ? `${bar} 봉 자동 선택 · ` : ""}
        앞뒤 {padBars}봉 ·{" "}
        {/* 들고 있는 거래는 청산가가 없다 — 마지막 봉의 종가를 지금 값으로 세운다. */}
        진입 {num(entryPrice)} → {exitAt === null ? "현재" : "청산"} {num(markPrice)}
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

        {/* 더블클릭 — 값을 숫자로 넣는다. 픽셀로는 못 맞추는 자리가 있다. */}
        {levels ? (
          <div
            className="absolute inset-x-2 bottom-2 rounded-lg border border-border bg-surface p-2 shadow-lg"
            style={{ zIndex: 7 }}
          >
            <div className="flex flex-wrap items-end gap-2">
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-dim">
                {ANNOTATION_KIND_LABEL[levels.target.kind]}
              </span>
              {levelFields(levels.target.kind).map((field, i) => (
                <label key={field.index} className="text-[11px] text-dim">
                  {field.label}
                  <input
                    autoFocus={i === 0}
                    inputMode="decimal"
                    value={levels.values[i] ?? ""}
                    onChange={(e) =>
                      setLevels((state) =>
                        state === null
                          ? state
                          : {
                              ...state,
                              values: state.values.map((v, j) => (j === i ? e.target.value : v)),
                            },
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveLevels();
                      if (e.key === "Escape") setLevels(null);
                    }}
                    className="tnum mt-0.5 block w-32 rounded-lg border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent"
                  />
                </label>
              ))}
              <button
                type="button"
                disabled={saving}
                onClick={saveLevels}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {saving ? "저장 중…" : "저장"}
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => setLevels(null)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-dim disabled:opacity-50"
              >
                취소
              </button>
            </div>
            {noteError ? <p className="mt-1 text-[11px] text-loss">{noteError}</p> : null}
          </div>
        ) : null}

        {/* 골라 둔 메모 — 누른 자리에서 바로 라벨을 고치거나 지운다. */}
        {editing ? (
          <div
            className="absolute inset-x-2 bottom-2 rounded-lg border border-border bg-surface p-2 shadow-lg"
            style={{ zIndex: 7 }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-dim">
                {ANNOTATION_KIND_LABEL[editing.kind]}
              </span>
              <input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveEdit();
                  if (e.key === "Escape") setEditing(null);
                }}
                placeholder={editing.kind === "text" ? "메모 내용" : "라벨 — 없어도 됩니다"}
                className="min-w-40 flex-1 rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent"
              />
              <button
                type="button"
                disabled={saving}
                onClick={saveEdit}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {saving ? "저장 중…" : "저장"}
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={removeEdit}
                className="rounded-lg border border-loss/40 px-3 py-1.5 text-xs text-loss disabled:opacity-50"
              >
                삭제
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => setEditing(null)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-dim disabled:opacity-50"
              >
                닫기
              </button>
            </div>

            {/* 스타일 — 4분할 차트와 같은 색·굵기·선 종류 편집. 손익 툴은 색이 뜻이라 제외. */}
            {isStylableKind(editing.kind) ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1">
                  {ANNOTATION_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={ANNOTATION_COLOR_LABEL[c]}
                      aria-pressed={editing.color === c}
                      title={ANNOTATION_COLOR_LABEL[c]}
                      disabled={saving}
                      onClick={() => applyStyle({ color: c })}
                      className={`size-4 rounded-full ${ANNOTATION_DOT_CLASS[c]} ${
                        editing.color === c
                          ? "ring-2 ring-text ring-offset-1 ring-offset-surface"
                          : ""
                      }`}
                    />
                  ))}
                </span>
                <span className="mx-1 w-px self-stretch bg-border" aria-hidden />
                {STYLE_WIDTHS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    aria-pressed={editing.line_width === w}
                    disabled={saving}
                    onClick={() => applyStyle({ lineWidth: w })}
                    className={`rounded border px-2 py-0.5 text-[11px] ${
                      editing.line_width === w
                        ? "border-accent text-accent"
                        : "border-border text-dim hover:text-text"
                    }`}
                  >
                    {w}px
                  </button>
                ))}
                <span className="mx-1 w-px self-stretch bg-border" aria-hidden />
                {ANNOTATION_LINE_STYLES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={(editing.line_style ?? "solid") === s}
                    disabled={saving}
                    onClick={() => applyStyle({ lineStyle: s })}
                    className={`rounded border px-2 py-0.5 text-[11px] ${
                      (editing.line_style ?? "solid") === s
                        ? "border-accent text-accent"
                        : "border-border text-dim hover:text-text"
                    }`}
                  >
                    {ANNOTATION_LINE_STYLE_LABEL[s]}
                  </button>
                ))}
              </div>
            ) : null}
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
        ) : positionStep ? (
          <b className="text-accent">
            {tool === "long" ? "롱" : "숏"} 손익 — {positionStep} (진입 → 손절 → 목표).
            초록 구간이 목표까지, 빨강 구간이 손절까지고 두 세로 길이의 비가 손익비입니다.
          </b>
        ) : tool !== "none" ? (
          <b className="text-accent">
            {DRAW_TOOLS.find((t) => t.tool === tool)?.hint} — 메모는 (시각, 가격)에 붙어 봉을
            바꿔도 같은 자리를 가리킵니다. 다시 누르면 끕니다.
          </b>
        ) : (
          <>
            휠로 확대·축소, 드래그로 이동, 축을 끌면 배율이 바뀝니다. 남긴 메모는 눌러서
            고르고(집는 자리가 네모로 뜹니다) 그대로 끌어 옮깁니다 — 끝점을 집으면 그 점만,
            몸통을 집으면 통째로. <b className="text-text">Del</b> 로 지우고{" "}
            <b className="text-text">Esc</b> 로 놓고 <b className="text-text">Ctrl+Z</b> 로
            무릅니다. 자리를 다 잡았으면 아래 목록에서 잠가 두세요 — 잠근 메모는 끌리지 않고
            그 위에서도 차트가 밀립니다.
          </>
        )}
      </p>

      {/* 도구도 팝오버도 닫혀 있을 때는 알릴 자리가 여기뿐이다. */}
      {noteError && !asking && !editing ? (
        <p className="mt-1 text-[11px] text-loss">{noteError}</p>
      ) : notice ? (
        <p className="mt-1 text-[11px] text-dim">{notice}</p>
      ) : null}

      <AnnotationList annotations={annotations} onChange={record} />
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
export function formatTick(ms: number, type: TickMarkType): string {
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
export function formatKst(ms: number, withTime: boolean): string {
  const p: Record<string, string> = {};
  for (const part of KST_FMT.formatToParts(new Date(ms))) p[part.type] = part.value;
  if (p.hour === "24") p.hour = "00";
  const date = `${p.year}.${p.month}.${p.day}`;
  return withTime ? `${date} ${p.hour}:${p.minute}` : date;
}
