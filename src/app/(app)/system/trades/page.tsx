import Link from "next/link";

import { ModeTabs } from "@/app/(app)/system/mode-tabs";
import { EXIT_LABEL, MEMBER_LABEL, resolveModes } from "@/app/(app)/system/shared";
import { DASH, dateTime, num, pnlClass, signed } from "@/lib/format";
import {
  SYSTEM_MODE_META,
  readSystemTradesAll,
  summarizeSystem,
} from "@/lib/system-trading";

/**
 * 자동 거래 목록 — 봇이 낸 주문 전량.
 *
 * 수동 거래 목록(`/trades`)과 표가 다르다. 여기서 답해야 하는 질문이 다르기 때문이다:
 * 수동 쪽은 "내가 왜 이렇게 했나"이고, 여기는 "기준이 언제 발화했고 어떻게 끝났나"다.
 * 그래서 감정·근거 칸이 없고, 대신 판정 시점의 지표 스냅샷이 붙는다.
 */
export default async function SystemTradesPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode: requested } = await searchParams;
  const selection = await resolveModes(requested);

  if (!selection) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">자동 거래</h1>
        </header>
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          봇이 아직 한 건도 체결하지 않았습니다.
        </p>
      </div>
    );
  }

  const mode = selection.current;
  const meta = SYSTEM_MODE_META[mode];
  const trades = await readSystemTradesAll(mode);
  const summary = summarizeSystem(trades);

  return (
    <div className="space-y-5">
      <header className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">자동 거래</h1>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
              meta.real ? "border-loss text-loss" : "border-alpha text-alpha"
            }`}
          >
            {meta.label}
          </span>
          <p className="tnum text-sm text-dim">
            완결 {summary.closed}건 · 진행 {summary.open}건 · 누적{" "}
            <b className={pnlClass(summary.netPnlUsd)}>{signed(summary.netPnlUsd, 2)}</b> USDT
          </p>
        </div>
        <ModeTabs items={selection.items} current={mode} />
      </header>

      {trades.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          이 모드에는 아직 체결이 없습니다.{" "}
          <Link href={`/system/decisions?mode=${mode}`} className="text-alpha">
            판정 로그에서 왜 안 들어갔는지 보기 →
          </Link>
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full min-w-[62rem] text-[12.5px]">
            <thead className="border-b border-border text-[11px] text-dim">
              <tr>
                <th className="px-3 py-2 text-left font-medium">진입</th>
                <th className="px-3 py-2 text-left font-medium">기준</th>
                <th className="px-3 py-2 text-left font-medium">방향</th>
                <th className="px-3 py-2 text-right font-medium">진입가</th>
                <th className="px-3 py-2 text-right font-medium">청산가</th>
                <th className="px-3 py-2 text-left font-medium">청산</th>
                <th className="px-3 py-2 text-right font-medium">Lv</th>
                <th className="px-3 py-2 text-right font-medium">손익률</th>
                <th className="px-3 py-2 text-right font-medium">손익($)</th>
                <th className="px-3 py-2 text-right font-medium">잔고</th>
                <th className="px-3 py-2 text-left font-medium">신호봉 지표</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => {
                const s = t.signal;
                const indicators = s
                  ? [
                      s.rsi !== null ? `RSI ${num(s.rsi, 1)}` : null,
                      s.atr !== null ? `ATR ${num(s.atr, 0)}` : null,
                      t.member === "gc" && s.sma20 !== null && s.sma50 !== null
                        ? `SMA ${num(s.sma20, 0)}/${num(s.sma50, 0)}`
                        : null,
                      t.member === "dc" && s.ll20 !== null ? `LL20 ${num(s.ll20, 0)}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : "";

                return (
                  <tr
                    key={t.tradeId}
                    className={`border-t border-border ${t.open ? "bg-alpha/5" : ""}`}
                  >
                    <td className="tnum px-3 py-2 whitespace-nowrap">
                      {dateTime(new Date(t.entryTs).toISOString()).slice(5)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {t.name || MEMBER_LABEL[t.member] || t.member}
                    </td>
                    <td className="px-3 py-2">
                      <span className={t.side === "long" ? "text-profit" : "text-loss"}>
                        {t.side === "long" ? "롱" : "숏"}
                      </span>
                    </td>
                    <td className="tnum px-3 py-2 text-right">{num(t.entryPrice, 1)}</td>
                    <td className="tnum px-3 py-2 text-right">
                      {t.open ? DASH : num(t.exitPrice, 1)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {t.open ? (
                        <span className="rounded border border-alpha/50 px-1.5 py-0.5 text-[10px] text-alpha">
                          진행 중
                        </span>
                      ) : (
                        <>
                          {EXIT_LABEL[t.exitType] ?? t.exitType}
                          {t.holdBars ? (
                            <span className="tnum ml-1 text-[10px] text-dim">{t.holdBars}봉</span>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td className="tnum px-3 py-2 text-right">{num(t.lev, 1)}</td>
                    <td className={`tnum px-3 py-2 text-right ${t.open ? "" : pnlClass(t.netPct)}`}>
                      {t.open ? DASH : `${signed(t.netPct, 2)}%`}
                    </td>
                    <td className={`tnum px-3 py-2 text-right ${t.open ? "" : pnlClass(t.pnlUsd ?? null)}`}>
                      {t.open || t.pnlUsd === undefined ? DASH : signed(t.pnlUsd, 2)}
                    </td>
                    <td className="tnum px-3 py-2 text-right text-dim">
                      {num(t.equityAfter ?? t.eqAtEntry ?? null, 2)}
                    </td>
                    <td className="tnum px-3 py-2 text-[11px] whitespace-nowrap text-dim">
                      {indicators || DASH}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-dim">
        손익률은 계좌 기준(레버리지·왕복 수수료 0.1% 반영)입니다. 잔고 칸은 청산 직후 값이고,
        진행 중인 행은 진입 시점 잔고를 보여 줍니다.
      </p>
    </div>
  );
}
