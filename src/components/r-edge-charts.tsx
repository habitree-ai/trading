"use client";

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

import { TooltipBox } from "@/components/charts";
import { dateTime, num, signed } from "@/lib/format";
import type { RBin, RPoint } from "@/lib/r-edge-report";

/*
  R 엣지 탭의 그림 셋(REQ-0089). 축·격자·툴팁은 charts.tsx 와 같은 규칙을 쓴다.
  - 가로축은 시각이 아니라 거래 순서다. R 은 거래 한 건마다 하나라, "최근 20건 이동 엣지"를
    읽으려면 거래 간격이 아니라 거래 수가 축이어야 한다.
  - 분포 막대의 적/녹은 0R 기준 왼쪽·오른쪽 위치로도 읽힌다(색 하나에만 기대지 않는다).
  - 이동 엣지 두 선은 실선(20건)·점선(50건)으로도 구분하고, 범례를 단다.
*/
const AXIS = { stroke: "var(--text-dim)", fontSize: 11 };
const GRID = "var(--border)";

const rText = (v: number) => `${signed(v, 2)}R`;
const tone = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "");

/** R 배수 분포 — 0.5R 폭 막대. 0R 왼쪽이 진 거래, 오른쪽이 이긴 거래. */
export function RDistribution({ bins }: { bins: RBin[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={bins} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={2}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={{ stroke: GRID }} interval={1} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: "var(--surface-2)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const b = payload[0].payload as RBin;
            return <TooltipBox rows={[[`${b.label}R`, ""], ["거래", `${b.count}건`]]} />;
          }}
        />
        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
          {bins.map((b) => (
            <Cell key={b.from} fill={b.from >= 0 ? "var(--profit)" : "var(--loss)"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function PointTooltip({ p, extra }: { p: RPoint; extra: [string, string, string?][] }) {
  return (
    <TooltipBox
      rows={[
        [`#${p.seq} ${p.symbol}`, dateTime(new Date(p.t).toISOString())],
        ["이 거래", rText(p.r), tone(p.r)],
        ...extra,
      ]}
    />
  );
}

/** 누적 R — 단일 계열이라 범례 없이 제목이 계열을 지칭한다. */
export function CumulativeR({ points }: { points: RPoint[] }) {
  const data = points.map((p, i) => ({ ...p, n: i + 1 }));
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="n" {...AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={24} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => num(v, 0)} />
        <ReferenceLine y={0} stroke="var(--text-dim)" />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as RPoint;
            return <PointTooltip p={p} extra={[["누적", rText(p.cum), tone(p.cum)]]} />;
          }}
        />
        <Line type="linear" dataKey="cum" stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** 최근 20건·50건 이동 엣지 — 창이 차기 전 구간은 비운다. */
export function RollingEdge({ points }: { points: RPoint[] }) {
  const data = points.map((p, i) => ({ ...p, n: i + 1 }));
  return (
    <div>
      <div className="mb-1 flex gap-4 text-xs text-dim">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-accent" />
          최근 20건
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 border-t-2 border-dashed border-dim" />
          최근 50건
        </span>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="n" {...AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={24} />
          <YAxis {...AXIS} tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => num(v, 1)} />
          <ReferenceLine y={0} stroke="var(--text-dim)" />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as RPoint;
              return (
                <PointTooltip
                  p={p}
                  extra={[
                    ["최근 20건", p.roll20 === null ? "—" : rText(p.roll20), p.roll20 === null ? "" : tone(p.roll20)],
                    ["최근 50건", p.roll50 === null ? "—" : rText(p.roll50), p.roll50 === null ? "" : tone(p.roll50)],
                  ]}
                />
              );
            }}
          />
          <Line
            type="linear"
            dataKey="roll20"
            stroke="var(--accent)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            type="linear"
            dataKey="roll50"
            stroke="var(--text-dim)"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
