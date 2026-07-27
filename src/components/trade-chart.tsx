"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { num, pct, signed } from "@/lib/format";
import { BAR_MS, pickBar, windowFor, type Bar as OkxBar, type Candle } from "@/lib/okx";

/** 화면에 노출하는 보기 — 자동은 거래 길이에 맞춰 봉을 고른다. */
type View = "auto" | "4H" | "1D";

const VIEW_LABEL: Record<View, string> = {
  auto: "진입~종료",
  "4H": "4시간봉",
  "1D": "일봉",
};

interface Row extends Candle {
  /** 캔들 몸통을 [저, 고] 범위 막대로 그리기 위한 값. */
  range: [number, number];
  up: boolean;
  /** 이 봉이 거래 보유 구간에 걸쳐 있는가. */
  inTrade: boolean;
}

export function TradeChart({
  symbol,
  side,
  entryAt,
  exitAt,
  entryPrice,
  exitPrice,
  stopPrice,
}: {
  symbol: string;
  side: "long" | "short";
  entryAt: string;
  exitAt: string | null;
  entryPrice: number | null;
  exitPrice: number | null;
  stopPrice: number | null;
}) {
  const entryMs = Date.parse(entryAt);
  const exitMs = exitAt ? Date.parse(exitAt) : null;

  const [view, setView] = useState<View>("auto");
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const bar: OkxBar = useMemo(
    () => (view === "auto" ? pickBar(Math.max((exitMs ?? entryMs) - entryMs, BAR_MS["1m"])) : view),
    [view, entryMs, exitMs],
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // 자동 보기는 거래 구간만, 4시간·일봉은 앞뒤 맥락을 넓게 잡는다.
      const { from, to } = windowFor(entryMs, exitMs, bar, view === "auto" ? 12 : 30);

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
  }, [symbol, bar, entryMs, exitMs, view]);

  // 진입·청산이 속한 봉의 시작 시각 — 표시를 그 봉에 정확히 얹기 위해.
  const barOf = (ms: number) => Math.floor(ms / BAR_MS[bar]) * BAR_MS[bar];
  const entryBar = barOf(entryMs);
  const exitBar = exitMs === null ? null : barOf(exitMs);

  const rows: Row[] = useMemo(
    () =>
      (candles ?? []).map((c) => ({
        ...c,
        range: [c.l, c.h] as [number, number],
        up: c.c >= c.o,
        // 실제 거래가 걸쳐 있던 봉 — 어느 배율에서든 이 봉들이 먼저 눈에 들어와야 한다.
        inTrade: c.t >= entryBar && c.t <= (exitBar ?? entryBar),
      })),
    [candles, entryBar, exitBar],
  );

  const priceDomain = useMemo((): [number, number] | undefined => {
    if (rows.length === 0) return undefined;
    const lows = rows.map((r) => r.l);
    const highs = rows.map((r) => r.h);
    const marks = [entryPrice, exitPrice, stopPrice].filter((v): v is number => v !== null);
    const min = Math.min(...lows, ...marks);
    const max = Math.max(...highs, ...marks);
    const pad = (max - min) * 0.06 || max * 0.001;
    return [min - pad, max + pad];
  }, [rows, entryPrice, exitPrice, stopPrice]);

  /**
   * 라벨을 점의 어느 쪽에 붙일지 정한다.
   *
   * 항상 바깥쪽(진입=왼쪽, 청산=오른쪽)으로 빼면 차트 가장자리에서 글자가 잘린다.
   * 가장자리에 가까우면 안쪽으로 뒤집는다.
   */
  const { entryAlign, exitAlign, entryDy, exitDy, stopSide } = useMemo(() => {
    const first = rows[0]?.t ?? 0;
    const last = rows[rows.length - 1]?.t ?? 0;
    const span = last - first;
    const frac = (t: number) => (span > 0 ? (t - first) / span : 0.5);

    // 일봉처럼 봉이 굵으면 진입·청산이 같거나 인접한 봉에 놓여 라벨이 겹친다.
    // 그럴 땐 좌우로 못 가르니 같은 쪽에 붙이고 가격이 높은 쪽을 위로 밀어낸다.
    const crowded =
      exitBar !== null && Math.abs(frac(exitBar) - frac(entryBar)) < 0.12;

    if (crowded) {
      const side = frac(entryBar) > 0.5 ? ("left" as const) : ("right" as const);
      const entryHigher = (entryPrice ?? 0) >= (exitPrice ?? 0);
      return {
        entryAlign: side,
        exitAlign: side,
        entryDy: entryHigher ? -16 : 16,
        exitDy: entryHigher ? 16 : -16,
        // 손절 라벨은 마커가 없는 쪽으로 보낸다.
        stopSide: frac(entryBar) > 0.5 ? ('left' as const) : ('right' as const),
      };
    }

    return {
      entryAlign: frac(entryBar) < 0.28 ? ('right' as const) : ('left' as const),
      exitAlign: exitBar !== null && frac(exitBar) > 0.72 ? ('left' as const) : ('right' as const),
      entryDy: 0,
      exitDy: 0,
      stopSide: frac(entryBar) > 0.5 ? ('left' as const) : ('right' as const),
    };
  }, [rows, entryBar, exitBar, entryPrice, exitPrice]);

  const held =
    exitPrice !== null && entryPrice !== null
      ? ((exitPrice - entryPrice) / entryPrice) * (side === "long" ? 1 : -1)
      : null;

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-medium">
          당시 차트{" "}
          <span className="font-normal text-dim">
            — {symbol}-USDT 무기한 · OKX
          </span>
        </h2>
        <div className="ml-auto flex gap-1">
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
        진입 {num(entryPrice)} → 청산 {exitPrice === null ? "—" : num(exitPrice)}
        {held !== null ? (
          <span className={held >= 0 ? "text-profit" : "text-loss"}> ({signed(held * 100, 2)}%)</span>
        ) : null}
      </p>

      <div className="mt-3">
        {error ? (
          <p className="rounded-lg border border-loss/40 px-3 py-6 text-center text-xs text-loss">
            {error}
          </p>
        ) : loading && rows.length === 0 ? (
          <p className="px-3 py-10 text-center text-xs text-dim">캔들 불러오는 중…</p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-10 text-center text-xs text-dim">
            이 구간의 캔들이 없습니다. OKX에 해당 기간 데이터가 없거나 종목명이 다를 수 있습니다.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                stroke="var(--text-dim)"
                fontSize={11}
                tickLine={false}
                axisLine={{ stroke: "var(--border)" }}
                minTickGap={40}
                tickFormatter={(t: number) => formatTick(t, bar)}
              />
              <YAxis
                orientation="right"
                stroke="var(--text-dim)"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={66}
                domain={priceDomain}
                tickFormatter={(v: number) => num(v, 0)}
              />

              {/*
                보유 구간 음영. 진입·청산이 같은 봉이면 폭이 0이 되어 사라지므로
                끝을 한 봉만큼 늘려 항상 최소 한 봉은 덮이게 한다.
              */}
              <ReferenceArea
                x1={entryBar}
                x2={(exitBar ?? entryBar) + BAR_MS[bar]}
                fill="var(--accent)"
                fillOpacity={0.1}
                stroke="none"
              />

              {/* 거래 구간의 시작·끝 경계 — 어느 봉부터 어느 봉까지인지 눈으로 세게 한다. */}
              <ReferenceLine x={entryBar} stroke="var(--accent)" strokeDasharray="3 3" />
              {exitBar !== null && exitBar !== entryBar ? (
                <ReferenceLine
                  x={exitBar + BAR_MS[bar]}
                  stroke="var(--beta)"
                  strokeDasharray="3 3"
                />
              ) : null}

              {/* 손절가만 가로선으로 남긴다 — 체결이 아니라 '그었던 선'이라서. */}
              {stopPrice !== null ? (
                <ReferenceLine
                  y={stopPrice}
                  stroke="var(--loss)"
                  strokeDasharray="2 4"
                  label={<LineLabel text={`손절 ${num(stopPrice)}`} align={stopSide} />}
                />
              ) : null}

              {/*
                진입·청산은 가로선+세로선을 겹치는 대신 체결이 일어난 좌표에 점을 찍는다.
                선 두 개가 교차하면 어느 쌍이 한 거래인지 눈으로 짝지어야 해서 헷갈린다.
              */}
              {entryPrice !== null ? (
                <ReferenceDot
                  x={entryBar}
                  y={entryPrice}
                  r={5}
                  fill="var(--accent)"
                  stroke="var(--surface)"
                  strokeWidth={2}
                  ifOverflow="extendDomain"
                  label={
                    <MarkerLabel
                      title={`진입 ${num(entryPrice)}`}
                      sub={formatFull(entryMs)}
                      color="var(--accent)"
                      align={entryAlign}
                      dy={entryDy}
                    />
                  }
                />
              ) : null}
              {exitPrice !== null && exitBar !== null ? (
                <ReferenceDot
                  x={exitBar}
                  y={exitPrice}
                  r={5}
                  fill="var(--beta)"
                  stroke="var(--surface)"
                  strokeWidth={2}
                  ifOverflow="extendDomain"
                  label={
                    <MarkerLabel
                      title={`청산 ${num(exitPrice)}`}
                      sub={formatFull(exitMs!)}
                      color="var(--beta)"
                      align={exitAlign}
                      dy={exitDy}
                    />
                  }
                />
              ) : null}

              <Tooltip
                cursor={{ fill: "var(--surface-2)", opacity: 0.5 }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const r = payload[0].payload as Row;
                  const change = r.o === 0 ? null : (r.c - r.o) / r.o;
                  return (
                    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg">
                      <div className="text-dim">{formatFull(r.t)}</div>
                      <div className="tnum mt-1 grid grid-cols-2 gap-x-3">
                        <span className="text-dim">시가</span>
                        <span className="text-right">{num(r.o)}</span>
                        <span className="text-dim">고가</span>
                        <span className="text-right">{num(r.h)}</span>
                        <span className="text-dim">저가</span>
                        <span className="text-right">{num(r.l)}</span>
                        <span className="text-dim">종가</span>
                        <span className={`text-right ${r.up ? "text-profit" : "text-loss"}`}>
                          {num(r.c)}
                        </span>
                        <span className="text-dim">변동</span>
                        <span className={`text-right ${r.up ? "text-profit" : "text-loss"}`}>
                          {pct(change)}
                        </span>
                      </div>
                    </div>
                  );
                }}
              />

              {/* 고-저 범위 막대 = 캔들. 색은 시가 대비 종가 방향. */}
              {/*
                거래에 걸친 봉만 또렷하게 두고 나머지는 흐리게 깐다.
                일봉처럼 배율이 크면 거래가 몇 봉 안 되어 그냥은 찾기 어렵다.
              */}
              <Bar dataKey="range" isAnimationActive={false} minPointSize={1}>
                {rows.map((r) => (
                  <Cell
                    key={r.t}
                    fill={r.up ? "var(--profit)" : "var(--loss)"}
                    fillOpacity={r.inTrade ? 1 : 0.32}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <p className="mt-2 text-[11px] text-dim">
        막대는 각 봉의 고가~저가 범위이고, 색은 시가 대비 종가 방향입니다.{" "}
        <b className="text-text">거래에 걸친 봉만 진하게</b> 두고 나머지는 흐리게 깔았습니다.{" "}
        <span className="text-accent">●</span> 진입 · <span className="text-beta">●</span> 청산
        지점에 가격과 시각을 함께 적었습니다.
      </p>
    </section>
  );
}

/**
 * 가로 기준선(손절가)에 붙는 라벨.
 *
 * Recharts의 `insideBottomLeft` 같은 내장 위치는 글자 폭을 고려하지 않아 왼쪽으로 넘쳐
 * 잘린다. 플롯 영역 좌표를 직접 받아 안쪽으로 들여 그린다.
 */
function LineLabel({
  viewBox,
  text,
  align,
}: {
  viewBox?: { x?: number; y?: number; width?: number };
  text: string;
  align: 'left' | 'right';
}) {
  const x = viewBox?.x;
  const y = viewBox?.y;
  const width = viewBox?.width;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number') return null;

  // Recharts가 넘겨주는 viewBox.x가 음수로 들어오는 경우가 있어 0으로 잘라낸다.
  const left = Math.max(x, 0);
  const inset = 8;
  return (
    <text
      x={align === 'left' ? left + inset : left + width - inset}
      y={y + 13}
      textAnchor={align === 'left' ? 'start' : 'end'}
      fontSize={10}
      fill="var(--loss)"
      stroke="var(--surface)"
      strokeWidth={3.5}
      paintOrder="stroke"
      pointerEvents="none"
    >
      {text}
    </text>
  );
}

/**
 * 체결 지점에 붙는 라벨 — 가격과 시각을 함께 적는다.
 *
 * 진입은 항상 청산보다 왼쪽에 있으므로 진입 라벨은 왼쪽, 청산 라벨은 오른쪽으로 빼면
 * 두 라벨이 겹치지 않는다. 캔들 위에 글자가 묻히지 않도록 배경색 테두리로 후광을 준다.
 */
function MarkerLabel({
  viewBox,
  title,
  sub,
  color,
  align,
  dy = 0,
}: {
  viewBox?: { x?: number; y?: number };
  title: string;
  sub: string;
  color: string;
  align: "left" | "right";
  /** 같은 봉에 두 라벨이 겹칠 때 세로로 밀어내는 양. */
  dy?: number;
}) {
  const x = viewBox?.x;
  const rawY = viewBox?.y;
  if (typeof x !== "number" || typeof rawY !== "number") return null;
  const y = rawY + dy;

  const gap = 11;
  const anchor = align === "left" ? "end" : "start";
  const tx = align === "left" ? x - gap : x + gap;
  const halo = {
    stroke: "var(--surface)",
    strokeWidth: 3.5,
    paintOrder: "stroke" as const,
  };

  return (
    <g pointerEvents="none">
      <text
        x={tx}
        y={y - 5}
        textAnchor={anchor}
        fontSize={11}
        fontWeight={600}
        fill={color}
        {...halo}
      >
        {title}
      </text>
      <text x={tx} y={y + 9} textAnchor={anchor} fontSize={10} fill="var(--text-dim)" {...halo}>
        {sub}
      </text>
    </g>
  );
}

const TICK_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function parts(ms: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of TICK_FMT.formatToParts(new Date(ms))) out[p.type] = p.value;
  if (out.hour === "24") out.hour = "00";
  return out;
}

/** 일봉은 날짜만, 그 아래는 시각까지. */
function formatTick(ms: number, bar: OkxBar): string {
  const p = parts(ms);
  return bar === "1D" ? `${p.month}.${p.day}` : `${p.month}.${p.day} ${p.hour}:${p.minute}`;
}

function formatFull(ms: number): string {
  const p = parts(ms);
  return `${p.month}.${p.day} ${p.hour}:${p.minute} KST`;
}
