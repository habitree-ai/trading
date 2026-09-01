"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";

import { deleteTrade } from "@/app/(app)/trades/actions";
import { ExitPlanLines } from "@/components/exit-plan";
import { TradeChart } from "@/components/trade-chart";
import { TradesOverviewChart } from "@/components/trades-overview-chart";
import { RESULT_LABEL, SIDE_LABEL, type TradeFill, type TradeResult } from "@/lib/domain";
import { activeTargetPrices, summarizeExits } from "@/lib/exit-plan";
import { DASH, dateTime, num, pct, pnlClass, signed, signedPct } from "@/lib/format";
import type { TradeDerived } from "@/lib/metrics";

type ResultFilter = TradeResult | "all";

/** 닫힌 거래의 체결은 목록이 읽지 않는다(북 전량 부담) — 실적은 청산가 한 점으로 되짚는다. */
const NO_FILLS: TradeFill[] = [];

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
  fills,
  currency,
  now,
}: {
  rows: TradeDerived[];
  /** 들고 있는 거래의 체결 — 거래 id 로 묶여 온다. 부분청산 단계가 여기서 나온다 */
  fills: Record<string, TradeFill[]>;
  currency: string;
  /** 페이지를 그린 시각 — 아직 들고 있는 거래의 차트를 여기까지 그린다 */
  now: number;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ResultFilter>("all");
  const [symbol, setSymbol] = useState("all");
  const [newestFirst, setNewestFirst] = useState(true);
  const [onlyPending, setOnlyPending] = useState(false);
  /** 한 번에 하나만 펼친다 — 여러 개를 열면 OKX 요청이 동시에 쏟아진다. */
  const [openChart, setOpenChart] = useState<string | null>(null);
  /** 전체 차트 — 첫 거래부터 전 거래의 진입·청산을 한 장에. 표 위에 편다. */
  const [overview, setOverview] = useState(false);
  /**
   * 전체 차트에서 화살표로 고른 거래 — 행이 그려진 뒤 그 행으로 스크롤한다.
   *
   * 고르는 순간 필터를 풀 수 있어 행이 아직 없을 수 있다. 렌더가 끝난 뒤(effect) 찾아야
   * 스크롤할 대상이 있다.
   */
  const [scrollTo, setScrollTo] = useState<{ id: string; n: number } | null>(null);

  useEffect(() => {
    // `n` 은 같은 거래를 다시 눌러도 다시 스크롤하게 하는 일련번호다.
    if (scrollTo === null) return;
    document.getElementById(`trade-${scrollTo.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [scrollTo]);

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
    "손절 · 목표",
    "손익비",
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
        <button
          type="button"
          aria-pressed={overview}
          className={`${SELECT} ${overview ? "border-accent text-accent" : ""}`}
          onClick={() => setOverview((v) => !v)}
        >
          {overview ? "전체 차트 닫기" : "전체 차트"}
        </button>
        <span className="ml-auto text-xs text-dim">{visible.length}건 표시</span>
      </div>

      {/* 전체 차트는 승패·복기 필터와 무관하게 북의 거래 전부를 올린다 — 종목만 안에서 가른다. */}
      {overview ? (
        <TradesOverviewChart
          trades={rows.map((r) => r.trade)}
          preferredSymbol={symbol === "all" ? null : symbol}
          now={now}
          onPick={(id) => {
            // 필터에 가려 있으면 보이지 않는 행이 펼쳐진다 — 승패·복기 필터는 풀고 종목은 맞춘다.
            const target = rows.find((r) => r.trade.id === id);
            if (!target) return;
            setResult("all");
            setOnlyPending(false);
            if (symbol !== "all" && symbol !== target.trade.symbol) setSymbol(target.trade.symbol);
            setOpenChart(id);
            setScrollTo((prev) => ({ id, n: (prev?.n ?? 0) + 1 }));
          }}
        />
      ) : null}

      <div ref={scrollRef} className="scroll-x rounded-xl border border-border">
        {/* 최소폭은 사이드바를 뺀 1280px 급 화면에 스크롤 없이 들어가는 선 — 열을 더하면 다시 잰다. */}
        <table className="w-full min-w-[1200px] text-sm">
          <thead className="bg-surface-2 text-xs text-dim">
            <tr>
              {columns.map((h, i) => (
                <th
                  key={h}
                  className={`px-2 py-1.5 text-left font-medium whitespace-nowrap ${
                    i === 0 ? "pin-col" : ""
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const { trade, equityAfter, drawdownPct, pnlPct, net, result: outcome } = row;
              // 한 행에서 두 칸(손절·목표, 손익비)이 같은 계획을 읽는다 — 한 번만 계산한다.
              const exits = summarizeExits(trade, fills[trade.id] ?? NO_FILLS, outcome === "open");
              const hasRationale = (trade.rationale ?? "").trim() !== "";
              return (
              <Fragment key={trade.id}>
                {/* id 는 전체 차트의 화살표가 이 행으로 스크롤할 때 쓴다. */}
                <tr id={`trade-${trade.id}`} className="border-t border-border hover:bg-surface-2/60">
                <td className="tnum pin-col px-2 py-1.5 text-dim">{trade.seq}</td>
                <td className="px-2 py-1.5">
                  <span className={trade.side === "long" ? "text-profit" : "text-loss"}>
                    {SIDE_LABEL[trade.side]}
                  </span>
                </td>
                <td className="px-2 py-1.5 font-medium">{trade.symbol}</td>
                <FillCell price={trade.entry_price} at={trade.entry_at} />
                {/* 진입 옆 — 단계별 청산. 체결된 차수는 실현값, 아직이면 등록된 TP 기준 예상치. */}
                <td className="px-2 py-1.5 whitespace-nowrap">
                  <ExitPlanLines summary={exits} />
                </td>
                {/* 기록된 손절·목표로 잰 계획 손익비 — 다단 TP 는 비중 혼합 R. 둘 중 하나라도 없으면 − */}
                <td className="tnum px-2 py-1.5">
                  {exits.plan.total.blendedR === null ? DASH : num(exits.plan.total.blendedR, 2)}
                </td>
                <FillCell price={trade.exit_price} at={trade.exit_at} />
                <td className="px-2 py-1.5 whitespace-nowrap">
                  <ResultBadge result={outcome} />
                  {/* 근거 입력 여부 — 어느 쪽이든 누르면 수정 화면에서 바로 적거나 읽는다. */}
                  <Link
                    href={`/trades/${trade.id}`}
                    className={`ml-1 rounded border px-1 py-0.5 text-[10px] ${
                      hasRationale ? "border-border text-dim" : "border-accent/40 text-accent"
                    }`}
                  >
                    {hasRationale ? "근거 ✓" : "근거 쓰기"}
                  </Link>
                  {needsReview(row) ? (
                    <span className="ml-1 rounded border border-accent/40 px-1 py-0.5 text-[10px] text-accent">
                      복기
                    </span>
                  ) : null}
                </td>
                <td className="tnum px-2 py-1.5 text-dim">{num(trade.notional, 0)}</td>
                <td className="tnum px-2 py-1.5 text-dim">{num(trade.leverage, 1)}</td>
                {/*
                  계좌가 실제로 움직인 값(=손익+수수료)을 앞세우고, 내역은 아래 작게.
                  아직 들고 있는 거래는 확정된 게 없어 평가손익을 대신 세운다 — 시세를
                  따라 움직이는 값이라 확정 손익과 같은 자리에 같은 모양으로 두면
                  둘을 구분할 수가 없다.
                */}
                <td
                  className={`px-2 py-1.5 whitespace-nowrap ${
                    outcome === "open" ? pnlClass(trade.unrealized_pnl) : pnlClass(net)
                  }`}
                >
                  {outcome === "open" ? (
                    <>
                      <div className="tnum font-medium">{signed(trade.unrealized_pnl)}</div>
                      <div className="text-[11px] text-dim">평가손익</div>
                    </>
                  ) : (
                    <>
                      <div className="tnum font-medium">{signed(net)}</div>
                      {trade.fee ? (
                        <div className="tnum text-[11px] text-dim">
                          {signed(trade.pnl)} · 수수료 {signed(trade.fee)}
                        </div>
                      ) : null}
                    </>
                  )}
                </td>
                <td className={`tnum px-2 py-1.5 ${pnlClass(pnlPct)}`}>{signedPct(pnlPct)}</td>
                <td className="tnum px-2 py-1.5">{num(equityAfter, 0)}</td>
                <td className={`tnum px-2 py-1.5 ${drawdownPct < 0 ? "text-loss" : "text-dim"}`}>
                  {pct(drawdownPct)}
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => setOpenChart((id) => (id === trade.id ? null : trade.id))}
                    className={`text-xs ${openChart === trade.id ? "text-text" : "text-accent"}`}
                    aria-expanded={openChart === trade.id}
                  >
                    {openChart === trade.id ? "차트 닫기" : "차트"}
                  </button>
                  <Link href={`/trades/${trade.id}`} className="ml-2 text-xs text-accent">
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
                    className="ml-2 text-xs text-loss disabled:opacity-50"
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
                          stopPrice={trade.okx_stop_price ?? trade.stop_price}
                          targets={activeTargetPrices(trade)}
                          notional={trade.notional}
                          now={now}
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
    <td className="px-2 py-1.5 whitespace-nowrap">
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
