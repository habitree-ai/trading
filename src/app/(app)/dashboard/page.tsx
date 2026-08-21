import Link from "next/link";

import { BalanceGap } from "@/app/(app)/dashboard/balance-gap";
import { CapitalAudit } from "@/app/(app)/dashboard/capital-audit";
import { Details, Note, worstTone } from "@/app/(app)/dashboard/details";
import { PerformanceSummary } from "@/app/(app)/dashboard/performance-summary";
import { PnlPanel } from "@/app/(app)/dashboard/pnl-panel";
import { RecentTrades } from "@/app/(app)/dashboard/recent-trades";
import { SyncAction } from "@/app/(app)/trades/okx-sync-button";
import { DrawdownChart, EquityCurve, type EquityPoint } from "@/components/charts";
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
import { nowMs } from "@/lib/okx";
import { historyFloorMs } from "@/lib/okx/private";
import {
  getActiveBook,
  getLastSync,
  getLatestBalance,
  listCashFlows,
  listTrades,
} from "@/lib/queries";
import { reconcileEquity } from "@/lib/reconcile";
import {
  readDrawdown,
  readExpectancy,
  readLossStreak,
  readPayoff,
  readRisk,
  readSample,
  readWinRate,
  recoveryNeeded,
  TONE_CLASS,
} from "@/lib/verdict";

/**
 * 수동매매 대시보드 — 매일 보는 것만 위에, 나머지는 접는다.
 *
 * 예전 구조는 네 층(지금 상태 · 매매 성과 · 리스크 · 자금 흐름)을 전부 펼쳐 두어
 * 차트 넷과 표 셋을 지나야 거래 기록에 닿았다. 실제로 매일 확인하는 것은 셋이다 —
 * 지금 얼마인가, 그 방식이 남는가, 무엇을 했나. 그 셋을 위에서 끊기지 않게 두고
 * 나머지는 상세로 내렸다. 입출금 내역은 통째로 뺐다: 이 화면이 답할 질문이 아니고,
 * 이체가 성과를 흐리는 문제는 자본 점검이 이미 다룬다.
 *
 * 접었다고 놓치지는 않는다 — 자본 점검이 어긋나면 그 경고만 맨 위로 올라온다.
 */

/** 목록으로 건너뛰지 않고 대시보드에서 바로 훑을 거래 수. */
const RECENT_COUNT = 12;

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

  // 구간 끝은 목록의 마지막이 아니라 가장 늦은 청산이다 — 겹치는 포지션이 들어와도
  // 마지막 거래가 시세 구간 밖으로 밀리지 않는다.
  const startedAt = `${book.start_date}T00:00:00Z`;
  const lastAt = lastActivityAt(derived);

  const recent = [...derived].reverse().slice(0, RECENT_COUNT);

  // 들고 있는 포지션이 부분청산으로 이미 확정한 금액 — 미실현과 달리 시세로 흔들리지
  // 않고, 이미 계좌의 현금이라 현재자금에 들어와 있다. 그 출처를 밝혀 둔다.
  const openRealized = derived
    .filter((d) => d.result === "open")
    .reduce((a, d) => a + d.net, 0);

  // 같은 기간 시장이 어땠는지 — 못 받아 오면 null이고 그 선만 빠진다.
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

  /* ============ 해석 ============ */

  // 어긋났을 때 어느 항이 틀렸는지까지 가른다 — 경고만으로는 손댈 곳을 못 찾는다.
  const audit = reconcileEquity({
    initialCapital: m.initialCapital,
    netPnl: m.netPnl,
    netTransfer: m.netTransfer,
    tradeWithdrawal: m.totalWithdrawal,
    computedEquity: m.finalEquity,
    actual: balance?.equity ?? null,
    unrealizedPnl: balance?.unrealized_pnl ?? null,
    foreignFlowCount: flows.filter((f) => f.ccy !== book.base_currency).length,
    baseCurrency: book.base_currency,
    startDate: book.start_date,
    historyFloorMs: historyFloorMs(),
    lastSyncAt: lastSync?.started_at ?? null,
    linked: Boolean(book.exchange_account_id),
  });
  const winRate = readWinRate(m.winRate, m.payoffRatio);
  const payoff = readPayoff(m.payoffRatio);
  const expectancy = readExpectancy(m.expectancy);
  const sample = readSample(m.closedCount);
  const drawdown = readDrawdown(m.maxDrawdownPct);
  const risk = readRisk(m.avgRiskPct);
  const streak = readLossStreak(m.maxLossStreak, m.avgRiskPct);
  const recovery = recoveryNeeded(m.maxDrawdownPct);

  // 접힌 상세를 열어 볼 이유 — 안쪽에서 가장 나쁜 판정.
  const detailTone = worstTone([drawdown.tone, risk.tone, streak.tone, audit.tone]);
  // 사람이 손대야 하는 자본 점검 경고만 접힌 상세 밖으로 꺼낸다.
  const alert = audit.notes.find((n) => n.tone === "bad") ?? audit.notes.find((n) => n.tone === "warn");

  return (
    <div className="space-y-5">
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

      {/* ── 손대야 하는 경고만 맨 위로 ───────────── */}
      {alert ? (
        <p
          className={`rounded-xl border p-3 text-[12px] ${
            alert.tone === "bad" ? "border-loss/40 bg-loss/5" : "border-beta/40 bg-beta/5"
          }`}
        >
          <span className={TONE_CLASS[alert.tone]}>{alert.text}</span>
          {alert.fix ? <span className="text-dim"> — {alert.fix}</span> : null}
          <span className="text-dim"> (상세 지표 &gt; 자본 점검에서 맞출 수 있습니다)</span>
        </p>
      ) : null}

      {/* ── 1. 지금 얼마인가 ──────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
          <div>
            <div className="text-[11px] text-dim">현재자금 ({book.base_currency})</div>
            <div className="tnum mt-0.5 text-4xl font-semibold leading-none">
              {num(m.finalEquity, 2)}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-dim">수익률</div>
            <div className={`tnum mt-0.5 text-2xl font-semibold leading-none ${pnlClass(m.returnPct)}`}>
              {signedPct(m.returnPct)}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-dim">누적 손익 (비용 반영)</div>
            <div className={`tnum mt-0.5 text-2xl font-semibold leading-none ${pnlClass(m.netPnl)}`}>
              {signed(m.netPnl, 2)}
            </div>
          </div>
          <div className="tnum text-[11px] leading-relaxed text-dim">
            투입원금 {num(m.investedCapital, 0)} · 완결 {m.closedCount}건
            {m.openCount ? ` · 보유 ${m.openCount}건` : ""}
            {openRealized !== 0 ? (
              <>
                <br />
                보유분에서 이미 확정{" "}
                <span className={pnlClass(openRealized)}>{signed(openRealized, 2)}</span> —
                부분청산·수수료·펀딩비까지 현재자금에 들어 있습니다
              </>
            ) : null}
          </div>
        </div>

        <div className="mt-4 border-t border-border pt-3">
          <BalanceGap
            computed={m.finalEquity}
            actual={balance?.equity ?? null}
            unrealizedPnl={balance?.unrealized_pnl ?? null}
            at={balance?.at ?? null}
            currency={book.base_currency}
          />
        </div>
      </section>

      {derived.length > 0 ? (
        <>
          {/* ── 2. 반복해도 남는 방식인가 ─────────── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
              label="기대치"
              value={m.expectancy === null ? DASH : `${signed(m.expectancy, 2)} R`}
              valueClass={pnlClass(m.expectancy)}
              sub={`완결 ${m.closedCount}건 기준`}
              verdict={m.closedCount < 30 ? sample : expectancy}
            />
            <StatTile
              label="MDD"
              value={pct(m.maxDrawdownPct)}
              valueClass={m.maxDrawdownPct < 0 ? "text-loss" : ""}
              sub={recovery === null ? "최고점 대비 최대 낙폭" : `원금 복귀에 +${pct(recovery)} 필요`}
              verdict={drawdown}
            />
          </div>

          {/* ── 3. 무엇을 했나 ─────────────────────── */}
          <section className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center">
              <h2 className="text-sm font-medium">
                거래 내역{" "}
                <span className="font-normal text-dim">
                  — 최근 {recent.length}건, 누르면 그 자리에서 차트가 열립니다
                </span>
              </h2>
              <Link href="/trades" className="ml-auto text-xs text-accent">
                전체 보기 →
              </Link>
            </div>
            <RecentTrades rows={recent} currency={book.base_currency} now={nowMs()} />
          </section>

          {/* ── 4. 어떻게 흘러왔나 ─────────────────── */}
          <section className="rounded-xl border border-border bg-surface p-4">
            <h2 className="text-sm font-medium">
              자금 곡선{" "}
              <span className="font-normal text-dim">
                — 날짜순 실제 잔액과 매매 성과 ({book.base_currency})
                {benchmark ? `, ${benchmark.symbol} 시세 대조` : ""}
              </span>
            </h2>
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

          {/* ── 5. 찾아볼 때만 여는 것 ─────────────── */}
          <Details tone={detailTone}>
            <PnlPanel daily={daily} monthly={monthly} currency={book.base_currency} />

            <section className="rounded-xl border border-border bg-surface-2 p-4">
              <h3 className="text-sm font-medium">
                고점 대비 낙폭{" "}
                <span className="font-normal text-dim">— 이체분은 고점에서 상쇄합니다</span>
              </h3>
              <div className="mt-3">
                <DrawdownChart data={curve} />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-3">
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
                <StatTile
                  label="누적 손익 구성"
                  value={signed(m.netPnl, 2)}
                  valueClass={pnlClass(m.netPnl)}
                  sub={`수익 ${num(m.grossProfit, 0)} · 손실 ${num(m.grossLoss, 0)}`}
                />
              </div>
              {summary.maxDrawdown ? (
                <Note tone={drawdown.tone}>
                  가장 깊었던 구간은 {summary.maxDrawdown.from} ~ {summary.maxDrawdown.to},{" "}
                  {signed(summary.maxDrawdown.amount)} ({pct(summary.maxDrawdown.pct)})입니다.
                </Note>
              ) : null}
            </section>

            <PerformanceSummary summary={summary} currency={book.base_currency} />

            <CapitalAudit
              bookId={book.id}
              startDate={book.start_date}
              currency={book.base_currency}
              report={audit}
            />
          </Details>
        </>
      ) : null}
    </div>
  );
}
