"use client";

/**
 * ATR 밴드 — 손절선을 고르는 자리에서 1·2·3배 ATR 이 어디인지 차트에 같이 긋는다.
 *
 * 당시 차트(TradeChart)와 4분할 차트가 같은 시리즈·범례·토글을 쓴다. 계산은
 * `@/lib/indicators` 의 `atrBands` 한 곳이다 — 차트에서 본 선과 봇이 거는 손절이 같아야 한다.
 *
 * 켜 둔 배수는 차트마다가 아니라 브라우저에 한 벌만 기억한다. 한 화면에 차트가 여럿 떠도
 * 토글 하나로 같이 켜지고 꺼진다.
 */

import {
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useSyncExternalStore } from "react";

import { num } from "@/lib/format";
import {
  ATR_BAND_MULTIPLES,
  ATR_BAND_PERIOD,
  atrBands,
  type AtrBandPoint,
} from "@/lib/indicators";
import type { Candle } from "@/lib/okx";

/** 켜 둔 배수(오름차순). 빈 배열이면 밴드를 끈 것이다. */
export type AtrMultiples = readonly number[];

const MULTIPLES: readonly number[] = ATR_BAND_MULTIPLES;

/* ── 켜 둔 배수 — 브라우저에 기억한다 ─────────────────────────────────────── */

const STORAGE_KEY = "chart.atr-bands";

/** 처음에는 셋 다 켠다 — 1·2·3배를 한 차트에서 견주는 것이 이 기능의 쓰임이다. */
const DEFAULT_MULTIPLES: AtrMultiples = MULTIPLES;

/** 아는 배수만, 오름차순으로 — 저장값이 망가져도 화면이 깨지지 않게. */
function normalize(values: readonly unknown[]): AtrMultiples {
  return MULTIPLES.filter((k) => values.includes(k));
}

function parse(raw: string | null): AtrMultiples {
  if (raw === null) return DEFAULT_MULTIPLES;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? normalize(value) : DEFAULT_MULTIPLES;
  } catch {
    return DEFAULT_MULTIPLES;
  }
}

/** 지금 값 — 같은 값이면 같은 배열을 돌려줘야 구독하는 차트가 쓸데없이 다시 그리지 않는다. */
let snapshot: AtrMultiples | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): AtrMultiples {
  if (snapshot === null) {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // 저장소가 막힌 창(사생활 보호 모드 등) — 기본값으로 본다
    }
    snapshot = parse(raw);
  }
  return snapshot;
}

/** 서버는 저장값을 모른다 — 기본값으로 그리고, 브라우저에서 저장값으로 갈아 끼운다. */
function getServerSnapshot(): AtrMultiples {
  return DEFAULT_MULTIPLES;
}

/** 다른 탭에서 바꾼 값도 따라간다. */
function onStorage(e: StorageEvent) {
  if (e.key !== STORAGE_KEY) return;
  snapshot = parse(e.newValue);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function setAtrMultiples(next: readonly number[]): void {
  snapshot = normalize(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // 저장이 막혀도 이번 화면에서는 바뀐다
  }
  for (const listener of listeners) listener();
}

/** 켜 둔 배수 — 이 훅을 쓰는 차트는 토글을 누르는 즉시 함께 바뀐다. */
export function useAtrMultiples(): AtrMultiples {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/* ── 토글 ─────────────────────────────────────────────────────────────── */

const BAND_HINT =
  `종가 ± k×ATR(${ATR_BAND_PERIOD}) — 그 봉 종가에 들어갔다면 k배 ATR 손절이 어디인지 잇습니다. ` +
  "롱은 아래 밴드, 숏은 위 밴드가 손절 후보입니다. 꼬리가 수시로 뚫는 밴드는 잡음 안쪽입니다";

/**
 * `ATR` 은 전체 켜기·끄기, `1× 2× 3×` 는 배수마다 켜고 끈다.
 * 글자를 줄여 둔다 — 당시 차트 도구 막대는 이미 길어, 한 단어만 늘어도 한 줄이 접힌다.
 */
export function AtrBandToggle() {
  const multiples = useAtrMultiples();
  const on = multiples.length > 0;

  return (
    <span className="flex items-center gap-1" role="group" aria-label="ATR 밴드 배수">
      <button
        type="button"
        aria-pressed={on}
        aria-label="ATR 밴드"
        onClick={() => setAtrMultiples(on ? [] : MULTIPLES)}
        title={BAND_HINT}
        className={`rounded-lg border px-2.5 py-1 text-xs whitespace-nowrap ${
          on ? "border-alpha text-alpha" : "border-border text-dim hover:text-text"
        }`}
      >
        ATR
      </button>
      {MULTIPLES.map((k) => {
        const active = multiples.includes(k);
        return (
          <button
            key={k}
            type="button"
            aria-pressed={active}
            aria-label={`ATR ${k}배 밴드`}
            title={`${k}×ATR 밴드 ${active ? "끄기" : "켜기"}`}
            onClick={() =>
              setAtrMultiples(active ? multiples.filter((m) => m !== k) : [...multiples, k])
            }
            className={`tnum rounded-lg border px-2 py-1 text-xs ${
              active ? "border-alpha bg-alpha/10 text-alpha" : "border-border text-dim hover:text-text"
            }`}
          >
            {k}×
          </button>
        );
      })}
    </span>
  );
}

/* ── 차트 시리즈 ──────────────────────────────────────────────────────── */

/** 배수가 클수록 옅게 — 1배가 가장 진하다. 16진 두 자리 불투명도(70% · 50% · 35%). */
const ALPHA_BY_MULTIPLE: Record<number, string> = { 1: "b3", 2: "80", 3: "59" };

function withAlpha(color: string, alpha: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color + alpha : color;
}

export interface AtrBandLayer {
  /**
   * 밴드를 다시 긋는다.
   *
   * `visibleCount` — 앞에서부터 몇 봉까지 그릴지. 복기 중에는 지금 보이는 봉까지만 준다: ATR 은
   * 지난 봉만 쓰지만, 선이 그 뒤로 뻗으면 시간축이 늘어나 아직 오지 않은 봉의 자리가 드러난다.
   * `precision` — 캔들과 같은 가격 자릿수. 가격축의 숫자 모양은 가장 먼저 붙은 시리즈(밴드)를 따른다.
   */
  setData(
    candles: readonly Candle[],
    visibleCount: number,
    multiples: AtrMultiples,
    precision: number,
  ): void;
  /** i 번째 봉의 밴드 — 재료가 모자라거나 보이는 범위 밖이면 null */
  pointAt(index: number): AtrBandPoint | null;
  /** 차트 시각(초) → 봉 인덱스 */
  indexOf(time: Time): number | null;
}

/**
 * 본 창에 밴드 여섯 줄(±1·2·3배)을 붙인다. 차트를 만들 때 한 번 부르고, 켜고 끄는 것은
 * `setData` 의 `multiples` 로 한다 — 시리즈를 지웠다 다시 만들면 축 배율이 튄다.
 *
 * **캔들 시리즈보다 먼저** 부른다 — 먼저 붙은 시리즈가 아래에 그려진다. 나중에 붙이면 촘촘한
 * 보기에서 여섯 줄이 캔들을 덮어 봉이 안 보였다.
 *
 * 가격축 라벨은 띄우지 않는다. 여섯 개가 진입·손절·목표 라벨을 밀어내 정작 손절가가 안
 * 읽혔다 — 값은 범례(`attachAtrLegend`)가 보인다.
 */
export function addAtrBandSeries(chart: IChartApi, color: string): AtrBandLayer {
  const lines: { multiple: number; j: number; side: "upper" | "lower"; series: ISeriesApi<"Line"> }[] = [];
  MULTIPLES.forEach((multiple, j) => {
    for (const side of ["upper", "lower"] as const) {
      const series = chart.addSeries(
        LineSeries,
        {
          color: withAlpha(color, ALPHA_BY_MULTIPLE[multiple] ?? "80"),
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
          // 마우스를 올릴 때 여섯 줄마다 점이 찍히면 캔들이 안 보인다 — 값은 범례가 보인다.
          crosshairMarkerVisible: false,
          visible: false,
        },
        0,
      );
      lines.push({ multiple, j, side, series });
    }
  });

  let source: readonly Candle[] | null = null;
  let points: (AtrBandPoint | null)[] = [];
  let index = new Map<number, number>();
  let visible = 0;

  return {
    setData(candles, visibleCount, multiples, precision) {
      // 같은 캔들이면 다시 계산하지 않는다 — 복기 한 봉·토글 한 번마다 부른다.
      if (candles !== source) {
        source = candles;
        points = atrBands(candles);
        index = new Map(candles.map((c, i) => [c.t / 1000, i]));
      }
      visible = Math.max(0, Math.min(visibleCount, candles.length));
      const priceFormat = { type: "price" as const, precision, minMove: 10 ** -precision };

      for (const { multiple, j, side, series } of lines) {
        const on = multiples.includes(multiple);
        series.applyOptions({ visible: on, priceFormat });
        if (!on) {
          // 감춘 선도 자료를 비운다 — 축 자동 배율이 안 보이는 선까지 담지 않게.
          series.setData([]);
          continue;
        }
        const data: { time: UTCTimestamp; value: number }[] = [];
        for (let i = 0; i < visible; i += 1) {
          const p = points[i];
          if (!p) continue;
          const value = side === "upper" ? p.upper[j] : p.lower[j];
          data.push({ time: (candles[i].t / 1000) as UTCTimestamp, value });
        }
        series.setData(data);
      }
    },
    pointAt(i) {
      return i >= 0 && i < visible ? (points[i] ?? null) : null;
    },
    indexOf(time) {
      return typeof time === "number" ? (index.get(time) ?? null) : null;
    },
  };
}

/* ── 범례 ─────────────────────────────────────────────────────────────── */

/**
 * 범례 상자의 모양 — 자리(absolute·top·left)는 쓰는 쪽이 정한다. 비어 있으면 숨는다.
 * 포인터는 통과시킨다 — 차트를 끌거나 메모를 집는 손을 막지 않게.
 */
export const ATR_LEGEND_CLASS =
  "tnum pointer-events-none rounded-md bg-surface/80 px-1.5 py-1 text-[11px] leading-snug text-dim shadow-sm backdrop-blur-sm empty:hidden";

/**
 * 범례를 그린다 — `ATR(14) 412.3 (0.42%)` 아래로 배수마다 한 줄: `+1× 위 밴드 · −1× 아래 밴드`.
 *
 * 배수마다 한 줄로 짝을 지은 이유: 롱 손절(−k)과 숏 손절(+k)을 같은 배수끼리 견주고, 폭도
 * 두 칸이라 휴대폰 화면에서 가격축을 덮지 않는다(위·아래를 한 줄씩 늘어놓으면 축까지 뻗었다).
 *
 * 마우스가 움직일 때마다 바뀌는 자리라 React 상태가 아니라 DOM 에 직접 쓴다 — 차트 전체가
 * 마우스 이동마다 다시 렌더링되지 않게. 들어가는 글자는 전부 숫자와 고정 문구다.
 */
function renderAtrLegend(
  el: HTMLElement,
  point: AtrBandPoint | null,
  multiples: AtrMultiples,
  precision: number,
  anchor: string | null,
): void {
  if (multiples.length === 0 || point === null) {
    el.replaceChildren();
    return;
  }

  const head = document.createElement("div");
  const share = point.basis > 0 ? ` (${((point.atr / point.basis) * 100).toFixed(2)}%)` : "";
  head.textContent = `${anchor ? `${anchor} · ` : ""}ATR(${ATR_BAND_PERIOD}) ${num(point.atr, precision)}${share}`;

  const cell = (sign: "+" | "−", k: number, value: number) => {
    const item = document.createElement("span");
    item.className = "whitespace-nowrap";
    const label = document.createElement("span");
    label.className = "text-alpha";
    label.textContent = `${sign}${k}× `;
    const text = document.createElement("span");
    text.className = "text-text";
    text.textContent = num(value, precision);
    item.append(label, text);
    return item;
  };

  const grid = document.createElement("div");
  grid.className = "grid grid-cols-[auto_auto] gap-x-3";
  for (const k of multiples) {
    const j = MULTIPLES.indexOf(k);
    grid.append(cell("+", k, point.upper[j]), cell("−", k, point.lower[j]));
  }

  el.replaceChildren(head, grid);
}

/**
 * 범례를 차트에 붙인다 — 마우스가 올라간 봉, 없으면 기준 봉(`anchorIndex`)의 값을 보인다.
 * 돌려주는 함수로 뗀다.
 */
export function attachAtrLegend(
  chart: IChartApi,
  layer: AtrBandLayer,
  el: HTMLElement,
  opts: { anchorIndex: number; anchorLabel: string | null; multiples: AtrMultiples; precision: number },
): () => void {
  const { anchorIndex, anchorLabel, multiples, precision } = opts;

  const draw = (hovered: number | null) => {
    const i = hovered !== null && layer.pointAt(hovered) !== null ? hovered : null;
    renderAtrLegend(el, layer.pointAt(i ?? anchorIndex), multiples, precision, i === null ? anchorLabel : null);
  };

  const onMove = (param: MouseEventParams<Time>) => {
    draw(param.point === undefined || param.time === undefined ? null : layer.indexOf(param.time));
  };

  draw(null);
  chart.subscribeCrosshairMove(onMove);
  return () => {
    chart.unsubscribeCrosshairMove(onMove);
  };
}
