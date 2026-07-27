"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";

import { deleteTrade } from "@/app/(app)/trades/actions";
import { RESULT_LABEL, SIDE_LABEL, type TradeResult } from "@/lib/domain";
import { dateTime, num, pct, pnlClass, signed, signedPct } from "@/lib/format";
import type { TradeDerived } from "@/lib/metrics";

type ResultFilter = TradeResult | "all";

export function TradeTable({ rows, currency }: { rows: TradeDerived[]; currency: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ResultFilter>("all");
  const [symbol, setSymbol] = useState("all");
  const [newestFirst, setNewestFirst] = useState(true);

  const symbols = useMemo(
    () => [...new Set(rows.map((r) => r.trade.symbol))].sort(),
    [rows],
  );

  const visible = useMemo(() => {
    const filtered = rows.filter(
      (r) =>
        (result === "all" || r.trade.result === result) &&
        (symbol === "all" || r.trade.symbol === symbol),
    );
    return newestFirst ? [...filtered].reverse() : filtered;
  }, [rows, result, symbol, newestFirst]);

  const SELECT =
    "rounded-lg border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="승패 필터"
          className={SELECT}
          value={result}
          onChange={(e) => setResult(e.target.value as ResultFilter)}
        >
          <option value="all">전체 승패</option>
          <option value="win">승</option>
          <option value="loss">패</option>
          <option value="be">본전</option>
          <option value="open">보유중</option>
        </select>
        <select
          aria-label="종목 필터"
          className={SELECT}
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
        >
          <option value="all">전체 종목</option>
          {symbols.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={SELECT}
          onClick={() => setNewestFirst((v) => !v)}
        >
          {newestFirst ? "최신순 ↓" : "오래된순 ↑"}
        </button>
        <span className="ml-auto text-xs text-dim">{visible.length}건 표시</span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="bg-surface-2 text-xs text-dim">
            <tr>
              {[
                "순번",
                "방향",
                "종목",
                "진입 (가격 · 시각)",
                "청산 (가격 · 시각)",
                "승패",
                "투입",
                "Lv",
                `실현손익 (${currency})`,
                "손익률",
                "자금",
                "MDD",
                "",
              ].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map(({ trade, equityAfter, drawdownPct, pnlPct, net }) => (
              <tr key={trade.id} className="border-t border-border hover:bg-surface-2/60">
                <td className="tnum px-3 py-2 text-dim">{trade.seq}</td>
                <td className="px-3 py-2">
                  <span className={trade.side === "long" ? "text-profit" : "text-loss"}>
                    {SIDE_LABEL[trade.side]}
                  </span>
                </td>
                <td className="px-3 py-2 font-medium">{trade.symbol}</td>
                <FillCell price={trade.entry_price} at={trade.entry_at} />
                <FillCell price={trade.exit_price} at={trade.exit_at} />
                <td className="px-3 py-2">
                  <ResultBadge result={trade.result} />
                </td>
                <td className="tnum px-3 py-2 text-dim">{num(trade.notional, 0)}</td>
                <td className="tnum px-3 py-2 text-dim">{num(trade.leverage, 1)}</td>
                {/* 계좌가 실제로 움직인 값(=손익+수수료)을 앞세우고, 내역은 아래 작게. */}
                <td className={`px-3 py-2 whitespace-nowrap ${pnlClass(net)}`}>
                  <div className="tnum font-medium">{signed(net)}</div>
                  {trade.fee ? (
                    <div className="tnum text-[11px] text-dim">
                      {signed(trade.pnl)} · 수수료 {signed(trade.fee)}
                    </div>
                  ) : null}
                </td>
                <td className={`tnum px-3 py-2 ${pnlClass(pnlPct)}`}>{signedPct(pnlPct)}</td>
                <td className="tnum px-3 py-2">{num(equityAfter, 0)}</td>
                <td className={`tnum px-3 py-2 ${drawdownPct < 0 ? "text-loss" : "text-dim"}`}>
                  {pct(drawdownPct)}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <Link href={`/trades/${trade.id}`} className="text-xs text-accent">
                    수정
                  </Link>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      const ok = window.confirm(
                        `#${trade.seq} ${trade.symbol} 거래를 삭제할까요? 되돌릴 수 없습니다.`,
                      );
                      if (ok) startTransition(() => void deleteTrade(trade.id));
                    }}
                    className="ml-3 text-xs text-loss disabled:opacity-50"
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 체결 한 칸에 가격과 시각을 함께 담는다 — 둘을 따로 보면 짝짓기가 어렵다. */
function FillCell({ price, at }: { price: number | null; at: string | null }) {
  return (
    <td className="px-3 py-2 whitespace-nowrap">
      <div className="tnum text-sm">{num(price)}</div>
      <div className="tnum text-[11px] text-dim">{dateTime(at)}</div>
    </td>
  );
}

function ResultBadge({ result }: { result: TradeResult }) {
  const tone =
    result === "win"
      ? "border-profit/40 text-profit"
      : result === "loss"
        ? "border-loss/40 text-loss"
        : "border-border text-dim";

  return (
    <span className={`rounded border px-1.5 py-0.5 text-[11px] ${tone}`}>
      {RESULT_LABEL[result]}
    </span>
  );
}
