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

import { num, pct, pnlClass, signed } from "@/lib/format";

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
  /** 거래소에 실제로 있는 돈 — 입금이면 오르고 출금이면 내려간다. */
  equity: number;
  /** 넣고 뺀 돈을 걷어낸 매매 성과 — 초기자금 + 누적 실현손익. */
  performance: number;
  /** 이 시점까지 거래계좌에서 빠져나간 금액 누계(양수). */
  withdrawn: number;
  /** 이 거래에서 빠져나간 금액(양수) — 0이면 출금이 없었다. */
  withdrawnStep: number;
  drawdown: number;
  pnl: number | null;
  /** 같은 시점의 벤치마크 시세 — 축이 달라 우측 눈금에 붙는다. 못 받았으면 null */
  benchmark?: number | null;
}

/** 색 단독에 기대지 않도록 선 모양(실선/점선)까지 다르게 쓰고 범례에 그대로 옮긴다. */
function Legend({ items }: { items: [string, string, boolean][] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-dim">
      {items.map(([label, color, dashed]) => (
        <span key={label} className="flex items-center gap-1.5">
          <svg width="18" height="8" aria-hidden>
            <line
              x1="0"
              y1="4"
              x2="18"
              y2="4"
              stroke={color}
              strokeWidth="2"
              strokeDasharray={dashed ? "4 3" : undefined}
            />
          </svg>
          {label}
        </span>
      ))}
    </div>
  );
}

/**
 * 자금 곡선 — 실제 잔액과 매매 성과를 겹쳐 그린다.
 *
 * 잔액 하나만 보면 곡선이 오른 게 잘 벌어서인지 돈을 더 넣어서인지, 내린 게 잃어서인지
 * 뽑아 가서인지 구분되지 않는다. 출금은 자금이 줄어든 게 아니다 — 그래서 넣고 뺀 돈을
 * 걷어낸 성과 곡선을 함께 그리고, 출금이 일어난 지점은 잔액 곡선 위에 점으로 찍는다.
 *
 * 드로다운·누적 출금은 축이 다르므로 별도 차트로 분리한다(이중 축 금지).
 * 면적을 채우지 않는 선형이므로 y축을 0에서 시작하지 않아도 크기를 왜곡하지 않는다.
 */
export function EquityCurve({
  data,
  currency,
  initialCapital,
  benchmarkLabel = null,
}: {
  data: EquityPoint[];
  currency: string;
  initialCapital: number;
  /** 벤치마크 종목명. null이면 그 선과 우축을 그리지 않는다 */
  benchmarkLabel?: string | null;
}) {
  const hasWithdrawal = data.some((d) => d.withdrawnStep > 0);
  // 못 받아 온 벤치마크로 빈 축을 세우지 않는다.
  const hasBenchmark =
    benchmarkLabel !== null && data.some((d) => typeof d.benchmark === "number");

  return (
    <div className="space-y-2">
      <Legend
        items={[
          ["실제 잔액", "var(--accent)", false],
          ["매매 성과 (입출금 제외)", "var(--alpha)", true],
          ...(hasBenchmark
            ? ([[`${benchmarkLabel} 시세 (우축)`, "var(--text-dim)", false]] as [
                string,
                string,
                boolean,
              ][])
            : []),
        ]}
      />
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" {...AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={24} />
          <YAxis
            yAxisId="left"
            {...AXIS}
            tickLine={false}
            axisLine={false}
            width={56}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => num(v, 0)}
          />
          {hasBenchmark ? (
            <YAxis
              yAxisId="right"
              orientation="right"
              {...AXIS}
              tickLine={false}
              axisLine={false}
              width={56}
              domain={["auto", "auto"]}
              tickFormatter={(v: number) => num(v, 0)}
            />
          ) : null}
          <ReferenceLine
            yAxisId="left"
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
                    [`실제 잔액 (${currency})`, num(p.equity, 2)],
                    ["매매 성과", num(p.performance, 2), pnlClass(p.performance - initialCapital)],
                    ...(hasBenchmark
                      ? ([[`${benchmarkLabel} 시세`, num(p.benchmark ?? null, 0)]] as [
                          string,
                          string,
                          string?,
                        ][])
                      : []),
                    ["손익", signed(p.pnl), pnlClass(p.pnl)],
                    ...(hasWithdrawal
                      ? ([
                          ["이번 출금", p.withdrawnStep > 0 ? `−${num(p.withdrawnStep, 2)}` : "—",
                            p.withdrawnStep > 0 ? "text-beta" : ""],
                          ["누적 출금", p.withdrawn > 0 ? `−${num(p.withdrawn, 2)}` : "—"],
                        ] as [string, string, string?][])
                      : []),
                    ["고점 대비", pct(p.drawdown), p.drawdown < 0 ? "text-loss" : ""],
                  ]}
                />
              );
            }}
          />
          {/* 벤치마크를 맨 아래 깔아 자금 곡선이 가려지지 않게 한다. */}
          {hasBenchmark ? (
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="benchmark"
              stroke="var(--text-dim)"
              strokeWidth={1.5}
              strokeOpacity={0.55}
              dot={false}
              activeDot={false}
              connectNulls
            />
          ) : null}
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="performance"
            stroke="var(--alpha)"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            activeDot={false}
          />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="equity"
            stroke="var(--accent)"
            strokeWidth={2}
            // 출금이 일어난 지점만 점으로 찍는다 — 곡선이 꺾인 이유를 그 자리에서 알리기 위해.
            dot={(props) => {
              const { cx, cy, payload, index } = props as {
                cx?: number;
                cy?: number;
                index: number;
                payload: EquityPoint;
              };
              if (payload.withdrawnStep <= 0 || cx === undefined || cy === undefined) {
                return <g key={`nodot-${index}`} />;
              }
              return (
                <circle
                  key={`w-${index}`}
                  cx={cx}
                  cy={cy}
                  r={4}
                  fill="var(--beta)"
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              );
            }}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
          />
        </LineChart>
      </ResponsiveContainer>
      {hasWithdrawal ? (
        <p className="text-[11px] text-dim">
          <span className="text-beta">●</span> 표시는 그 거래 구간에 출금이 있었던 지점입니다. 두 선의
          간격이 벌어질수록 계좌 밖으로 뺀 돈(또는 넣은 돈)이 많다는 뜻입니다.
        </p>
      ) : null}
    </div>
  );
}

/**
 * 누적 출금 — 계좌에서 뽑아 간 돈이 얼마나 쌓였는지.
 *
 * 계단형으로 그린다. 출금은 이어지는 흐름이 아니라 특정 시점에 한 번씩 일어나는
 * 사건이라, 점을 부드럽게 이으면 없던 날에도 조금씩 빠져나간 것처럼 보인다.
 */
export function WithdrawalChart({ data, currency }: { data: EquityPoint[]; currency: string }) {
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
          tickFormatter={(v: number) => num(v, 0)}
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
                  [`누적 출금 (${currency})`, num(p.withdrawn, 2)],
                  ["이번 출금", p.withdrawnStep > 0 ? num(p.withdrawnStep, 2) : "—"],
                ]}
              />
            );
          }}
        />
        <Area
          type="stepAfter"
          dataKey="withdrawn"
          stroke="var(--beta)"
          strokeWidth={2}
          fill="var(--beta)"
          fillOpacity={0.14}
          dot={false}
        />
      </AreaChart>
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
