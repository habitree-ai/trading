import Link from "next/link";
import { notFound } from "next/navigation";

import { SpotSignalChart } from "@/components/spot-signal-chart";
import { DASH, dateTime, num } from "@/lib/format";
import { readSpotSignal } from "@/lib/spot";
import { ADOPTED_STATS, CRASH_RULE } from "@/lib/spot-signals";

/** 현물신호 상세 — 발생 근거·차트·채택 통계. 카톡 알람 링크가 도착하는 곳이다. */

export default async function SpotSignalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const signal = await readSpotSignal(id);
  if (!signal) notFound();

  const ind = (signal.indicators ?? {}) as { rsi?: number | null };

  const facts: Array<{ label: string; value: string; cls?: string }> = [
    { label: "3일(72봉) 낙폭", value: signal.drop72Pct !== null ? `${num(signal.drop72Pct, 1)}%` : DASH, cls: "text-loss" },
    { label: "거래량 / 20봉 평균", value: signal.volumeMult !== null ? `${num(signal.volumeMult, 1)}배` : DASH },
    { label: "신호 봉 종가", value: `${num(signal.price, signal.price < 10 ? 2 : 0)}원` },
    { label: "일 거래대금(30일 중앙값)", value: signal.turnoverMed30 !== null ? `${num(signal.turnoverMed30 / 1e8, 0)}억원` : DASH },
    { label: "RSI(14)", value: typeof ind.rsi === "number" ? num(ind.rsi, 1) : DASH },
    { label: "알림", value: signal.notifiedAt ? dateTime(signal.notifiedAt) : "미발송" },
  ];

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <Link href="/system/spot" className="text-[11px] text-dim hover:underline">
          ← 현물신호 목록
        </Link>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{signal.market.slice(4)}</h1>
          <span className="rounded border border-alpha px-1.5 py-0.5 text-[10px] font-semibold text-alpha">
            급락 반전
          </span>
          <p className="tnum text-sm text-dim">{dateTime(signal.barTs)} 봉</p>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {facts.map((f) => (
          <div key={f.label} className="rounded-xl border border-border bg-surface px-3 py-2">
            <p className="text-[10px] text-dim">{f.label}</p>
            <p className={`tnum text-sm font-medium ${f.cls ?? ""}`}>{f.value}</p>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-border bg-surface p-3">
        <SpotSignalChart market={signal.market} barTs={signal.barTs} />
      </section>

      <section className="rounded-xl border border-border bg-surface p-4 text-[12px] text-dim">
        <h2 className="text-sm font-medium text-text">이 신호가 알람에 오르는 근거</h2>
        <p className="mt-1">
          규칙 — 3일 낙폭 ≤ {CRASH_RULE.drop72 * 100}% · 양봉 · 거래량 &gt; 20봉 평균 ×{CRASH_RULE.volMult} ·
          일 거래대금 ≥ {num(CRASH_RULE.minTurnoverKrw / 1e8, 0)}억. 후보 8종 중 유일하게 사전 등록
          기준을 통과했다 ({ADOPTED_STATS.source}).
        </p>
        <p className="tnum mt-2">
          {ADOPTED_STATS.period} · {ADOPTED_STATS.horizon} — 평균{" "}
          <span className="text-profit">+{ADOPTED_STATS.avgPct}%</span> · 승률 {ADOPTED_STATS.winPct}% · PF{" "}
          {ADOPTED_STATS.pf} · 최악 {ADOPTED_STATS.worstPct}% (표본 {ADOPTED_STATS.n}) ·
          2025년 +{ADOPTED_STATS.y2025.avgPct}%(승률 {ADOPTED_STATS.y2025.winPct}%) ·
          2026년 +{ADOPTED_STATS.y2026.avgPct}%(승률 {ADOPTED_STATS.y2026.winPct}%)
        </p>
        <ul className="mt-2 list-disc space-y-0.5 pl-4">
          {ADOPTED_STATS.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <p className="mt-2 text-[11px]">
          과거 통계이며 미래를 보장하지 않습니다. 자동 매수 없음 — 진입·크기·청산 판단은 사람 몫입니다.
        </p>
      </section>
    </div>
  );
}
