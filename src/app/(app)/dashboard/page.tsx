import Link from "next/link";

import { BalanceGap, CashFlowPanel } from "@/app/(app)/dashboard/cash-flow-panel";
import { CostPanel } from "@/app/(app)/dashboard/cost-panel";
import { Layer, Note, worstTone } from "@/app/(app)/dashboard/layer";
import { PerformanceSummary } from "@/app/(app)/dashboard/performance-summary";
import { PnlPanel } from "@/app/(app)/dashboard/pnl-panel";
import { RecentTrades } from "@/app/(app)/dashboard/recent-trades";
import { SyncAction } from "@/app/(app)/trades/okx-sync-button";
import {
  DrawdownChart,
  EquityCurve,
  WithdrawalChart,
  type EquityPoint,
} from "@/components/charts";
import type { PnlBar } from "@/components/charts";
import { EmptyBook } from "@/components/empty-book";
import { StatTile } from "@/components/stat-tile";
import { loadBenchmark } from "@/lib/benchmark";
import { date, dateTime, num, pct, pnlClass, signed, signedPct, DASH } from "@/lib/format";
import {
  bucketBy,
  computeMetrics,
  dayKey,
  deriveTrades,
  lastActivityAt,
  monthKey,
  summarizePerformance,
} from "@/lib/metrics";
import {
  getActiveBook,
  getLastSync,
  getLatestBalance,
  listCashFlows,
  listFillsByTrade,
  listTrades,
} from "@/lib/queries";
import {
  readBalanceGap,
  readCost,
  readDrawdown,
  readExpectancy,
  readLossStreak,
  readPayoff,
  readRisk,
  readSample,
  readWinRate,
  recoveryNeeded,
} from "@/lib/verdict";

export default async function DashboardPage() {
  const book = await getActiveBook();
  if (!book) return <EmptyBook />;

  const [trades, flows, balance, lastSync] = await Promise.all([
    listTrades(book.id),
    listCashFlows(book.id),
    getLatestBalance(book.id),
    book.exchange_account_id ? getLastSync(book.id) : null,
  ]);

  const derived = deriveTrades(book, trades, flows);
  const m = computeMetrics(book, derived, flows);
  const summary = summarizePerformance(book, derived, flows);
  // 축이 좁아 키를 그대로 찍으면 겹친다 — 일별은 연도를 떼고 `07-28`로 줄인다.
  const toBars = (keyFn: (iso: string) => string, short: boolean): PnlBar[] =>
    bucketBy(derived, keyFn).map((b) => ({ ...b, label: short ? b.key.slice(5) : b.key }));

  const daily = toBars(dayKey, true);
  const monthly = toBars(monthKey, false);

  // 같은 기간 시장이 어땠는지 — 못 받아 오면 null이고 그 선만 빠진다.
  // 구간 끝은 목록의 마지막이 아니라 가장 늦은 청산이다 — 겹치는 포지션이 들어와도
  // 마지막 거래가 시세 구간 밖으로 밀리지 않는다.
  const startedAt = `${book.start_date}T00:00:00Z`;
  const lastAt = lastActivityAt(derived);
  const benchmark = lastAt ? await loadBenchmark(startedAt, lastAt) : null;
  const priceAt = (iso: string) => benchmark?.at(iso) ?? null;

  /*
   * 자금 곡선의 점 — 손익이 실현된 시각에 찍는다.
   *
   * `deriveTrades`는 진입 순서로 잔액을 이어 붙이지만, 먼저 들어가 나중에 나온
   * 포지션이 있으면 그 순서가 청산 순서와 어긋난다. 가로축이 시각인 이상 점은
   * 시각순으로 이어야 하므로 여기서 다시 세운다.
   */
  const points = derived.map((d) => ({
    t: Date.parse(d.trade.exit_at ?? d.trade.entry_at),
    label: `#${d.trade.seq} ${date(d.trade.exit_at ?? d.trade.entry_at)}`,
    equity: d.equityAfter,
    // 넣고 뺀 돈을 걷어낸 곡선 — 출금으로 꺾인 자리가 여기서는 이어진다.
    performance: book.initial_capital + d.netTotal,
    withdrawn: d.withdrawnTotal,
    drawdown: d.drawdownPct,
    pnl: d.trade.pnl,
    benchmark: priceAt(d.trade.exit_at ?? d.trade.entry_at),
  }));
  points.sort((a, b) => a.t - b.t);

  const curve: EquityPoint[] = [
    {
      t: Date.parse(startedAt),
      label: `${book.start_date} 시작`,
      equity: book.initial_capital,
      performance: book.initial_capital,
      withdrawn: 0,
      withdrawnStep: 0,
      drawdown: 0,
      pnl: null,
      benchmark: priceAt(startedAt),
    },
    // 이번 구간에 빠져나간 금액 — 시각순으로 정렬한 뒤에 계산해야 화면의 순서와 맞는다.
    // 순서를 다시 세운 탓에 누계가 잠깐 뒤로 갈 수 있어 음수는 0으로 눌러 둔다.
    ...points.map((p, i) => ({
      ...p,
      withdrawnStep: Math.max(0, p.withdrawn - (i === 0 ? 0 : points[i - 1].withdrawn)),
    })),
  ];
  const hasWithdrawal = curve.some((p) => p.withdrawnStep > 0);

  const recent = [...derived].reverse().slice(0, 8);
  // 차트에 찍을 체결은 펼쳐 볼 수 있는 8건만 넘긴다 — 전량을 보내면 페이로드가 헛되이 커진다.
  const recentIds = new Set(recent.map((d) => d.trade.id));
  const recentFills = Object.fromEntries(
    Object.entries(await listFillsByTrade(book.id)).filter(([id]) => recentIds.has(id)),
  );

  /* ============ 해석 ============ */

  const gap = readBalanceGap(
    m.finalEquity,
    balance?.equity ?? null,
    balance?.unrealized_pnl ?? null,
  );
  const cost = readCost({
    pnlBeforeCost: m.pnlBeforeCost,
    cost: m.fees + m.fundingFees,
    netPnl: m.netPnl,
    flipped: m.costFlippedCount,
  });
  const winRate = readWinRate(m.winRate, m.payoffRatio);
  const payoff = readPayoff(m.payoffRatio);
  const expectancy = readExpectancy(m.expectancy);
  const sample = readSample(m.closedCount);
  const drawdown = readDrawdown(m.maxDrawdownPct);
  const risk = readRisk(m.avgRiskPct);
  const streak = readLossStreak(m.maxLossStreak, m.avgRiskPct);
  const recovery = recoveryNeeded(m.maxDrawdownPct);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">대시보드</h1>
          <p className="mt-1 text-sm text-dim">
            {book.name} · {book.exchange ?? "거래소 미지정"} · {book.base_currency}
            {book.exchange_account_id ? (
              <> · 마지막 동기화 {lastSync ? dateTime(lastSync.started_at) : "없음"}</>
            ) : null}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <SyncAction linked={Boolean(book.exchange_account_id)} />
          <Link
            href="/trades/new"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            기록 추가
          </Link>
        </div>
      </header>

      {derived.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          아직 거래가 없습니다. 첫 기록을 추가하면 여기에 자금 곡선과 지표가 나타납니다.
        </p>
      ) : null}

      <Layer
        index={1}
        title="지금 상태"
        question="계좌에 지금 얼마가 있고, 그 값이 맞는가"
        tone={gap.tone}
      >
        <div className="rounded-xl border border-border bg-surface p-4">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <div className="text-[11px] text-dim">현재자금 ({book.base_currency})</div>
              <div className="tnum mt-0.5 text-3xl font-semibold">{num(m.finalEquity, 2)}</div>
            </div>
            <div>
              <div className="text-[11px] text-dim">수익율</div>
              <div className={`tnum mt-0.5 text-2xl font-semibold ${pnlClass(m.returnPct)}`}>
                {signedPct(m.returnPct)}
              </div>
            </div>
            <div className="tnum text-[11px] leading-relaxed text-dim">
              투입원금 {num(m.investedCapital, 0)} · 초기 {num(m.initialCapital, 0)} · 순이체{" "}
              {signed(m.netTransfer, 0)}
              <br />
              매매로 번 돈 {signed(m.netChange, 0)} · 뽑아 간 돈{" "}
              {num(m.withdrawnFromAccount, 0)}
            </div>
          </div>

          <div className="mt-3 border-t border-border pt-3">
            <BalanceGap
              computed={m.finalEquity}
              actual={balance?.equity ?? null}
              unrealizedPnl={balance?.unrealized_pnl ?? null}
              at={balance?.at ?? null}
              currency={book.base_currency}
            />
          </div>
        </div>

        {derived.length > 0 ? (
          <section className="rounded-xl border border-border bg-surface p-4">
            <h3 className="text-sm font-medium">
              자금 곡선{" "}
              <span className="font-normal text-dim">
                — 날짜순 실제 잔액과 매매 성과 ({book.base_currency})
                {benchmark ? `, ${benchmark.symbol} 시세 대조` : ""}
              </span>
            </h3>
            <div className="mt-3">
              <EquityCurve
                data={curve}
                currency={book.base_currency}
                initialCapital={book.initial_capital}
                benchmarkLabel={benchmark?.symbol ?? null}
              />
            </div>
            <Note>
              가로축은 거래 순번이 아니라 날짜입니다 — 몰아서 거래한 날은 붙어서, 쉰 구간은
              넓게 찍힙니다.
            </Note>
          </section>
        ) : null}
      </Layer>

      {derived.length > 0 ? (
        <>
          <Layer
            index={2}
            title="매매 성과"
            question="반복해도 남는 방식인가"
            tone={worstTone([winRate.tone, payoff.tone, expectancy.tone, sample.tone, cost.tone])}
          >
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile
                label="누적 PNL"
                value={signed(m.netPnl, 2)}
                valueClass={pnlClass(m.netPnl)}
                sub={`수익 ${num(m.grossProfit, 0)} · 손실 ${num(m.grossLoss, 0)}`}
                verdict={sample}
              />
              <StatTile
                label="승률"
                value={pct(m.winRate)}
                sub={`${m.wins}승 ${m.losses}패${m.breakEvens ? ` ${m.breakEvens}본전` : ""}`}
                verdict={winRate}
              />
              <StatTile
                label="손익비"
                value={num(m.payoffRatio, 2)}
                sub={`평균수익 ${num(m.avgWin, 1)} / 평균손실 ${num(m.avgLoss, 1)}`}
                verdict={payoff}
              />
              <StatTile
                label="기대치값"
                value={m.expectancy === null ? DASH : `${signed(m.expectancy, 2)} R`}
                valueClass={pnlClass(m.expectancy)}
                sub="승률 × 손익비 − 패률"
                verdict={expectancy}
              />
            </div>

            <CostPanel m={m} currency={book.base_currency} />

            <PerformanceSummary summary={summary} currency={book.base_currency} />

            <PnlPanel daily={daily} monthly={monthly} currency={book.base_currency} />
          </Layer>

          <Layer
            index={3}
            title="리스크"
            question="얼마나 깎였고, 얼마를 걸고 있는가"
            tone={worstTone([drawdown.tone, risk.tone, streak.tone])}
          >
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile
                label="MDD"
                value={pct(m.maxDrawdownPct)}
                valueClass={m.maxDrawdownPct < 0 ? "text-loss" : ""}
                sub={`최고 ${num(m.peakEquity, 0)} · 최저 ${num(m.troughEquity, 0)}`}
                verdict={drawdown}
              />
              <StatTile
                label="회복 필요 수익률"
                value={recovery === null ? DASH : `+${pct(recovery)}`}
                sub="최대 낙폭 지점에서 원금까지"
              />
              <StatTile
                label="연속"
                value={
                  m.currentStreak === 0
                    ? DASH
                    : m.currentStreak > 0
                      ? `${m.currentStreak}연승`
                      : `${-m.currentStreak}연패`
                }
                valueClass={
                  m.currentStreak > 0 ? "text-profit" : m.currentStreak < 0 ? "text-loss" : ""
                }
                sub={`최다 ${m.maxWinStreak}연승 · ${m.maxLossStreak}연패`}
                verdict={streak}
              />
              <StatTile
                label="거래당 리스크"
                value={pct(m.avgRiskPct, 2)}
                sub="|진입가 − 손절가| ÷ 진입가 평균"
                verdict={risk}
              />
            </div>

            <section className="rounded-xl border border-border bg-surface p-4">
              <h3 className="text-sm font-medium">
                고점 대비 낙폭{" "}
                <span className="font-normal text-dim">— 이체분은 고점에서 상쇄합니다</span>
              </h3>
              <div className="mt-3">
                <DrawdownChart data={curve} />
              </div>
              {summary.maxDrawdown ? (
                <Note tone={drawdown.tone}>
                  가장 깊었던 구간은 {summary.maxDrawdown.from} ~ {summary.maxDrawdown.to},{" "}
                  {signed(summary.maxDrawdown.amount)} ({pct(summary.maxDrawdown.pct)})입니다.
                </Note>
              ) : null}
            </section>
          </Layer>

          <Layer
            index={4}
            title="자금 흐름"
            question="번 돈인가, 넣은 돈인가"
            tone="neutral"
          >
            <CashFlowPanel
              flows={flows}
              currency={book.base_currency}
              deposits={m.deposits}
              withdrawals={m.withdrawals}
              netTransfer={m.netTransfer}
              withdrawnFromAccount={m.withdrawnFromAccount}
            />

            {hasWithdrawal ? (
              <section className="rounded-xl border border-border bg-surface p-4">
                <h3 className="text-sm font-medium">
                  누적 출금{" "}
                  <span className="font-normal text-dim">
                    — 계좌에서 뽑아 간 돈. 매매 성과에서는 빠지지 않습니다
                  </span>
                </h3>
                <div className="mt-3">
                  <WithdrawalChart data={curve} currency={book.base_currency} />
                </div>
              </section>
            ) : null}
          </Layer>

          <section className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center">
              <h2 className="text-sm font-medium">
                최근 거래 <span className="font-normal text-dim">— 누르면 차트가 열립니다</span>
              </h2>
              <Link href="/trades" className="ml-auto text-xs text-accent">
                전체 보기
              </Link>
            </div>
            <RecentTrades
              rows={recent}
              currency={book.base_currency}
              fillsByTrade={recentFills}
            />
          </section>
        </>
      ) : null}
    </div>
  );
}
