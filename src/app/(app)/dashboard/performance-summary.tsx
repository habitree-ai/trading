import { DASH, num, pct, pnlClass, signed } from "@/lib/format";
import type { PerformanceSummary as Summary } from "@/lib/metrics";

/**
 * 성과 요약 — 값마다 "언제"가 붙는다.
 *
 * KPI 타일은 지금 상태가 어떤지를 한눈에 보여 준다. 이 표는 거기 없던 걸 채운다 —
 * 최대 손실이 **언제** 났는지, 낙폭이 **어느 구간**이었는지. 시점을 모르면 그때 무슨
 * 일이 있었는지 되짚을 수 없다.
 *
 * 기준 단위가 거래 건이 아니라 거래일이다. 하루에 다섯 번 들어갔다 나온 날의 성적은
 * 그날 합계로 판단해야 한다 — 건별로 세면 스캘핑이 잦은 날이 통계를 통째로 끌고 간다.
 * 그래서 여기 승률은 KPI 타일의 건 기준 승률과 값이 다르다.
 */
export function PerformanceSummary({
  summary,
  currency,
}: {
  summary: Summary;
  currency: string;
}) {
  const s = summary;

  const rows: Row[] = [
    { label: "총손익", value: signed(s.netPnl), tone: s.netPnl, span: s.period },
    { label: "총수익", value: signed(s.grossProfit), tone: s.grossProfit },
    { label: "총손실", value: signed(s.grossLoss), tone: s.grossLoss },
    { label: "총거래일", value: `${num(s.tradingDays, 0)} 일`, hint: "거래가 있었던 날의 수" },
    { label: "승률", value: pct(s.dailyWinRate), hint: "이익일 ÷ (이익일 + 손실일)" },
    { label: "손익 (P/F)", value: num(s.profitFactor), hint: "총수익 ÷ |총손실|" },
    {
      label: "보상 비율 (ROA)",
      value: s.roa === null ? DASH : pct(s.roa, 0),
      tone: s.roa,
      hint: "총손익 ÷ |최대 낙폭 금액|",
    },
    {
      label: "하루 최대 수익 금액",
      value: signed(s.bestDay?.pnl ?? null),
      tone: s.bestDay?.pnl ?? null,
      at: s.bestDay?.day ?? null,
    },
    {
      label: "하루 최대 손실 금액",
      value: signed(s.worstDay?.pnl ?? null),
      tone: s.worstDay?.pnl ?? null,
      at: s.worstDay?.day ?? null,
    },
    {
      label: "MDD (Max Draw Down)",
      value:
        s.maxDrawdown === null
          ? DASH
          : `${signed(s.maxDrawdown.amount)} (${pct(s.maxDrawdown.pct)})`,
      tone: s.maxDrawdown?.amount ?? null,
      span: s.maxDrawdown,
      hint: "고점을 찍은 날부터 바닥을 친 날까지",
    },
    {
      label: "최대 연속 이익 거래일",
      value: s.winStreak === null ? DASH : `${s.winStreak.days} 일`,
      span: s.winStreak,
    },
    {
      label: "최대 연속 손실 거래일",
      value: s.lossStreak === null ? DASH : `${s.lossStreak.days} 일`,
      span: s.lossStreak,
    },
  ];

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h2 className="text-sm font-medium">
        성과 요약{" "}
        <span className="font-normal text-dim">
          — 거래일 기준, 언제였는지까지 ({currency})
        </span>
      </h2>

      {/* 좁은 화면에서 표가 눌리지 않도록 가로 스크롤을 표 안에 가둔다. */}
      <div className="mt-3 scroll-x">
        <table className="w-full min-w-[30rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-[11px] text-dim">
              <th className="py-2 pr-3 text-left font-medium">항목</th>
              <th className="py-2 pr-3 text-right font-medium">거래 결과</th>
              <th className="py-2 text-right font-medium">거래 기간</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.label} className="border-b border-border/60 last:border-0">
                <td className="py-2 pr-3 text-dim">
                  <span className="tnum mr-1.5 text-[11px] opacity-60">{i + 1}.</span>
                  {row.label}
                  {row.hint ? (
                    <span className="ml-1.5 text-[10px] opacity-70">{row.hint}</span>
                  ) : null}
                </td>
                <td className={`tnum py-2 pr-3 text-right font-medium ${toneClass(row.tone)}`}>
                  {row.value}
                </td>
                <td className="tnum py-2 text-right text-xs text-dim">{when(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface Row {
  label: string;
  value: string;
  /** 산식이 짐작되지 않는 항목에만 붙이는 짧은 설명 */
  hint?: string;
  /** 부호로 색을 입힐 값. 없으면 중립으로 둔다 — 승률·거래일은 좋고 나쁨이 부호로 갈리지 않는다. */
  tone?: number | null;
  /** 하루짜리 사건 */
  at?: string | null;
  /** 구간짜리 사건 */
  span?: { from: string; to: string } | null;
}

function toneClass(tone: number | null | undefined): string {
  return tone === undefined ? "" : pnlClass(tone);
}

function when(row: Row): string {
  if (row.at) return row.at;
  if (row.span) {
    return row.span.from === row.span.to ? row.span.from : `${row.span.from} ~ ${row.span.to}`;
  }
  return DASH;
}
