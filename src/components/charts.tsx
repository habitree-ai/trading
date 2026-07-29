"use client";

import {
  Area,
  AreaChart,
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

import { num, pct, signed } from "@/lib/format";

/*
  색 규칙
  - 자금 곡선은 단일 계열이므로 범례 없이 제목이 계열을 지칭한다.
  - 손익 막대의 적/녹은 거래소 캡쳐와 색을 맞추기 위한 선택이다. 적녹색약에게 두 색은
    구분되지 않으므로(ΔE 3.3), 0선 기준 막대 방향과 항상 표기되는 +/− 부호로 이중 인코딩한다.
*/
const AXIS = { stroke: "var(--text-dim)", fontSize: 11 };
const GRID = "var(--border)";

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

export interface EquityPoint {
  label: string;
  equity: number;
  drawdown: number;
  pnl: number | null;
}

/**
 * 자금 곡선 — 단일 계열. 드로다운은 축이 다르므로 별도 차트로 분리한다(이중 축 금지).
 * 면적을 채우지 않는 선형이므로 y축을 0에서 시작하지 않아도 크기를 왜곡하지 않는다.
 * 대신 초기자금을 기준선으로 그어 원금 위/아래를 한눈에 읽게 한다.
 */
export function EquityCurve({
  data,
  currency,
  initialCapital,
}: {
  data: EquityPoint[];
  currency: string;
  initialCapital: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={24} />
        <YAxis
          {...AXIS}
          tickLine={false}
          axisLine={false}
          width={56}
          domain={["auto", "auto"]}
          tickFormatter={(v: number) => num(v, 0)}
        />
        <ReferenceLine
          y={initialCapital}
          stroke="var(--text-dim)"
          strokeDasharray="4 4"
          label={{ value: "초기자금", position: "insideTopLeft", fill: "var(--text-dim)", fontSize: 10 }}
        />
        <Tooltip
          cursor={{ stroke: "var(--text-dim)", strokeDasharray: "3 3" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as EquityPoint;
            return (
              <TooltipBox
                rows={[
                  [p.label, ""],
                  [`자금 (${currency})`, num(p.equity, 2)],
                  ["손익", signed(p.pnl), p.pnl && p.pnl > 0 ? "text-profit" : p.pnl && p.pnl < 0 ? "text-loss" : ""],
                  ["고점 대비", pct(p.drawdown), p.drawdown < 0 ? "text-loss" : ""],
                ]}
              />
            );
          }}
        />
        <Line
          type="monotone"
          dataKey="equity"
          stroke="var(--accent)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** 고점 대비 낙폭 — 항상 0 이하. 자금 곡선과 축이 다르므로 따로 그린다. */
export function DrawdownChart({ data }: { data: EquityPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={120}>
      <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={24} />
        <YAxis
          {...AXIS}
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(v: number) => pct(v, 0)}
        />
        <Tooltip
          cursor={{ stroke: "var(--text-dim)", strokeDasharray: "3 3" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as EquityPoint;
            return (
              <TooltipBox
                rows={[
                  [p.label, ""],
                  ["고점 대비", pct(p.drawdown), p.drawdown < 0 ? "text-loss" : ""],
                ]}
              />
            );
          }}
        />
        <Area
          type="monotone"
          dataKey="drawdown"
          stroke="var(--loss)"
          strokeWidth={2}
          fill="var(--loss)"
          fillOpacity={0.14}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export interface PnlBar {
  key: string;
  /** 축에 찍을 짧은 표기 — 일별은 `07-28`, 월별은 `2026-07`. */
  label: string;
  pnl: number;
  wins: number;
  losses: number;
  count: number;
}

/** 기간별 손익 — 부호는 0선 기준 막대 방향으로도 읽히므로 색에만 의존하지 않는다. */
export function PnlBars({ data, currency }: { data: PnlBar[]; currency: string }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={12} />
        <YAxis {...AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => num(v, 0)} />
        <ReferenceLine y={0} stroke="var(--text-dim)" />
        <Tooltip
          cursor={{ fill: "var(--surface-2)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as PnlBar;
            return (
              <TooltipBox
                rows={[
                  [p.key, ""],
                  [`손익 (${currency})`, signed(p.pnl), p.pnl > 0 ? "text-profit" : p.pnl < 0 ? "text-loss" : ""],
                  ["승 / 패", `${p.wins} / ${p.losses}`],
                  ["거래", `${p.count}건`],
                ]}
              />
            );
          }}
        />
        <Bar dataKey="pnl" radius={[4, 4, 0, 0]} maxBarSize={38}>
          {data.map((d) => (
            <Cell key={d.key} fill={d.pnl >= 0 ? "var(--profit)" : "var(--loss)"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
