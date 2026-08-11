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
  Logical,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";

import type {
  AnnotationColor,
  AnnotationKind,
  ChartPoint,
  TradeAnnotation,
} from "@/lib/domain";

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
  kind: AnnotationKind;
  color: string;
  text: string | null;
  xy: { x: number; y: number }[];
  /** 저장 전인가 — 점선으로 그려 확정된 것과 구분한다 */
  draft: boolean;
}

const FONT = "12px system-ui, -apple-system, 'Segoe UI', sans-serif";
const LABEL_PAD = 4;
const HANDLE_R = 3;

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
  ctx.font = FONT;
  const width = ctx.measureText(text).width;
  const h = 18;

  ctx.fillStyle = color;
  roundRect(ctx, x, y - h / 2, width + LABEL_PAD * 2, h, 3);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + LABEL_PAD, y);
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
            ctx.lineWidth = shape.draft ? 1 : 1.5;
            ctx.setLineDash(shape.draft ? [4, 3] : []);

            const [a, b] = shape.xy;

            if (shape.kind === "hline") {
              ctx.beginPath();
              ctx.moveTo(0, a.y);
              ctx.lineTo(mediaSize.width, a.y);
              ctx.stroke();
              if (shape.text) drawLabel(ctx, shape.text, 8, a.y - 12, shape.color);
            } else if (shape.kind === "line" && b) {
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.stroke();
              for (const p of shape.xy) {
                ctx.beginPath();
                ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
                ctx.fill();
              }
              if (shape.text) {
                drawLabel(ctx, shape.text, (a.x + b.x) / 2, (a.y + b.y) / 2 - 12, shape.color);
              }
            } else if (shape.kind === "rect" && b) {
              const x = Math.min(a.x, b.x);
              const y = Math.min(a.y, b.y);
              const w = Math.abs(b.x - a.x);
              const h = Math.abs(b.y - a.y);
              ctx.globalAlpha = 0.12;
              ctx.fillRect(x, y, w, h);
              ctx.globalAlpha = 1;
              ctx.strokeRect(x, y, w, h);
              if (shape.text) drawLabel(ctx, shape.text, x + 4, y - 10, shape.color);
            } else if (shape.kind === "text") {
              ctx.beginPath();
              ctx.arc(a.x, a.y, HANDLE_R, 0, Math.PI * 2);
              ctx.fill();
              if (shape.text) drawLabel(ctx, shape.text, a.x + 8, a.y - 10, shape.color);
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

  // 라이브러리가 배열 참조로 캐시를 판단한다 — 뷰 배열은 한 번만 만든다.
  private readonly view = new AnnotationPaneView();
  private readonly views: IPrimitivePaneView[];

  constructor(colors: AnnotationColorMap) {
    this.colors = colors;
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

  /**
   * 부모가 다시 그려질 때마다 새 배열이 온다(`annotations[id] ?? []`). 내용이 같으면
   * 다시 그리지 않는다 — 목록 필터를 건드릴 때마다 차트가 깜빡이지 않게.
   */
  setData(items: readonly TradeAnnotation[], draft: AnnotationDraft | null): void {
    const same =
      this.draft === draft &&
      this.items.length === items.length &&
      this.items.every((item, i) => item === items[i]);
    if (same) return;

    this.items = items;
    this.draft = draft;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  updateAllViews(): void {
    this.view.update(this.project());
  }

  /** 아직 캔들이 안 붙었거나 화면 밖이면 그 메모만 빠진다. */
  private project(): Shape[] {
    const out: Shape[] = [];

    for (const item of this.items) {
      const xy = this.toScreen(item.points);
      if (xy) {
        out.push({
          kind: item.kind,
          color: this.colors[item.color],
          text: item.text,
          xy,
          draft: false,
        });
      }
    }

    if (this.draft) {
      const xy = this.toScreen(this.draft.points);
      if (xy) {
        out.push({
          kind: this.draft.kind,
          color: this.colors[this.draft.color],
          text: this.draft.text,
          xy,
          draft: true,
        });
      }
    }

    return out;
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
    // 봉 간격을 바꾸면 그 시각의 봉이 없다 — 가장 가까운 봉에 붙인다.
    const index = scale.timeToIndex(point.t as Time, true);
    if (index === null) return null;

    const x = scale.logicalToCoordinate(index as unknown as Logical);
    const y = series.priceToCoordinate(point.p);
    if (x === null || y === null) return null;

    return { x, y };
  }
}
