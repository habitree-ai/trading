"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";

import { deleteTrade } from "@/app/(app)/trades/actions";
import { TradeChart } from "@/components/trade-chart";
import {
  RESULT_LABEL,
  SIDE_LABEL,
  type TradeAnnotation,
  type TradeFill,
  type TradeResult,
} from "@/lib/domain";
import { dateTime, num, pct, pnlClass, signed, signedPct } from "@/lib/format";
import type { TradeDerived } from "@/lib/metrics";

type ResultFilter = TradeResult | "all";

/**
 * 복기가 비어 있는 청산 거래.
 *
 * API로 받아 온 거래는 숫자만 채워져 들어온다 — 손으로 쓸 칸(근거·복기·감정)이
 * 비어 있는 건을 눈에 띄게 해 두지 않으면 그대로 묻힌다.
 */
function needsReview({ trade, result }: TradeDerived): boolean {
  return result !== "open" && (trade.review ?? "").trim() === "";
}

export function TradeTable({
  rows,
  currency,
  fillsByTrade = {},
  annotationsByTrade = {},
}: {
  rows: TradeDerived[];
  currency: string;
  /** 거래 id → 낱개 체결. 차트가 평균가 대신 실제 좌표를 찍는 데 쓴다. */
  fillsByTrade?: Record<string, TradeFill[]>;
  /** 거래 id → 차트 메모. 펼친 차트에 그대로 그려진다. */
  annotationsByTrade?: Record<string, TradeAnnotation[]>;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ResultFilter>("all");
  const [symbol, setSymbol] = useState("all");
  const [newestFirst, setNewestFirst] = useState(true);
  const [onlyPending, setOnlyPending] = useState(false);
  /** 한 번에 하나만 펼친다 — 여러 개를 열면 OKX 요청이 동시에 쏟아진다. */
  const [openChart, setOpenChart] = useState<string | null>(null);

  /**
   * 가로 스크롤 영역의 보이는 폭.
   *
   * 차트는 표 안(선택한 행 바로 아래)에 그리는데, 칸의 폭은 표 전체 폭을 따라가
   * 그대로 두면 차트를 보려고 옆으로 밀어야 한다. 보이는 만큼으로 폭을 묶는다.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewWidth, setViewWidth] = useState(0);

  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => setViewWidth(host.clientWidth));
    observer.observe(host);
    setViewWidth(host.clientWidth);
    return () => observer.disconnect();
  }, []);

  const symbols = useMemo(
    () => [...new Set(rows.map((r) => r.trade.symbol))].sort(),
    [rows],
  );

  const pendingCount = useMemo(() => rows.filter(needsReview).length, [rows]);

  const visible = useMemo(() => {
    const filtered = rows.filter(
      (r) =>
        (result === "all" || r.result === result) &&
        (symbol === "all" || r.trade.symbol === symbol) &&
        (!onlyPending || needsReview(r)),
    );
    return newestFirst ? [...filtered].reverse() : filtered;
  }, [rows, result, symbol, newestFirst, onlyPending]);

  const SELECT =
    "rounded-lg border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent";

  const columns = [
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
  ];

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
        <button
          type="button"
          aria-pressed={onlyPending}
          className={`${SELECT} ${onlyPending ? "border-accent text-accent" : ""}`}
          onClick={() => setOnlyPending((v) => !v)}
        >
          복기 대기 {pendingCount}
        </button>
        <span className="ml-auto text-xs text-dim">{visible.length}건 표시</span>
      </div>

      <div ref={scrollRef} className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="bg-surface-2 text-xs text-dim">
            <tr>
              {columns.map((h) => (
                <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const { trade, equityAfter, drawdownPct, pnlPct, net, result: outcome } = row;
              return (
              <Fragment key={trade.id}>
                <tr className="border-t border-border hover:bg-surface-2/60">
                <td className="tnum px-3 py-2 text-dim">{trade.seq}</td>
                <td className="px-3 py-2">
                  <span className={trade.side === "long" ? "text-profit" : "text-loss"}>
                    {SIDE_LABEL[trade.side]}
                  </span>
                </td>
                <td className="px-3 py-2 font-medium">{trade.symbol}</td>
                <FillCell price={trade.entry_price} at={trade.entry_at} />
                <FillCell price={trade.exit_price} at={trade.exit_at} />
                <td className="px-3 py-2 whitespace-nowrap">
                  <ResultBadge result={outcome} />
                  {needsReview(row) ? (
                    <span className="ml-1 rounded border border-accent/40 px-1 py-0.5 text-[10px] text-accent">
                      복기
                    </span>
                  ) : null}
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
                  <button
                    type="button"
                    onClick={() => setOpenChart((id) => (id === trade.id ? null : trade.id))}
                    className={`text-xs ${openChart === trade.id ? "text-text" : "text-accent"}`}
                    aria-expanded={openChart === trade.id}
                  >
                    {openChart === trade.id ? "차트 닫기" : "차트"}
                  </button>
                  <Link href={`/trades/${trade.id}`} className="ml-3 text-xs text-accent">
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

                {/* 차트는 고른 행 바로 아래에 편다 — 표 끝까지 내려가야 보이면 짝을 잃는다. */}
                {openChart === trade.id ? (
                  <tr className="border-t border-border bg-surface-2/40">
                    <td colSpan={columns.length} className="p-0">
                      {/* 왼쪽에 붙여 두고 폭을 보이는 만큼으로 묶는다 — 표를 옆으로 밀지 않고 보게. */}
                      <div
                        className="sticky left-0 p-3"
                        style={{ width: viewWidth || undefined }}
                      >
                        <TradeChart
                          tradeId={trade.id}
                          symbol={trade.symbol}
                          side={trade.side}
                          entryAt={trade.entry_at}
                          exitAt={trade.exit_at}
                          entryPrice={trade.entry_price}
                          exitPrice={trade.exit_price}
                          stopPrice={trade.stop_price}
                          notional={trade.notional}
                          fills={fillsByTrade[trade.id] ?? []}
                          annotations={annotationsByTrade[trade.id] ?? []}
                        />
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
              );
            })}
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
