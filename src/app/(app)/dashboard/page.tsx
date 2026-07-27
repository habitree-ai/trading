import Link from "next/link";

import { DrawdownChart, EquityCurve, PnlBars, type EquityPoint } from "@/components/charts";
import { EmptyBook } from "@/components/empty-book";
import { StatTile } from "@/components/stat-tile";
import { RESULT_LABEL } from "@/lib/domain";
import { date, dateTime, num, pct, pnlClass, signed, signedPct } from "@/lib/format";
import { bucketBy, computeMetrics, deriveTrades, monthKey } from "@/lib/metrics";
import { getActiveBook, listTrades } from "@/lib/queries";

export default async function DashboardPage() {
  const book = await getActiveBook();
  if (!book) return <EmptyBook />;

  const derived = deriveTrades(book, await listTrades(book.id));
  const m = computeMetrics(book, derived);
  const months = bucketBy(derived, monthKey);

  const curve: EquityPoint[] = [
    { label: `${book.start_date} 시작`, equity: book.initial_capital, drawdown: 0, pnl: null },
    ...derived.map((d) => ({
      label: `#${d.trade.seq} ${date(d.trade.exit_at ?? d.trade.entry_at)}`,
      equity: d.equityAfter,
      drawdown: d.drawdownPct,
      pnl: d.trade.pnl,
    })),
  ];

  const recent = [...derived].reverse().slice(0, 8);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">대시보드</h1>
          <p className="mt-1 text-sm text-dim">
            {book.name} · {book.exchange ?? "거래소 미지정"} · {book.base_currency}
          </p>
        </div>
        <Link
          href="/trades/new"
          className="ml-auto rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
        >
          기록 추가
        </Link>
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
          sub={`초기 ${num(m.initialCapital, 0)} ${book.base_currency}`}
        />
        <StatTile
          label="수익율"
          value={signedPct(m.returnPct)}
          valueClass={pnlClass(m.returnPct)}
          sub={`차액 ${signed(m.netChange, 0)}`}
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
                — 거래 순서별 계좌 자금 ({book.base_currency})
              </span>
            </h2>
            <div className="mt-3">
              <EquityCurve
                data={curve}
                currency={book.base_currency}
                initialCapital={book.initial_capital}
              />
            </div>
            <h3 className="mt-4 text-xs font-medium text-dim">고점 대비 낙폭 (MDD)</h3>
            <div className="mt-1">
              <DrawdownChart data={curve} />
            </div>
          </section>

          <section className="rounded-xl border border-border bg-surface p-4">
            <h2 className="text-sm font-medium">
              월별 손익{" "}
              <span className="font-normal text-dim">
                — 0선 위가 이익, 아래가 손실 ({book.base_currency})
              </span>
            </h2>
            <div className="mt-3">
              <PnlBars data={months} currency={book.base_currency} />
            </div>
          </section>

          <section className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center">
              <h2 className="text-sm font-medium">최근 거래</h2>
              <Link href="/trades" className="ml-auto text-xs text-accent">
                전체 보기
              </Link>
            </div>
            <ul className="mt-3 divide-y divide-border">
              {recent.map(({ trade, pnlPct }) => (
                <li key={trade.id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="tnum w-8 text-xs text-dim">#{trade.seq}</span>
                  <span className={trade.side === "long" ? "text-profit" : "text-loss"}>
                    {trade.side === "long" ? "롱" : "숏"}
                  </span>
                  <span className="font-medium">{trade.symbol}</span>
                  <span className="text-xs text-dim">{RESULT_LABEL[trade.result]}</span>
                  <span className="tnum ml-auto text-xs text-dim">
                    {dateTime(trade.exit_at ?? trade.entry_at)}
                  </span>
                  <span className={`tnum w-24 text-right font-medium ${pnlClass(trade.pnl)}`}>
                    {signed(trade.pnl)}
                  </span>
                  <span className={`tnum w-20 text-right text-xs ${pnlClass(pnlPct)}`}>
                    {signedPct(pnlPct)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}
