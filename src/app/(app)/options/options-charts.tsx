"use client";

/**
 * 옵션 화면의 차트 넷 — 행사가별 OI · IV 기간구조 · GEX · OKX 풋콜비 추이.
 *
 * `@/components/charts` 의 AXIS·GRID·TooltipBox 관례를 그대로 따르되 그 파일을 건드리지
 * 않고 여기서 상수를 다시 둔다 — 그쪽은 자금 곡선(시간축·손익) 전용이고, 이쪽 축은
 * 행사가·잔여일이라 공유할 것이 색과 툴팁 모양뿐이다.
 *
 * 서버 컴포넌트가 계산을 끝낸 뒤 직렬화 가능한 배열만 넘긴다. 이 파일이 하는 계산은
 * "어느 범위를 그릴까"(현재가 ×0.5~×2) 와 선택한 만기의 행 고르기뿐이다 — 멀리 있는
 * 행사가(현재가의 4배짜리 콜 같은 것)는 OI 가 작아도 축을 늘려 본체를 뭉개 버린다.
 */

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { dateTime, num, pct } from "@/lib/format";
import { usdCompact } from "@/lib/options/format";
import type { GexRow, IvTermPoint, OkxHistoryPoint, StrikeRow } from "@/lib/options/types";

const AXIS = { stroke: "var(--text-dim)", fontSize: 11 };
const GRID = "var(--border)";
const HEIGHT = 240;

/** 행사가 축의 표시 범위 — 현재가 ×0.5 ~ ×2. 현재가가 없으면 전부 그린다. */
const RANGE_LO = 0.5;
const RANGE_HI = 2;

function inRange(strike: number, spot: number | null): boolean {
  return spot === null || (strike >= spot * RANGE_LO && strike <= spot * RANGE_HI);
}

/**
 * 행사가 묶음 단위.
 *
 * recharts 의 숫자축 막대는 폭을 "인접 x 값의 최소 픽셀 간격" 으로 잡는다. 전체 만기에는
 * $250 간격 행사가가 있어 $115,000 스팬에서 막대가 1~3px 실선이 된다. 그래서 막대 수가
 * MAX_BARS 를 넘으면 행사가를 반올림해 묶는다 — 묶으면 간격이 고르니 폭도 고르다.
 */
const BIN_STEPS = [0, 500, 1_000, 2_000, 5_000] as const;
const MAX_BARS = 60;

function pickStep(strikes: number[]): number {
  for (const step of BIN_STEPS) {
    const bins = new Set(strikes.map((s) => binStrike(s, step)));
    if (bins.size <= MAX_BARS) return step;
  }
  return BIN_STEPS[BIN_STEPS.length - 1];
}

function binStrike(strike: number, step: number): number {
  return step === 0 ? strike : Math.round(strike / step) * step;
}

/** 행사가별 행을 `step` 단위로 묶어 합친다. `add` 가 같은 묶음의 두 행을 더한다. */
function binRows<T extends { strike: number }>(rows: T[], step: number, add: (a: T, b: T) => T): T[] {
  const map = new Map<number, T>();
  for (const row of rows) {
    const key = binStrike(row.strike, step);
    const prev = map.get(key);
    map.set(key, prev ? add(prev, row) : { ...row, strike: key });
  }
  return [...map.values()].sort((a, b) => a.strike - b.strike);
}

function stepNote(step: number): string {
  return step === 0 ? "" : ` · 행사가 $${num(step, 0)} 단위로 묶음`;
}

/** 행사가 축 눈금 — `80k`. 다섯 자리 숫자를 그대로 찍으면 눈금끼리 겹친다. */
function strikeTick(value: number): string {
  return `${num(value / 1000, 0)}k`;
}

function TooltipBox({ rows }: { rows: [string, string, string?][] }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      {rows.map(([label, value, cls]) => (
        <div key={label} className="flex gap-3">
          <span className="text-dim">{label}</span>
          <span className={`tnum ml-auto ${cls ?? ""}`}>{value}</span>
        </div>
      ))}
    </div>
  );
}

/** 색 단독에 기대지 않도록 범례에 색 조각과 이름을 같이 둔다. */
function Legend({ items }: { items: [string, string][] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-dim">
      {items.map(([label, color]) => (
        <span key={label} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}

/* ── 행사가별 OI ─────────────────────────────────────────── */

/**
 * 행사가별 콜·풋 OI — 한 행사가에 콜 위·풋 아래로 쌓는다.
 *
 * 나란히 두 막대를 세우면 행사가가 촘촘한 근월 구간에서 막대가 1px 가 된다. 쌓으면
 * 막대 하나가 그 행사가의 총 OI 고, 색 비율이 콜·풋 몫이다. 현재가는 세로선, 콜벽·풋벽은
 * 전체 만기 기준이라 「전체」를 보고 있을 때만 그린다 — 개별 만기에서는 다른 행사가가 벽이다.
 */
export function StrikeOiChart({
  strikesByExpiry,
  expiries,
  spot,
  callWall,
  putWall,
}: {
  strikesByExpiry: Record<string, StrikeRow[]>;
  /** 만기 오름차순 — select 의 순서. */
  expiries: string[];
  spot: number | null;
  callWall: number | null;
  putWall: number | null;
}) {
  const [expiry, setExpiry] = useState("all");
  const rows = useMemo(() => strikesByExpiry[expiry] ?? [], [strikesByExpiry, expiry]);

  const { shown, hiddenOi, step } = useMemo(() => {
    const visible: StrikeRow[] = [];
    let hidden = 0;
    for (const row of rows) {
      if (inRange(row.strike, spot)) visible.push(row);
      else hidden += row.callOi + row.putOi;
    }
    const step = pickStep(visible.map((row) => row.strike));
    const binned = binRows(visible, step, (a, b) => ({
      strike: a.strike,
      callOi: a.callOi + b.callOi,
      putOi: a.putOi + b.putOi,
    }));
    return { shown: binned, hiddenOi: hidden, step };
  }, [rows, spot]);

  const showWalls = expiry === "all";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Legend
          items={[
            ["콜 OI", "var(--profit)"],
            ["풋 OI", "var(--loss)"],
          ]}
        />
        <select
          aria-label="만기 선택"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          className="ml-auto rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-text"
        >
          <option value="all">전체 만기</option>
          {expiries.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </div>
      {shown.length === 0 ? (
        <p className="py-10 text-center text-xs text-dim">그릴 행사가가 없습니다.</p>
      ) : (
        <ResponsiveContainer width="100%" height={HEIGHT}>
          <BarChart data={shown} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={0}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="strike"
              type="number"
              domain={["dataMin", "dataMax"]}
              padding={{ left: 8, right: 8 }}
              tickFormatter={strikeTick}
              tickLine={false}
              axisLine={{ stroke: GRID }}
              minTickGap={24}
              {...AXIS}
            />
            <YAxis {...AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => num(v, 0)} />
            <Tooltip
              cursor={{ fill: "var(--surface-2)" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as StrikeRow;
                return (
                  <TooltipBox
                    rows={[
                      [`행사가 ${step === 0 ? "" : "≈ "}$${num(p.strike, 0)}`, ""],
                      ["콜 OI (BTC)", num(p.callOi, 1), "text-profit"],
                      ["풋 OI (BTC)", num(p.putOi, 1), "text-loss"],
                      ["합", num(p.callOi + p.putOi, 1)],
                    ]}
                  />
                );
              }}
            />
            {spot !== null ? (
              <ReferenceLine
                x={spot}
                ifOverflow="extendDomain"
                stroke="var(--accent)"
                strokeDasharray="4 4"
                label={{ value: "현재가", position: "insideTopLeft", fill: "var(--accent)", fontSize: 10 }}
              />
            ) : null}
            {showWalls && callWall !== null ? (
              <ReferenceLine
                x={callWall}
                stroke="var(--profit)"
                strokeDasharray="2 3"
                label={{ value: `콜벽 ${strikeTick(callWall)}`, position: "insideTopRight", fill: "var(--profit)", fontSize: 10 }}
              />
            ) : null}
            {showWalls && putWall !== null ? (
              <ReferenceLine
                x={putWall}
                stroke="var(--loss)"
                strokeDasharray="2 3"
                label={{ value: `풋벽 ${strikeTick(putWall)}`, position: "insideBottomLeft", fill: "var(--loss)", fontSize: 10 }}
              />
            ) : null}
            <Bar dataKey="putOi" stackId="oi" fill="var(--loss)" isAnimationActive={false} />
            <Bar dataKey="callOi" stackId="oi" fill="var(--profit)" isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      )}
      <p className="tnum text-[11px] text-dim">
        {spot === null ? "기준가가 없어 전 행사가를 그렸습니다." : "표시 범위 현재가 ×0.5 ~ ×2"}
        {stepNote(step)}
        {hiddenOi > 0 ? ` · 표시 밖 OI ${num(hiddenOi, 0)} BTC` : ""}
        {!showWalls ? " · 콜벽·풋벽은 전체 만기 기준이라 개별 만기에서는 표시하지 않습니다" : ""}
      </p>
    </div>
  );
}

/* ── IV 기간구조 ─────────────────────────────────────────── */

/** 만기별 ATM IV — 가로는 잔여일(D), 세로는 연율 %. 점이 몇 개 안 되니 점을 보이게 둔다. */
export function IvTermChart({ data }: { data: IvTermPoint[] }) {
  if (data.length === 0) {
    return <p className="py-10 text-center text-xs text-dim">IV 재료가 없어 기간구조를 그리지 못했습니다.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="dte"
          type="number"
          domain={[0, "dataMax"]}
          tickFormatter={(v: number) => `D-${num(v, 0)}`}
          tickLine={false}
          axisLine={{ stroke: GRID }}
          minTickGap={24}
          {...AXIS}
        />
        <YAxis
          {...AXIS}
          tickLine={false}
          axisLine={false}
          width={56}
          domain={["auto", "auto"]}
          tickFormatter={(v: number) => pct(v, 0)}
        />
        <Tooltip
          cursor={{ stroke: "var(--text-dim)", strokeDasharray: "3 3" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as IvTermPoint;
            return (
              <TooltipBox
                rows={[
                  [p.expiry, `D-${num(p.dte, 1)}`],
                  ["ATM IV", pct(p.atmIv, 1)],
                ]}
              />
            );
          }}
        />
        <Line
          type="monotone"
          dataKey="atmIv"
          stroke="var(--accent)"
          strokeWidth={2}
          dot={{ r: 3, fill: "var(--accent)", strokeWidth: 0 }}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/* ── GEX ─────────────────────────────────────────────────── */

/**
 * 행사가별 GEX — 0선 기준 위(양수·롱감마)와 아래(음수·숏감마). 부호는 막대 방향으로도
 * 읽히므로 색에만 기대지 않는다. 현재가와 플립 행사가는 세로선.
 */
export function GexChart({
  data,
  spot,
  flipStrike,
}: {
  data: GexRow[];
  spot: number | null;
  flipStrike: number | null;
}) {
  const { shown, hiddenCount, step } = useMemo(() => {
    const visible = data.filter((row) => inRange(row.strike, spot));
    const step = pickStep(visible.map((row) => row.strike));
    const binned = binRows(visible, step, (a, b) => ({ strike: a.strike, gex: a.gex + b.gex }));
    return { shown: binned, hiddenCount: data.length - visible.length, step };
  }, [data, spot]);

  if (shown.length === 0) {
    return <p className="py-10 text-center text-xs text-dim">IV 재료가 없어 감마를 그리지 못했습니다.</p>;
  }

  return (
    <div className="space-y-2">
      <Legend
        items={[
          ["양수 — 딜러 롱감마(억제)", "var(--profit)"],
          ["음수 — 딜러 숏감마(확대)", "var(--loss)"],
        ]}
      />
      <ResponsiveContainer width="100%" height={HEIGHT}>
        <BarChart data={shown} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={0}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="strike"
            type="number"
            domain={["dataMin", "dataMax"]}
            padding={{ left: 8, right: 8 }}
            tickFormatter={strikeTick}
            tickLine={false}
            axisLine={{ stroke: GRID }}
            minTickGap={24}
            {...AXIS}
          />
          <YAxis {...AXIS} tickLine={false} axisLine={false} width={60} tickFormatter={(v: number) => usdCompact(v)} />
          <ReferenceLine y={0} stroke="var(--text-dim)" />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as GexRow;
              return (
                <TooltipBox
                  rows={[
                    [`행사가 ${step === 0 ? "" : "≈ "}$${num(p.strike, 0)}`, ""],
                    ["GEX / 1%", usdCompact(p.gex), p.gex > 0 ? "text-profit" : p.gex < 0 ? "text-loss" : ""],
                  ]}
                />
              );
            }}
          />
          {spot !== null ? (
            <ReferenceLine
              x={spot}
              ifOverflow="extendDomain"
              stroke="var(--accent)"
              strokeDasharray="4 4"
              label={{ value: "현재가", position: "insideTopLeft", fill: "var(--accent)", fontSize: 10 }}
            />
          ) : null}
          {flipStrike !== null ? (
            <ReferenceLine
              x={flipStrike}
              stroke="var(--beta)"
              strokeDasharray="2 3"
              label={{ value: `플립 ${strikeTick(flipStrike)}`, position: "insideTopRight", fill: "var(--beta)", fontSize: 10 }}
            />
          ) : null}
          <Bar dataKey="gex" isAnimationActive={false}>
            {shown.map((row) => (
              <Cell key={row.strike} fill={row.gex >= 0 ? "var(--profit)" : "var(--loss)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className="tnum text-[11px] text-dim">
        {spot === null ? "기준가가 없어 전 행사가를 그렸습니다." : "표시 범위 현재가 ×0.5 ~ ×2"}
        {stepNote(step)}
        {hiddenCount > 0 ? ` · 표시 밖 행사가 ${hiddenCount}개` : ""}
      </p>
    </div>
  );
}

/* ── OKX 추이 ────────────────────────────────────────────── */

/** 추이 축의 눈금 — `09.15` 만. 24일치라 연도는 군더더기다. */
function historyTick(t: number): string {
  return dateTime(new Date(t).toISOString()).slice(3, 8);
}

/**
 * OKX 풋콜비 추이 — OI 기준(실선)과 거래량 기준(점선)을 한 축에 겹친다.
 * 둘 다 비율이라 축이 같고, 잔고(OI)는 느리게·거래량은 빠르게 움직이는 것이 한눈에 대비된다.
 */
export function PcrHistoryChart({ data }: { data: OkxHistoryPoint[] }) {
  if (data.length === 0) {
    return <p className="py-10 text-center text-xs text-dim">OKX 이력을 받지 못했습니다.</p>;
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-dim">
        <span className="flex items-center gap-1.5">
          <svg width="18" height="8" aria-hidden>
            <line x1="0" y1="4" x2="18" y2="4" stroke="var(--accent)" strokeWidth="2" />
          </svg>
          풋콜비 (OI)
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="18" height="8" aria-hidden>
            <line x1="0" y1="4" x2="18" y2="4" stroke="var(--alpha)" strokeWidth="2" strokeDasharray="4 3" />
          </svg>
          풋콜비 (거래량)
        </span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={historyTick}
            tickLine={false}
            axisLine={{ stroke: GRID }}
            minTickGap={28}
            {...AXIS}
          />
          <YAxis
            {...AXIS}
            tickLine={false}
            axisLine={false}
            width={44}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => num(v, 2)}
          />
          <ReferenceLine y={1} stroke="var(--text-dim)" strokeDasharray="4 4" />
          <Tooltip
            cursor={{ stroke: "var(--text-dim)", strokeDasharray: "3 3" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as OkxHistoryPoint;
              return (
                <TooltipBox
                  rows={[
                    [dateTime(new Date(p.t).toISOString()), ""],
                    ["풋콜비 (OI)", num(p.pcrOi, 2)],
                    ["풋콜비 (거래량)", num(p.pcrVol, 2)],
                    ["OI (BTC)", num(p.oi, 0)],
                    ["구간 거래량 (BTC)", num(p.vol, 0)],
                  ]}
                />
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="pcrVol"
            stroke="var(--alpha)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="pcrOi"
            stroke="var(--accent)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
