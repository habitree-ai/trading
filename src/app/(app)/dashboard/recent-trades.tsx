"use client";

import { useState, type ReactNode } from "react";

import { ExitPlanLines } from "@/components/exit-plan";
import { TradeChart } from "@/components/trade-chart";
import { RESULT_LABEL, SIDE_LABEL, type TradeFill } from "@/lib/domain";
import { activeTargetPrices, summarizeExits } from "@/lib/exit-plan";
import { dateTime, num, pnlClass, signed, signedPct } from "@/lib/format";
import type { TradeDerived } from "@/lib/metrics";

/** 대시보드는 체결을 읽지 않는다 — 실적은 거래 행의 청산가 한 점으로만 되짚는다. */
const NO_FILLS: TradeFill[] = [];

/**
 * 최근 거래 — 한 줄을 누르면 그 자리에서 간략 정보와 당시 차트를 편다.
 *
 * 대시보드에서 눈에 걸린 거래를 목록으로 건너뛰어 다시 찾지 않게 하려는 것이라,
 * 표시 항목과 기준(실현손익 = 손익 + 수수료, 손익률 = 실현손익 ÷ 증거금)은
 * 거래 목록과 같게 맞춘다.
 */
export function RecentTrades({
  rows,
  currency,
  now,
}: {
  rows: TradeDerived[];
  currency: string;
  /** 페이지를 그린 시각 — 아직 들고 있는 거래의 차트를 여기까지 그린다 */
  now: number;
}) {
  /** 한 번에 하나만 펼친다 — 여러 개를 열면 OKX 요청이 동시에 쏟아진다. */
  const [openChart, setOpenChart] = useState<string | null>(null);

  return (
    <ul className="mt-3 divide-y divide-border">
      {rows.map(({ trade, net, pnlPct, margin, equityAfter, result }) => {
        const open = openChart === trade.id;

        return (
          <li key={trade.id}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpenChart((id) => (id === trade.id ? null : trade.id))}
              className="flex w-full items-center gap-3 py-2 text-left text-sm hover:bg-surface-2/60"
            >
              <span className="tnum w-8 text-xs text-dim">#{trade.seq}</span>
              <span className={trade.side === "long" ? "text-profit" : "text-loss"}>
                {SIDE_LABEL[trade.side]}
              </span>
              <span className="font-medium">{trade.symbol}</span>
              <span className="text-xs text-dim">{RESULT_LABEL[result]}</span>
              <span className="tnum ml-auto text-xs text-dim">
                {dateTime(trade.exit_at ?? trade.entry_at)}
              </span>
              {/* 보유 중인 건 확정된 손익이 없다 — 평가손익을 대신 세운다. */}
              <span
                className={`tnum w-24 text-right font-medium ${
                  result === "open" ? pnlClass(trade.unrealized_pnl) : pnlClass(net)
                }`}
              >
                {result === "open" ? signed(trade.unrealized_pnl) : signed(net)}
              </span>
              <span className={`tnum w-20 text-right text-xs ${pnlClass(pnlPct)}`}>
                {signedPct(pnlPct)}
              </span>
              <span className="w-4 text-center text-[10px] text-dim" aria-hidden>
                {open ? "▲" : "▼"}
              </span>
            </button>

            {open ? (
              <div className="pb-3">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2/40 p-3 sm:grid-cols-4">
                  <Item label="진입">
                    <span className="tnum">{num(trade.entry_price)}</span>
                    <span className="tnum block text-[11px] text-dim">
                      {dateTime(trade.entry_at)}
                    </span>
                  </Item>
                  <Item label="청산">
                    <span className="tnum">{num(trade.exit_price)}</span>
                    <span className="tnum block text-[11px] text-dim">
                      {dateTime(trade.exit_at)}
                    </span>
                  </Item>
                  <Item label="투입">
                    <span className="tnum">{num(trade.notional, 0)}</span>
                    <span className="tnum block text-[11px] text-dim">
                      {num(trade.leverage, 1)}배 · 증거금 {num(margin, 0)}
                    </span>
                  </Item>
                  {/*
                    * 손절·목표는 목록 셀과 같은 줄 형태다 — 거래소에 걸려 있던 값이 먼저 서고
                    * 손으로 적은 계획은 옆에 붙는다. 닫힌 거래는 청산가 한 점의 실적이 먼저다.
                    */}
                  <Item label="손절 · 목표" className="col-span-2">
                    <ExitPlanLines summary={summarizeExits(trade, NO_FILLS, result === "open")} />
                  </Item>
                  <Item label={result === "open" ? `평가손익 (${currency})` : `실현손익 (${currency})`}>
                    {result === "open" ? (
                      <span className={`tnum ${pnlClass(trade.unrealized_pnl)}`}>
                        {signed(trade.unrealized_pnl)}
                      </span>
                    ) : (
                      <>
                        <span className={`tnum ${pnlClass(net)}`}>{signed(net)}</span>
                        {trade.fee ? (
                          <span className="tnum block text-[11px] text-dim">
                            {signed(trade.pnl)} · 수수료 {signed(trade.fee)}
                          </span>
                        ) : null}
                      </>
                    )}
                  </Item>
                  <Item label="손익률">
                    <span className={`tnum ${pnlClass(pnlPct)}`}>{signedPct(pnlPct)}</span>
                    <span className="block text-[11px] text-dim">증거금 대비</span>
                  </Item>
                  <Item label="자금">
                    <span className="tnum">{num(equityAfter, 0)}</span>
                  </Item>
                  <Item label="승패">
                    <span>{RESULT_LABEL[result]}</span>
                    {result !== "open" && (trade.review ?? "").trim() === "" ? (
                      <span className="block text-[11px] text-accent">복기 대기</span>
                    ) : null}
                  </Item>
                </dl>

                <div className="mt-3">
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
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Item({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`text-xs ${className}`}>
      <dt className="text-[11px] text-dim">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
