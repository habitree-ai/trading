import Link from "next/link";

import { BalanceGap, CashFlowPanel } from "@/app/(app)/dashboard/cash-flow-panel";
import { PnlPanel } from "@/app/(app)/dashboard/pnl-panel";
import { RecentTrades } from "@/app/(app)/dashboard/recent-trades";
import { OkxSyncButton } from "@/app/(app)/trades/okx-sync-button";
import {
  DrawdownChart,
  EquityCurve,
  WithdrawalChart,
  type EquityPoint,
} from "@/components/charts";
import type { PnlBar } from "@/components/charts";
import { EmptyBook } from "@/components/empty-book";
import { StatTile } from "@/components/stat-tile";
import { date, dateTime, num, pct, pnlClass, signed, signedPct } from "@/lib/format";
import { bucketBy, computeMetrics, dayKey, deriveTrades, monthKey } from "@/lib/metrics";
import {
  getActiveBook,
  getLastSync,
  getLatestBalance,
  listCashFlows,
  listFillsByTrade,
  listTrades,
} from "@/lib/queries";

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
  // 축이 좁아 키를 그대로 찍으면 겹친다 — 일별은 연도를 떼고 `07-28`로 줄인다.
  const toBars = (keyFn: (iso: string) => string, short: boolean): PnlBar[] =>
    bucketBy(derived, keyFn).map((b) => ({ ...b, label: short ? b.key.slice(5) : b.key }));

  const daily = toBars(dayKey, true);
  const monthly = toBars(monthKey, false);

  const curve: EquityPoint[] = [
    {
      label: `${book.start_date} 시작`,
      equity: book.initial_capital,
      performance: book.initial_capital,
      withdrawn: 0,
      withdrawnStep: 0,
      drawdown: 0,
      pnl: null,
    },
    ...derived.map((d, i) => ({
      label: `#${d.trade.seq} ${date(d.trade.exit_at ?? d.trade.entry_at)}`,
      equity: d.equityAfter,
      // 넣고 뺀 돈을 걷어낸 곡선 — 출금으로 꺾인 자리가 여기서는 이어진다.
      performance: book.initial_capital + d.netTotal,
      withdrawn: d.withdrawnTotal,
      withdrawnStep: d.withdrawnTotal - (i === 0 ? 0 : derived[i - 1].withdrawnTotal),
      drawdown: d.drawdownPct,
      pnl: d.trade.pnl,
    })),
  ];
  const hasWithdrawal = curve.some((p) => p.withdrawnStep > 0);

  const recent = [...derived].reverse().slice(0, 8);
  // 차트에 찍을 체결은 펼쳐 볼 수 있는 8건만 넘긴다 — 전량을 보내면 페이로드가 헛되이 커진다.
  const recentIds = new Set(recent.map((d) => d.trade.id));
  const recentFills = Object.fromEntries(
    Object.entries(await listFillsByTrade(book.id)).filter(([id]) => recentIds.has(id)),
  );

  return (
    <div className="space-y-6">
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
          {book.exchange_account_id ? <OkxSyncButton /> : null}
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

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="현재자금"
          value={num(m.finalEquity, 2)}
          sub={`초기 ${num(m.initialCapital, 0)} · 순이체 ${signed(m.netTransfer, 0)}`}
        />
        <StatTile
          label="수익율"
          value={signedPct(m.returnPct)}
          valueClass={pnlClass(m.returnPct)}
          sub={`매매 차액 ${signed(m.netChange, 0)} ÷ 원금 ${num(m.investedCapital, 0)}`}
        />
        <StatTile
          label="승률"
          value={pct(m.winRate)}
          sub={`${m.wins}승 ${m.losses}패${m.breakEvens ? ` ${m.breakEvens}본전` : ""}`}
        />
        <StatTile
          label="기대치값"
          value={m.expectancy === null ? "—" : `${signed(m.expectancy, 2)} R`}
          valueClass={pnlClass(m.expectancy)}
          sub="승률 × 손익비 − 패률"
        />
        <StatTile
          label="MDD"
          value={pct(m.maxDrawdownPct)}
          valueClass={m.maxDrawdownPct < 0 ? "text-loss" : ""}
          sub={`최고 ${num(m.peakEquity, 0)} · 최저 ${num(m.troughEquity, 0)}`}
        />
        <StatTile
          label="손익비"
          value={num(m.payoffRatio, 2)}
          sub={`평균수익 ${num(m.avgWin, 1)} / 평균손실 ${num(m.avgLoss, 1)}`}
        />
        <StatTile
          label="누적 PNL"
          value={signed(m.netPnl, 2)}
          valueClass={pnlClass(m.netPnl)}
          sub={`수익 ${num(m.grossProfit, 0)} · 손실 ${num(m.grossLoss, 0)}`}
        />
        <StatTile
          label="연속"
          value={
            m.currentStreak === 0
              ? "—"
              : m.currentStreak > 0
                ? `${m.currentStreak}연승`
                : `${-m.currentStreak}연패`
          }
          valueClass={m.currentStreak > 0 ? "text-profit" : m.currentStreak < 0 ? "text-loss" : ""}
          sub={`최다 ${m.maxWinStreak}연승 · ${m.maxLossStreak}연패`}
        />
      </section>

      {derived.length > 0 ? (
        <>
          <section className="rounded-xl border border-border bg-surface p-4">
            <h2 className="text-sm font-medium">
              자금 곡선{" "}
              <span className="font-normal text-dim">
                — 거래 순서별 실제 잔액과 매매 성과 ({book.base_currency})
              </span>
            </h2>
            <div className="mt-1">
              <BalanceGap
                computed={m.finalEquity}
                actual={balance?.equity ?? null}
                at={balance?.at ?? null}
                currency={book.base_currency}
              />
            </div>
            <div className="mt-3">
              <EquityCurve
                data={curve}
                currency={book.base_currency}
                initialCapital={book.initial_capital}
              />
            </div>
            {hasWithdrawal ? (
              <>
                <h3 className="mt-4 text-xs font-medium text-dim">
                  누적 출금 — 계좌에서 뽑아 간 돈. 매매 성과에서는 빠지지 않습니다
                </h3>
                <div className="mt-1">
                  <WithdrawalChart data={curve} currency={book.base_currency} />
                </div>
              </>
            ) : null}

            <h3 className="mt-4 text-xs font-medium text-dim">
              고점 대비 낙폭 (MDD) — 이체분은 고점에서 상쇄합니다
            </h3>
            <div className="mt-1">
              <DrawdownChart data={curve} />
            </div>
          </section>

          <PnlPanel daily={daily} monthly={monthly} currency={book.base_currency} />

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

          <CashFlowPanel
            flows={flows}
            currency={book.base_currency}
            deposits={m.deposits}
            withdrawals={m.withdrawals}
            netTransfer={m.netTransfer}
            withdrawnFromAccount={m.withdrawnFromAccount}
          />
        </>
      ) : null}
    </div>
  );
}
