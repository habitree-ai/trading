/**
 * 차트 메모를 캔버스에 그리는 플러그인.
 *
 * lightweight-charts 위에 별도의 `div`를 겹쳐 그리는 방법도 있지만, 그러면 가격축을
 * 끌어 배율을 바꿀 때마다 좌표를 다시 계산해 줄 방법이 없다(라이브러리가 그 변화를
 * 알려 주지 않는다). 시리즈 플러그인으로 붙이면 차트가 다시 그려질 때마다
 * `updateAllViews`가 함께 불려, 확대·이동·배율 어느 쪽으로도 메모가 따라간다.
 *
 * 좌표는 (시각, 가격)으로 들어온다. 봉 간격을 바꾸면 그 시각의 봉이 없을 수 있어
 * 가장 가까운 봉에 붙인다 — 진입·청산 마커와 같은 방식이다.
 */

import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  Logical,
  PrimitiveHoveredItem,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";

import { resolveHit, type AnnotationHit, type HitShape } from "@/lib/hit-test";

import {
  isPositionKind,
  type AnnotationColor,
  type AnnotationKind,
  type AnnotationLineStyle,
  type ChartPoint,
  type TradeAnnotation,
} from "@/lib/domain";
import { num, signed, signedPct } from "@/lib/format";
import { positionMetrics } from "@/lib/position-tool";

/** 라이브러리가 렌더러에 넘기는 캔버스 대상 — 타입만 빌려 온다. */
type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

/** 색 토큰 → 실제 색. 캔버스는 CSS 변수를 못 읽어 한 번 풀어서 넘긴다. */
export type AnnotationColorMap = Record<AnnotationColor, string>;

/** 그리는 중인 메모 — 아직 저장되지 않아 id가 없다. */
export interface AnnotationDraft {
  kind: AnnotationKind;
  points: ChartPoint[];
  text: string | null;
  color: AnnotationColor;
}

interface Shape {
  /** 저장된 메모의 id. 아직 저장 전(초안)이면 null이라 집을 수 없다 */
  id: string | null;
  kind: AnnotationKind;
  color: string;
  text: string | null;
  xy: { x: number; y: number }[];
  /** 저장 전인가 — 점선으로 그려 확정된 것과 구분한다 */
  draft: boolean;
  /** 골라 둔 것인가 — 굵게 긋고 집을 자리를 네모로 드러낸다 */
  selected: boolean;
  /** 선 굵기(px) — 도형별 값이 없으면 화면 기본값 */
  width: number;
  /** 선 종류가 만든 대시 패턴 — 실선이면 빈 배열 */
  dash: number[];
  /** 확정 도형의 불투명도 — 캔들을 가리지 않게 화면이 정한다. 고른 도형은 1로 그린다 */
  alpha: number;
  /** 손익 툴 전용 — 상자 왼쪽에 적는 % 라벨. 세 점이 다 찍혀야 생긴다 */
  side?: { stop?: string; target?: string; summary?: string };
  /** 손익 툴 전용 — 이익·손실 구간의 색. 팔레트가 아니라 손익 색을 쓴다 */
  zone?: { profit: string; loss: string };
}

/** 선 종류 → 캔버스 대시 패턴. */
const LINE_DASH: Record<AnnotationLineStyle, number[]> = {
  solid: [],
  dashed: [6, 4],
  dotted: [2, 3],
};

/** 화면이 정하는 그리기 기본값 — 복기 차트는 기존 그대로, 4분할은 더 연하게 쓴다. */
export interface AnnotationStyleDefaults {
  lineWidth: number;
  alpha: number;
}

const DEFAULT_STYLE: AnnotationStyleDefaults = { lineWidth: 1.5, alpha: 1 };

const FONT = "12px system-ui, -apple-system, 'Segoe UI', sans-serif";
/** 손익 툴 % 라벨 — 차트를 덜 가리도록 본문 라벨보다 작게. */
const SIDE_FONT = "11px system-ui, -apple-system, 'Segoe UI', sans-serif";
const LABEL_PAD = 4;
const HANDLE_R = 3;
/** 고른 도형의 집는 자리 — 반지름이 아니라 한 변의 절반이다. */
const GRIP = 4;

/**
 * 집을 자리를 네모로 드러낸다 — 고른 도형에만 그린다.
 *
 * 평소에도 그려 두면 선이 여럿일 때 화면이 점으로 뒤덮인다. 트레이딩뷰와 같이
 * 고른 것에만 띄워, 지금 무엇이 잡혀 있는지가 한눈에 보이게 한다.
 */
function drawGrips(
  ctx: CanvasRenderingContext2D,
  points: readonly { x: number; y: number }[],
  color: string,
): void {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.fillStyle = "#ffffff";
  for (const p of points) {
    ctx.beginPath();
    ctx.rect(p.x - GRIP, p.y - GRIP, GRIP * 2, GRIP * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * 손익 툴 상자의 최소 가로폭(px).
 *
 * 세 점을 같은 봉 위에 찍으면 폭이 0이 돼 아무것도 안 보인다. 가격만 보고 찍는 일이
 * 흔하므로 최소 폭을 준다.
 */
const MIN_BOX_W = 160;

/** 손익 툴 상자가 가로로 차지하는 범위 — 그리는 쪽과 집는 쪽이 같은 값을 봐야 한다. */
function positionSpan(xy: readonly { x: number }[]): { left: number; right: number } {
  const xs = xy.map((p) => p.x);
  const left = Math.min(...xs);
  return { left, right: Math.max(Math.max(...xs), left + MIN_BOX_W) };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 라벨은 항상 배경을 깔고 흰 글씨로 — 캔들 위에 얹혀도 읽혀야 한다. */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
): void {
  ctx.save();
  // 선을 연하게 그리는 화면에서도 글자는 또렷해야 읽힌다.
  ctx.globalAlpha = 1;
  ctx.font = FONT;
  const width = ctx.measureText(text).width;
  const h = 18;

  ctx.fillStyle = color;
  roundRect(ctx, x, y - h / 2, width + LABEL_PAD * 2, h, 3);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + LABEL_PAD, y);
  ctx.restore();
}

/**
 * 손익 툴이 상자 왼쪽에 적는 글 — 목표 %·손절 %·손익비.
 *
 * 가격 값은 여기 없다 — 오른쪽 가격축 라벨이 맡는다(`PriceAxisView`). 상자 옆에는
 * 축이 말해 주지 못하는 비율만 남겨, 차트를 가리는 글을 최소로 줄인다.
 * 점이 셋 다 찍히기 전에는 아무것도 적지 않는다 — 비율이 아직 정해지지 않았다.
 */
function positionSideLabels(
  kind: "long" | "short",
  points: readonly ChartPoint[],
  notional: number | null,
): { stop?: string; target?: string; summary?: string } {
  const [entry, stop, target] = points;
  if (!entry || !stop || !target) return {};

  const m = positionMetrics({
    side: kind,
    entry: entry.p,
    stop: stop.p,
    target: target.p,
    notional,
  });
  if (!m) return {};

  const money = (amount: number | null) => (amount === null ? "" : ` · ${signed(amount)}`);

  return {
    stop: `손절 ${signedPct(-m.riskPct, 2)}${money(m.lossAmount)}`,
    target: `목표 ${signedPct(m.rewardPct, 2)}${money(m.rewardAmount)}`,
    summary:
      m.problem !== null
        ? m.problem
        : `손익비 ${m.rr === null ? "—" : num(m.rr, 2)}`,
  };
}

/**
 * 손익 툴 — 진입선을 가운데 두고 목표 쪽은 초록, 손절 쪽은 빨강으로 칠한다.
 *
 * 트레이딩뷰의 Long/Short Position 도구와 같은 배치다. 두 구간의 세로 길이 비가 곧
 * 손익비라, 숫자를 읽기 전에 눈으로 먼저 판단이 된다 — 그게 이 도구의 값이다.
 *
 * 점이 덜 찍힌 동안(진입만, 진입+손절)에도 그린다. 다음 점을 어디에 찍을지는
 * 지금까지 그려진 모양을 보고 정하게 된다.
 */
function drawPosition(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  zone: { profit: string; loss: string },
): void {
  const [entry, stop, target] = shape.xy;
  const side = shape.side ?? {};

  const { left, right } = positionSpan(shape.xy);
  const baseAlpha = shape.selected ? 1 : shape.alpha;

  const band = (y: number, color: string) => {
    const top = Math.min(entry.y, y);
    const height = Math.abs(y - entry.y);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.1 * baseAlpha;
    ctx.fillRect(left, top, right - left, height);
    ctx.globalAlpha = baseAlpha;
    ctx.strokeStyle = color;
    ctx.strokeRect(left, top, right - left, height);
  };

  if (target) band(target.y, zone.profit);
  if (stop) band(stop.y, zone.loss);

  // 진입선은 두 구간의 경계다 — 실선으로 두어 어디가 기준인지 헷갈리지 않게.
  ctx.setLineDash([]);
  ctx.globalAlpha = baseAlpha;
  ctx.strokeStyle = shape.color;
  ctx.beginPath();
  ctx.moveTo(left, entry.y);
  ctx.lineTo(right, entry.y);
  ctx.stroke();

  /*
   * %·손익비는 상자 왼쪽 바깥에 배경 없는 작은 글씨로 — 가격 값은 오른쪽 축이
   * 맡으므로 차트 위에는 비율만 남긴다. 캔들을 덮는 상자형 라벨을 쓰지 않는다.
   */
  const sideText = (text: string, y: number, color: string) => {
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.font = SIDE_FONT;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, left - 6, y);
    ctx.restore();
  };

  if (target && side.target) sideText(side.target, (entry.y + target.y) / 2, zone.profit);
  if (stop && side.stop) sideText(side.stop, (entry.y + stop.y) / 2, zone.loss);
  if (side.summary) sideText(side.summary, entry.y, shape.color);

  /*
   * 집는 자리는 점이 찍힌 좌표가 아니라 상자에 붙인다.
   *
   * 세 값은 상자 안 어디서든 높이로 집히고, 가로 폭은 좌·우 가장자리로 늘인다 —
   * 저장된 점의 x 는 처음 눌렀던 자리일 뿐이라 거기에 표시를 두면 엉뚱한 데를 짚는다.
   */
  if (shape.selected) {
    const mid = (left + right) / 2;
    drawGrips(
      ctx,
      [
        { x: left, y: entry.y },
        { x: right, y: entry.y },
        ...shape.xy.map((p) => ({ x: mid, y: p.y })),
      ],
      shape.color,
    );
  }
}

/**
 * 손익 툴 가격을 오른쪽 가격축에 찍는 라벨.
 *
 * 값은 축이 말하게 하고 차트 위에는 비율만 남긴다 — 트레이딩뷰의 포지션 도구와
 * 같은 배치다. 좌표는 물을 때마다 다시 계산한다(축 배율이 수시로 바뀐다).
 */
class PriceAxisView implements ISeriesPrimitiveAxisView {
  constructor(
    private readonly owner: { priceY(price: number): number | null },
    private readonly price: number,
    private readonly color: string,
  ) {}

  coordinate(): number {
    return this.owner.priceY(this.price) ?? -1_000_000;
  }
  text(): string {
    return num(this.price);
  }
  textColor(): string {
    return "#ffffff";
  }
  backColor(): string {
    return this.color;
  }
  visible(): boolean {
    return this.owner.priceY(this.price) !== null;
  }
  tickVisible(): boolean {
    return true;
  }
}

class AnnotationPaneView implements IPrimitivePaneView {
  private shapes: readonly Shape[] = [];

  update(shapes: readonly Shape[]): void {
    this.shapes = shapes;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    if (this.shapes.length === 0) return null;
    const shapes = this.shapes;

    return {
      draw(target: RenderTarget) {
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
          for (const shape of shapes) {
            ctx.save();
            ctx.strokeStyle = shape.color;
            ctx.fillStyle = shape.color;
            ctx.lineWidth = shape.draft
              ? Math.max(1, shape.width - 0.5)
              : shape.selected
                ? shape.width + 1
                : shape.width;
            ctx.setLineDash(shape.draft ? [4, 3] : shape.dash);
            // 확정 도형은 화면이 정한 불투명도로 연하게 — 고른 것만 또렷이 세운다.
            ctx.globalAlpha = shape.selected || shape.draft ? 1 : shape.alpha;

            const [a, b] = shape.xy;

            if (shape.kind === "hline") {
              ctx.beginPath();
              ctx.moveTo(0, a.y);
              ctx.lineTo(mediaSize.width, a.y);
              ctx.stroke();
              if (shape.text) drawLabel(ctx, shape.text, 8, a.y - 12, shape.color);
            } else if (shape.kind === "line" && b) {
              // 끝점 표시는 고른 도형에만 띄운다 — 선이 여럿이면 점이 화면을 덮는다.
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.stroke();
              if (shape.text) {
                drawLabel(ctx, shape.text, (a.x + b.x) / 2, (a.y + b.y) / 2 - 12, shape.color);
              }
            } else if (shape.kind === "rect" && b) {
              const x = Math.min(a.x, b.x);
              const y = Math.min(a.y, b.y);
              const w = Math.abs(b.x - a.x);
              const h = Math.abs(b.y - a.y);
              const alpha = shape.selected || shape.draft ? 1 : shape.alpha;
              ctx.globalAlpha = 0.12 * alpha;
              ctx.fillRect(x, y, w, h);
              ctx.globalAlpha = alpha;
              ctx.strokeRect(x, y, w, h);
              if (shape.text) drawLabel(ctx, shape.text, x + 4, y - 10, shape.color);
            } else if (shape.kind === "text") {
              ctx.beginPath();
              ctx.arc(a.x, a.y, HANDLE_R, 0, Math.PI * 2);
              ctx.fill();
              if (shape.text) drawLabel(ctx, shape.text, a.x + 8, a.y - 10, shape.color);
            } else if (isPositionKind(shape.kind) && shape.zone) {
              drawPosition(ctx, shape, shape.zone);
            }

            // 고른 도형에만 집는 자리를 띄운다 — 무엇이 잡혀 있는지 눈에 보여야 한다.
            // 손익 툴은 상자에 맞춰 따로 그렸다.
            if (shape.selected && !isPositionKind(shape.kind)) {
              drawGrips(ctx, shape.xy, shape.color);
            }

            ctx.restore();
          }
        });
      },
    };
  }
}

export class AnnotationPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;

  private items: readonly TradeAnnotation[] = [];
  private draft: AnnotationDraft | null = null;
  private colors: AnnotationColorMap;
  /** 손익 툴이 금액을 낼 때 쓰는 크기 — 이 거래의 명목가 */
  private notional: number | null = null;
  /** 지금 골라 둔 메모 */
  private selected: string | null = null;

  // 라이브러리가 배열 참조로 캐시를 판단한다 — 뷰 배열은 한 번만 만든다.
  private readonly view = new AnnotationPaneView();
  private readonly views: IPrimitivePaneView[];
  /** 손익 툴 가격의 오른쪽 축 라벨 — `updateAllViews`에서 다시 만든다. */
  private axisViews: ISeriesPrimitiveAxisView[] = [];
  /** 화면이 정한 그리기 기본값 — 도형별 값이 없을 때 쓴다. */
  private readonly style: AnnotationStyleDefaults;

  constructor(colors: AnnotationColorMap, style?: Partial<AnnotationStyleDefaults>) {
    this.colors = colors;
    this.style = { ...DEFAULT_STYLE, ...style };
    this.views = [this.view];
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setColors(colors: AnnotationColorMap): void {
    this.colors = colors;
    this.requestUpdate?.();
  }

  setSelected(id: string | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.requestUpdate?.();
  }

  /**
   * 부모가 다시 그려질 때마다 새 배열이 온다(`annotations[id] ?? []`). 내용이 같으면
   * 다시 그리지 않는다 — 목록 필터를 건드릴 때마다 차트가 깜빡이지 않게.
   */
  setData(
    items: readonly TradeAnnotation[],
    draft: AnnotationDraft | null,
    notional: number | null,
  ): void {
    const same =
      this.draft === draft &&
      this.notional === notional &&
      this.items.length === items.length &&
      this.items.every((item, i) => item === items[i]);
    if (same) return;

    this.items = items;
    this.draft = draft;
    this.notional = notional;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.axisViews;
  }

  /** 가격 → 화면 y. 축 라벨이 물을 때마다 다시 계산한다(배율이 수시로 바뀐다). */
  priceY(price: number): number | null {
    return this.series?.priceToCoordinate(price) ?? null;
  }

  updateAllViews(): void {
    this.view.update(this.project());
    this.axisViews = this.buildAxisViews();
  }

  /** 손익 툴의 진입·손절·목표 가격 — 값은 오른쪽 축에만 뜬다. */
  private buildAxisViews(): ISeriesPrimitiveAxisView[] {
    const out: ISeriesPrimitiveAxisView[] = [];

    const add = (points: readonly ChartPoint[], color: AnnotationColor) => {
      // [진입, 손절, 목표] 순서 — 진입은 도형 색, 손절·목표는 손익 색.
      const colors = [this.colors[color], this.colors.loss, this.colors.profit];
      points.slice(0, 3).forEach((point, i) => {
        out.push(new PriceAxisView(this, point.p, colors[i]));
      });
    };

    for (const item of this.items) {
      if (isPositionKind(item.kind)) add(item.points, item.color);
    }
    if (this.draft && isPositionKind(this.draft.kind)) {
      add(this.draft.points, this.draft.color);
    }
    return out;
  }

  /**
   * 커서가 짚은 메모 — 끌어서 옮기려는 쪽이 부른다.
   *
   * 그때그때 다시 투영한다. 마지막으로 그린 좌표를 들고 있어도 되지만, 차트를 밀거나
   * 배율을 바꾼 직후에는 그 값이 화면과 어긋난다.
   */
  findHit(x: number, y: number): AnnotationHit | null {
    const locked = new Set(this.items.filter((a) => a.locked).map((a) => a.id));

    const shapes: HitShape[] = [];
    for (const shape of this.project()) {
      // 초안은 아직 저장된 것이 아니라 집을 대상이 없다.
      if (shape.id === null) continue;
      // 잠근 메모는 아예 없는 것처럼 둔다 — 그래야 그 위에서도 차트가 밀린다.
      if (locked.has(shape.id)) continue;
      shapes.push({
        id: shape.id,
        kind: shape.kind,
        xy: shape.xy,
        span: isPositionKind(shape.kind) ? positionSpan(shape.xy) : undefined,
      });
    }
    return resolveHit(shapes, x, y);
  }

  /** 라이브러리가 커서 모양을 정하는 데 쓴다 — 집을 수 있는 자리에 오면 손 모양이 된다. */
  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const hit = this.findHit(x, y);
    if (hit === null) return null;

    return {
      externalId: hit.id,
      zOrder: "top",
      cursorStyle: hit.target === "body" ? "move" : "grab",
      hitTestPriority: hit.target === "body" ? 1 : 2,
    };
  }

  /** 아직 캔들이 안 붙었거나 화면 밖이면 그 메모만 빠진다. */
  private project(): Shape[] {
    const out: Shape[] = [];

    for (const item of this.items) {
      const shape = this.toShape(item.id, item.kind, item.points, item.color, item.text, false, item);
      if (shape) out.push(shape);
    }

    if (this.draft) {
      const { kind, points, color, text } = this.draft;
      const shape = this.toShape(null, kind, points, color, text, true);
      if (shape) out.push(shape);
    }

    return out;
  }

  private toShape(
    id: string | null,
    kind: AnnotationKind,
    points: readonly ChartPoint[],
    color: AnnotationColor,
    text: string | null,
    draft: boolean,
    style?: { line_width?: number; line_style?: AnnotationLineStyle },
  ): Shape | null {
    const xy = this.toScreen(points);
    if (!xy) return null;

    const shape: Shape = {
      id,
      kind,
      color: this.colors[color],
      text,
      xy,
      draft,
      selected: id !== null && id === this.selected,
      width: style?.line_width ?? this.style.lineWidth,
      dash: LINE_DASH[style?.line_style ?? "solid"],
      alpha: this.style.alpha,
    };
    if (isPositionKind(kind)) {
      // 손익 툴의 구간 색은 팔레트가 아니라 손익 색이다 — 초록이 이익, 빨강이 손실이라는
      // 약속이 화면 전체에서 같아야 한다.
      shape.zone = { profit: this.colors.profit, loss: this.colors.loss };
      shape.side = positionSideLabels(kind, points, this.notional);
    }
    return shape;
  }

  private toScreen(points: readonly ChartPoint[]): { x: number; y: number }[] | null {
    const out: { x: number; y: number }[] = [];
    for (const point of points) {
      const xy = this.pointToScreen(point);
      if (xy === null) return null;
      out.push(xy);
    }
    return out.length === 0 ? null : out;
  }

  private pointToScreen(point: ChartPoint): { x: number; y: number } | null {
    const { chart, series } = this;
    if (!chart || !series) return null;

    const scale = chart.timeScale();
    const index = this.indexFor(point.t);
    if (index === null) return null;

    const x = scale.logicalToCoordinate(index as unknown as Logical);
    const y = series.priceToCoordinate(point.p);
    if (x === null || y === null) return null;

    return { x, y };
  }

  /**
   * 시각 → 논리 좌표.
   *
   * 자료 범위 안에서는 기존대로 가장 가까운 봉에 붙인다 — 봉 간격을 바꾸면 그 시각의
   * 봉이 없기 때문이다. 범위 밖은 `timeToIndex` 가 끝 봉으로 눌러 붙여 버려, 마지막
   * 캔들 너머로 그은 추세선 끝점이 전부 마지막 봉 위로 접혔다. 봉 간격으로 이어
   * 계산해 캔들 이후(그리고 이전) 영역까지 그대로 뻗게 한다.
   */
  private indexFor(t: number): number | null {
    const { chart, series } = this;
    if (!chart || !series) return null;

    const scale = chart.timeScale();
    const data = series.data();
    const first = data[0]?.time as number | undefined;
    const last = data[data.length - 1]?.time as number | undefined;

    if (first === undefined || last === undefined || data.length < 2 || (t >= first && t <= last)) {
      return scale.timeToIndex(t as Time, true) as number | null;
    }

    // 빈 봉이 섞여도 평균 간격이면 충분하다 — 범위 밖은 눈으로 잇는 자리다.
    const barSec = (last - first) / (data.length - 1);
    return t > last ? data.length - 1 + (t - last) / barSec : (t - first) / barSec;
  }
}
