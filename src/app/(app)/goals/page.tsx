import Link from "next/link";

import { PlanCalculator } from "@/app/(app)/goals/plan-calculator";
import { PlanForm } from "@/app/(app)/goals/plan-form";
import { EmptyBook } from "@/components/empty-book";
import { StatTile } from "@/components/stat-tile";
import {
  annualFromMonthly,
  BENCHMARKS,
  DEMOTION_RULE,
  monthPerformance,
  monthVerdict,
  planFromGoals,
  STAGES,
  stageOf,
  type MonthVerdict,
} from "@/lib/compound-plan";
import { num, pct, signedPct } from "@/lib/format";
import { buildEquityCurve, deriveTrades, monthKey } from "@/lib/metrics";
import { getActiveBook, getLatestBalance, listCashFlows, listGoals, listTrades } from "@/lib/queries";
import { TONE_CLASS, type Verdict } from "@/lib/verdict";

/**
 * 목표 — 1억까지의 필요 수익률과, 그 전에 지켜야 할 기준.
 *
 * 숫자를 새로 만들지 않는다. 랩 회차·켈리·선배님 정지선이 이미 답한 것을 한 축에 놓고,
 * 이번 달 성적이 그 축의 어디에 있는지만 판정한다. 근거는 `docs/goals/README.md`.
 */

const VERDICT: Record<MonthVerdict, Verdict> = {
  stopped: { tone: "bad", text: "정지선 접촉 — 이 달은 중단, 다음 달 리스크 절반" },
  alpha: { tone: "good", text: "목표 α 달성. 정지선은 그대로 — 도전이 규칙을 옮기지 않습니다" },
  beta: { tone: "good", text: "계획 β 달성" },
  positive: { tone: "warn", text: "양수지만 β 미달 — 단계 0의 조건(월 기하 > 0)은 채웠습니다" },
  negative: { tone: "bad", text: "이번 달 손실 — 단계 0의 첫 조건(월 기하 > 0)이 깨졌습니다" },
  idle: { tone: "neutral", text: "이번 달 실현 거래가 없습니다" },
};

export default async function GoalsPage() {
  const book = await getActiveBook();
  if (!book) return <EmptyBook />;

  const [trades, flows, balance, goals] = await Promise.all([
    listTrades(book.id),
    listCashFlows(book.id),
    getLatestBalance(book.id),
    listGoals(book.id),
  ]);

  const derived = deriveTrades(book, trades, flows);
  const series = buildEquityCurve(book, derived, flows);
  // 지금 자금 — 실측 스냅샷이 있으면 그것, 없으면 곡선의 마지막 점.
  const equity = balance?.equity ?? series[series.length - 1]?.equity ?? book.initial_capital;

  const plan = planFromGoals(goals);
  const month = monthKey(new Date().toISOString());
  const perf = monthPerformance(
    series.map((p) => ({ at: p.at, performance: p.performance })),
    book.initial_capital,
    month,
  );
  const verdict = monthVerdict(perf, plan.beta, plan.alpha);
  const stage = stageOf(equity);
  const saved = goals.some((g) => g.period === "month");

  // 기준선 축 — 0~10% 를 한 줄로. 켈리(음수)는 0 왼쪽 밖이라 점 대신 글로 둔다.
  const AXIS_MAX = 0.1;
  // 축 위에는 이름을 다 못 쓴다 — 짧은 꼬리표만 두고 이름은 아래 표가 말한다.
  const SHORT: Record<string, string> = {
    frontier: "10% 기각",
    "lab-max": "랩 상한",
    senior: "선배님",
    "lab-safe": "랩 보수",
  };
  const markers = [
    ...BENCHMARKS.filter((b) => b.monthly !== null).map((b) => ({
      key: b.key,
      label: SHORT[b.key] ?? b.key,
      rate: b.monthly as number,
      cls: "bg-dim",
    })),
    { key: "beta", label: "β", rate: plan.beta.monthly, cls: "bg-profit" },
    { key: "alpha", label: "α", rate: plan.alpha.monthly, cls: "bg-beta" },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">목표</h1>
        <p className="mt-1 text-sm text-dim">
          {book.name} · 1억까지 필요한 수익률과, 그 전에 지켜야 할 기준. 계획 β(반드시)와 목표
          α(도전)를 2중으로 둡니다. 근거는{" "}
          <code className="rounded bg-surface-2 px-1">docs/goals/README.md</code>.
        </p>
      </header>

      {verdict === "stopped" ? (
        <p className="rounded-xl border border-loss/50 bg-loss/10 px-4 py-3 text-sm text-loss">
          <b>이번 달 중단.</b> 고점 대비 낙폭 {pct(perf.drawdown, 1)}가 정지선{" "}
          {pct(plan.beta.stopDrawdown, 0)}에 닿았습니다. {DEMOTION_RULE}. — 판정일 뿐 주문을 막지는
          않습니다.
        </p>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-medium">
          이번 달 <span className="tnum ml-1 text-xs font-normal text-dim">{month}</span>
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile
            label="월수익률 (매매 성과, 입출금 제외)"
            value={signedPct(perf.returnPct, 2)}
            sub={`β ${pct(plan.beta.monthly, 1)} · α ${pct(plan.alpha.monthly, 1)} · 실현 ${perf.samples}건`}
            verdict={VERDICT[verdict]}
            valueClass={perf.returnPct > 0 ? "text-profit" : perf.returnPct < 0 ? "text-loss" : ""}
          />
          <StatTile
            label="월 낙폭 (달 안의 고점 대비)"
            value={perf.drawdown > 0 ? `−${pct(perf.drawdown, 1)}` : "0%"}
            sub={`정지선 −${pct(plan.beta.stopDrawdown, 0)}`}
            valueClass={perf.drawdown >= plan.beta.stopDrawdown ? "text-loss" : ""}
          />
          <StatTile
            label="현재 자금 (USDT)"
            value={num(equity, 2)}
            sub={balance ? "거래소 실측" : "거래 기반 추정"}
          />
          <StatTile
            label="단계"
            value={`${stage.level} ${stage.label}`}
            sub={`${num(stage.from, 0)}$ ~ ${Number.isFinite(stage.to) ? `${num(stage.to, 0)}$` : "1억"}`}
          />
        </div>
        <p className="text-[11.5px] leading-snug text-dim">
          단계 {stage.level} 승격 조건: {stage.promote}. 지금 답해야 하는 질문은 &ldquo;월 몇
          %&rdquo;가 아니라 &ldquo;잃지 않는 달을 연속으로 몇 번 만드는가&rdquo;입니다 — 복리의
          전제는 기간 단위로 잃지 않는 것입니다.
        </p>
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">1억까지 필요한 월수익률</h2>
        <PlanCalculator start={equity} beta={plan.beta} alpha={plan.alpha} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">현실 기준선 — 저장소가 이미 답해 둔 것</h2>
        <div className="rounded-xl border border-border bg-surface p-4">
          <div className="relative mt-8 mb-14 h-1 rounded bg-surface-2">
            {markers.map((m) => {
              const left = `${Math.min(100, (m.rate / AXIS_MAX) * 100)}%`;
              const isPlan = m.key === "beta" || m.key === "alpha";
              return (
                <div key={m.key} className="absolute" style={{ left }}>
                  <span
                    className={`absolute -top-1 -ml-1 block h-3 w-3 rounded-full ${m.cls}`}
                    aria-hidden
                  />
                  <span
                    className={`absolute -ml-8 w-16 text-center text-[10px] leading-tight whitespace-nowrap ${
                      isPlan ? "-top-7 font-semibold text-text" : "top-3 text-dim"
                    }`}
                  >
                    {m.label}
                    <br />
                    {pct(m.rate, m.rate >= 0.1 ? 0 : 2)}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="tnum text-[11px] text-dim">
            0% ─ 10% (월 기하수익률). 내 켈리(전 이력 4,023건)는 음수라 이 축의 왼쪽 밖에 있습니다.
          </p>
        </div>

        <div className="scroll-x">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-dim">
                <th className="py-1 pr-3 font-normal">기준선</th>
                <th className="py-1 pr-3 font-normal">월</th>
                <th className="py-1 pr-3 font-normal">연</th>
                <th className="py-1 pr-3 font-normal">근거</th>
                <th className="py-1 font-normal">출처</th>
              </tr>
            </thead>
            <tbody>
              {BENCHMARKS.map((b) => (
                <tr key={b.key} className="border-t border-border align-top">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{b.label}</td>
                  <td className="tnum py-1.5 pr-3 whitespace-nowrap">
                    {b.monthly === null ? <span className="text-loss">&lt; 0</span> : pct(b.monthly, 2)}
                  </td>
                  <td className="tnum py-1.5 pr-3 whitespace-nowrap text-dim">
                    {b.monthly === null ? "—" : pct(annualFromMonthly(b.monthly), 0)}
                  </td>
                  <td className="py-1.5 pr-3 text-xs leading-snug text-dim">{b.note}</td>
                  <td className="py-1.5 text-[11px] text-dim">
                    {b.source.startsWith("/") ? (
                      <Link href={b.source} className="hover:text-text">
                        {b.source}
                      </Link>
                    ) : (
                      <code>{b.source}</code>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">단계 — 유의미한 금액대와 승격 조건</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {STAGES.map((s) => (
            <div
              key={s.level}
              className={`rounded-xl border p-3 ${
                s.level === stage.level ? "border-accent bg-accent/5" : "border-border bg-surface"
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium">
                  {s.level} {s.label}
                </span>
                <span className="tnum text-[11px] text-dim">
                  {num(s.from, 0)}$ ~ {Number.isFinite(s.to) ? `${num(s.to, 0)}$` : "1억"}
                </span>
                {s.level === stage.level ? (
                  <span className="ml-auto rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
                    지금
                  </span>
                ) : null}
              </div>
              <p className="mt-1.5 text-[11.5px] leading-snug text-dim">승격: {s.promote}</p>
            </div>
          ))}
        </div>
        <p className="text-[11.5px] leading-snug text-dim">강등: {DEMOTION_RULE}.</p>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-sm font-medium">계획 β / 목표 α</h2>
          <span className={`text-[11px] ${saved ? "text-dim" : TONE_CLASS.warn}`}>
            {saved ? "저장된 값" : "아직 저장하지 않았습니다 — 기본안이 보입니다"}
          </span>
        </div>
        <PlanForm beta={plan.beta} alpha={plan.alpha} />
      </section>
    </div>
  );
}
