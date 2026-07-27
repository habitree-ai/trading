"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceArea,
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

  const rows: Row[] = useMemo(
    () =>
      (candles ?? []).map((c) => ({
        ...c,
        range: [c.l, c.h] as [number, number],
        up: c.c >= c.o,
      })),
    [candles],
  );

  // 진입·청산이 속한 봉의 시작 시각 — 세로 표시를 그 봉에 정확히 얹기 위해.
  const barOf = (ms: number) => Math.floor(ms / BAR_MS[bar]) * BAR_MS[bar];
  const entryBar = barOf(entryMs);
  const exitBar = exitMs === null ? null : barOf(exitMs);

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

              {/* 보유 구간 음영 — 언제 들고 있었는지가 한눈에 보여야 한다. */}
              {exitBar !== null ? (
                <ReferenceArea
                  x1={entryBar}
                  x2={exitBar}
                  fill="var(--accent)"
                  fillOpacity={0.07}
                  stroke="none"
                />
              ) : null}

              {stopPrice !== null ? (
                <ReferenceLine
                  y={stopPrice}
                  stroke="var(--loss)"
                  strokeDasharray="2 4"
                  label={{ value: "손절", position: "insideBottomLeft", fill: "var(--loss)", fontSize: 10 }}
                />
              ) : null}
              {entryPrice !== null ? (
                <ReferenceLine
                  y={entryPrice}
                  stroke="var(--accent)"
                  strokeDasharray="4 4"
                  label={{ value: "진입", position: "insideTopLeft", fill: "var(--accent)", fontSize: 10 }}
                />
              ) : null}
              {exitPrice !== null ? (
                <ReferenceLine
                  y={exitPrice}
                  stroke="var(--beta)"
                  strokeDasharray="4 4"
                  label={{ value: "청산", position: "insideTopLeft", fill: "var(--beta)", fontSize: 10 }}
                />
              ) : null}

              <ReferenceLine x={entryBar} stroke="var(--accent)" strokeWidth={1.5} />
              {exitBar !== null ? (
                <ReferenceLine x={exitBar} stroke="var(--beta)" strokeWidth={1.5} />
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
              <Bar dataKey="range" isAnimationActive={false} minPointSize={1}>
                {rows.map((r) => (
                  <Cell key={r.t} fill={r.up ? "var(--profit)" : "var(--loss)"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <p className="mt-2 text-[11px] text-dim">
        막대는 각 봉의 고가~저가 범위이고, 색은 시가 대비 종가 방향입니다. 세로선이 진입·청산
        시점, 음영이 보유 구간입니다.
      </p>
    </section>
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
