"use client";

import { useMemo, useState } from "react";
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

import { date, num, pct, pnlClass, signed, signedPct } from "@/lib/format";

/*
  색 규칙
  - 자금 곡선은 단일 계열이므로 범례 없이 제목이 계열을 지칭한다.
  - 손익 막대의 적/녹은 거래소 캡쳐와 색을 맞추기 위한 선택이다. 적녹색약에게 두 색은
    구분되지 않으므로(ΔE 3.3), 0선 기준 막대 방향과 항상 표기되는 +/− 부호로 이중 인코딩한다.
*/
const AXIS = { stroke: "var(--text-dim)", fontSize: 11 };
const GRID = "var(--border)";

/**
 * 가로축은 거래 순번이 아니라 시각이다.
 *
 * 순번축에서는 하루에 세 번 들어갔다 나온 날과 아무것도 없던 2주가 같은 폭으로
 * 그려진다 — 곡선의 기울기가 "얼마나 빨리 벌었나"를 뜻하지 못하고, 벤치마크 시세와
 * 시점도 어긋난다. 시각에 비례한 축으로 두면 몰린 구간은 몰린 채로, 빈 구간은
 * 빈 채로 읽힌다.
 *
 * 세 차트가 같은 설정을 쓴다. 위아래로 겹쳐 읽는 그림이라 눈금이 어긋나면
 * 같은 시점을 다른 자리에서 찾게 된다.
 */
const TIME_AXIS = {
  dataKey: "t",
  type: "number" as const,
  scale: "time" as const,
  domain: ["dataMin", "dataMax"] as [string, string],
  // 축이 좁아 연도를 떼고 `07.25`로 줄인다.
  tickFormatter: (v: number) => date(new Date(v).toISOString()).slice(3),
  tickLine: false,
  axisLine: { stroke: GRID },
  minTickGap: 28,
  ...AXIS,
};

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
  /** 가로축 좌표 — 이 점이 찍힌 시각(epoch ms). */
  t: number;
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
  /**
   * 거래소가 말한 잔액(스냅샷, 미실현 포함) — 장부(`equity`)와 벌어진 만큼이 미실현 손익과
   * 장부가 놓친 비용이다. 스냅샷이 없는 행은 null 이고, 이어지지 않는 날 사이는 null 로 끊는다.
   */
  snapshot?: number | null;
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

/** 세로축 단위 — 기본은 판단에 유리한 수익률이다. */
type AxisMode = "pct" | "amount";

/**
 * 축 단위 토글.
 *
 * 수익률 축은 "시장보다 나은가"에 답하고, 금액 축은 "지금 얼마인가"에 답한다.
 * 매일 보는 질문은 앞쪽이라 그쪽을 기본값으로 둔다. 상태는 저장하지 않는다 —
 * 매번 판단에 유리한 그림으로 열리는 편이 낫다.
 */
function AxisToggle({ mode, onChange }: { mode: AxisMode; onChange: (next: AxisMode) => void }) {
  const options: [AxisMode, string][] = [
    ["pct", "수익률 %"],
    ["amount", "금액"],
  ];
  return (
    <div
      className="ml-auto inline-flex rounded-lg border border-border p-0.5"
      role="group"
      aria-label="세로축 단위"
    >
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          aria-pressed={mode === value}
          className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
            mode === value ? "bg-surface-2 font-medium" : "text-dim"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** 곡선 한 점 + 시작 대비 수익률로 환산한 값. */
type CurveRow = EquityPoint & {
  equityPct: number;
  performancePct: number;
  /** 벤치마크는 구간 앞쪽이 비어 있을 수 있다 — 기준점을 못 잡으면 null. */
  benchmarkPct: number | null;
  /** 거래소 잔액을 장부와 같은 분모로 환산한 값. 스냅샷이 없는 행은 null. */
  snapshotPct: number | null;
};

/**
 * 자금 곡선 — 실제 잔액과 매매 성과를 겹쳐 그린다.
 *
 * 잔액 하나만 보면 곡선이 오른 게 잘 벌어서인지 돈을 더 넣어서인지, 내린 게 잃어서인지
 * 뽑아 가서인지 구분되지 않는다. 출금은 자금이 줄어든 게 아니다 — 그래서 넣고 뺀 돈을
 * 걷어낸 성과 곡선을 함께 그리고, 출금이 일어난 지점은 잔액 곡선 위에 점으로 찍는다.
 *
 * 세로축은 고를 수 있고 **기본은 수익률**이다. 금액 축에서는 잔액과 벤치마크가 각자
 * 눈금을 잡아(둘 다 auto) 내가 +20%인 구간과 시장이 +80%인 구간이 나란한 두 선으로
 * 보인다 — 기울기 비교가 원리적으로 안 된다. 같은 축에 수익률로 얹어야 이겼는지가
 * 보인다. 잔액 자체의 움직임이 필요하면 금액 축으로 되돌린다.
 *
 * 드로다운·누적 출금은 축이 다르므로 별도 차트로 분리한다(이중 축 금지).
 * 면적을 채우지 않는 선형이므로 y축을 0에서 시작하지 않아도 크기를 왜곡하지 않는다.
 */
export function EquityCurve({
  data,
  currency,
  initialCapital,
  returnBase,
  benchmarkLabel = null,
}: {
  data: EquityPoint[];
  currency: string;
  initialCapital: number;
  /**
   * 수익률의 분모 — 대시보드 `수익률` 타일과 같은 투입원금을 받는다.
   *
   * 초기자금으로 나누면 나중에 넣은 돈이 분모에서 빠져 곡선이 타일보다 높은 수익률을
   * 말한다. 같은 화면에서 두 숫자가 갈리면 어느 쪽을 믿을지부터 판단해야 한다.
   * 입금이 없었으면 초기자금과 같은 값이다.
   */
  returnBase?: number;
  /** 벤치마크 종목명. null이면 그 선을 그리지 않는다 */
  benchmarkLabel?: string | null;
}) {
  const hasWithdrawal = data.some((d) => d.withdrawnStep > 0);
  // 못 받아 온 벤치마크로 빈 축을 세우지 않는다.
  const hasBenchmark =
    benchmarkLabel !== null && data.some((d) => typeof d.benchmark === "number");
  // 스냅샷이 한 점도 없으면(수동 북) 그 선과 범례를 아예 두지 않는다.
  const hasSnapshot = data.some((d) => typeof d.snapshot === "number");
  // 분모가 0 이하면 수익률을 낼 수 없다 — 토글을 감추고 금액 축으로 고정한다.
  const base = returnBase ?? initialCapital;
  const canPct = base > 0;

  const [mode, setMode] = useState<AxisMode>("pct");
  const pctMode = canPct && mode === "pct";

  const rows = useMemo<CurveRow[]>(() => {
    // 벤치마크의 기준점은 값이 처음 있는 점이다 — 구간 앞쪽이 비어 있을 수 있다.
    const mark = data.find((d) => typeof d.benchmark === "number")?.benchmark ?? null;
    return data.map((d) => ({
      ...d,
      // 분자는 시작 시점(초기자금) 대비 증감, 분모는 투입원금 — 타일의 수익률과 같은 정의다.
      equityPct: canPct ? (d.equity - initialCapital) / base : 0,
      performancePct: canPct ? (d.performance - initialCapital) / base : 0,
      benchmarkPct:
        mark !== null && mark !== 0 && typeof d.benchmark === "number"
          ? (d.benchmark - mark) / mark
          : null,
      snapshotPct:
        canPct && typeof d.snapshot === "number" ? (d.snapshot - initialCapital) / base : null,
    }));
  }, [data, initialCapital, base, canPct]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Legend
          items={[
            [hasSnapshot ? "장부 잔액 (거래 기반)" : "실제 잔액", "var(--accent)", false],
            ["매매 성과 (입출금 제외)", "var(--alpha)", true],
            ...(hasSnapshot
              ? ([["실제 잔액 (거래소 스냅샷 · 미실현 포함)", "var(--beta)", false]] as [
                  string,
                  string,
                  boolean,
                ][])
              : []),
            ...(hasBenchmark
              ? ([
                  [
                    pctMode ? `${benchmarkLabel} 수익률` : `${benchmarkLabel} 시세 (우축)`,
                    "var(--text-dim)",
                    false,
                  ],
                ] as [string, string, boolean][])
              : []),
          ]}
        />
        {canPct ? <AxisToggle mode={mode} onChange={setMode} /> : null}
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis {...TIME_AXIS} />
          <YAxis
            yAxisId="left"
            {...AXIS}
            tickLine={false}
            axisLine={false}
            width={56}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => (pctMode ? pct(v, 0) : num(v, 0))}
          />
          {hasBenchmark && !pctMode ? (
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
            y={pctMode ? 0 : initialCapital}
            stroke="var(--text-dim)"
            strokeDasharray="4 4"
            label={{
              value: pctMode ? "시작" : "초기자금",
              position: "insideTopLeft",
              fill: "var(--text-dim)",
              fontSize: 10,
            }}
          />
          <Tooltip
            cursor={{ stroke: "var(--text-dim)", strokeDasharray: "3 3" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as CurveRow;
              // 시장 대비는 성과 곡선 기준이다 — 실제 잔액에는 입출금이 섞여 있다.
              const excess = p.benchmarkPct === null ? null : p.performancePct - p.benchmarkPct;
              return (
                <TooltipBox
                  rows={[
                    [p.label, ""],
                    [`${hasSnapshot ? "장부 잔액" : "실제 잔액"} (${currency})`, num(p.equity, 2)],
                    ...(hasSnapshot
                      ? ([
                          [
                            "실제 잔액 (거래소)",
                            typeof p.snapshot === "number" ? num(p.snapshot, 2) : "—",
                            typeof p.snapshot === "number" ? "text-beta" : "",
                          ],
                          ...(canPct && p.snapshotPct !== null
                            ? [["거래소 수익률", signedPct(p.snapshotPct), pnlClass(p.snapshotPct)]]
                            : []),
                        ] as [string, string, string?][])
                      : []),
                    ...(canPct
                      ? ([["잔액 수익률", signedPct(p.equityPct), pnlClass(p.equityPct)]] as [
                          string,
                          string,
                          string?,
                        ][])
                      : []),
                    ["매매 성과", num(p.performance, 2), pnlClass(p.performance - initialCapital)],
                    ...(canPct
                      ? ([
                          ["성과 수익률", signedPct(p.performancePct), pnlClass(p.performancePct)],
                        ] as [string, string, string?][])
                      : []),
                    ...(hasBenchmark
                      ? ([[`${benchmarkLabel} 시세`, num(p.benchmark ?? null, 0)]] as [
                          string,
                          string,
                          string?,
                        ][])
                      : []),
                    ...(hasBenchmark && p.benchmarkPct !== null
                      ? ([[`${benchmarkLabel} 수익률`, signedPct(p.benchmarkPct)]] as [
                          string,
                          string,
                          string?,
                        ][])
                      : []),
                    ...(canPct && excess !== null
                      ? ([["시장 대비", signedPct(excess), pnlClass(excess)]] as [
                          string,
                          string,
                          string?,
                        ][])
                      : []),
                    ["손익", signed(p.pnl), pnlClass(p.pnl)],
                    ...(hasWithdrawal
                      ? ([
                          [
                            "이번 출금",
                            p.withdrawnStep > 0 ? `−${num(p.withdrawnStep, 2)}` : "—",
                            p.withdrawnStep > 0 ? "text-beta" : "",
                          ],
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
              yAxisId={pctMode ? "left" : "right"}
              type="monotone"
              dataKey={pctMode ? "benchmarkPct" : "benchmark"}
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
            dataKey={pctMode ? "performancePct" : "performance"}
            stroke="var(--alpha)"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            activeDot={false}
          />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey={pctMode ? "equityPct" : "equity"}
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
          {/* 거래소 잔액 — 이어지지 않는 날 사이는 null 이라 여기서 끊긴다(connectNulls 금지). */}
          {hasSnapshot ? (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey={pctMode ? "snapshotPct" : "snapshot"}
              stroke="var(--beta)"
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 2, stroke: "var(--surface)" }}
            />
          ) : null}
        </LineChart>
      </ResponsiveContainer>
      {hasSnapshot ? (
        <p className="text-[11px] text-dim">
          <span className="text-beta">—</span> 거래소 잔액은 하루에 마지막 스냅샷 하나로 그립니다.
          이어지지 않는 날 사이는 선을 끊어 두었습니다 — 빈 구간을 &ldquo;변동 없음&rdquo;으로 읽지
          않게. 장부 선과의 간격이 미실현 손익과 장부가 놓친 비용입니다.
        </p>
      ) : null}
      {pctMode && hasBenchmark ? (
        <p className="text-[11px] text-dim">
          시장과 견줄 선은 <span className="text-alpha">매매 성과</span>입니다 — 실제 잔액에는
          넣고 뺀 돈이 섞여 있어 수익률로 바꿔도 그만큼 부풀거나 꺼집니다.
        </p>
      ) : null}
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
        <XAxis {...TIME_AXIS} />
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
        <XAxis {...TIME_AXIS} />
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

/** 시스템(봇) 잔고 곡선의 한 점 — 사이클마다 남는 스냅샷 하나. */
export interface SystemEquityPoint {
  t: number;
  label: string;
  equity: number;
  /** 그 시점 열려 있던 기준 이름 — 곡선이 꺾인 자리에 무엇이 물려 있었는지. */
  open: string;
}

/**
 * 시스템 잔고 곡선 — 봇이 사이클마다 남긴 실측 잔고를 그대로 잇는다.
 *
 * 수동 북의 자금 곡선(`EquityCurve`)과 나눠 둔 이유는 계열이 다르기 때문이다.
 * 봇 계좌에는 입출금도 벤치마크 대조도 없고, 점이 찍히는 자리도 거래가 아니라
 * 사이클이다 — 포지션이 없는 구간에도 점이 이어진다.
 */
export function SystemEquityCurve({
  data,
  start,
  currency = "USDT",
}: {
  data: SystemEquityPoint[];
  /** 기준선 — 관측 시작 시점의 잔고. 이 선 위/아래가 곧 성적이다. */
  start: number;
  currency?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis {...TIME_AXIS} />
        <YAxis
          {...AXIS}
          tickLine={false}
          axisLine={false}
          width={56}
          domain={["auto", "auto"]}
          tickFormatter={(v: number) => num(v, 0)}
        />
        <ReferenceLine
          y={start}
          stroke="var(--text-dim)"
          strokeDasharray="4 4"
          label={{ value: "시작", position: "insideTopLeft", fill: "var(--text-dim)", fontSize: 10 }}
        />
        <Tooltip
          cursor={{ stroke: "var(--text-dim)", strokeDasharray: "3 3" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as SystemEquityPoint;
            return (
              <TooltipBox
                rows={[
                  [p.label, ""],
                  [`잔고 (${currency})`, num(p.equity, 2)],
                  ["시작 대비", signed(p.equity - start, 2), pnlClass(p.equity - start)],
                  ["열린 포지션", p.open || "없음"],
                ]}
              />
            );
          }}
        />
        <Line
          type="stepAfter"
          dataKey="equity"
          stroke="var(--alpha)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
