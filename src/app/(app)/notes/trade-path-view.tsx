"use client";

import { useEffect, useMemo, useState } from "react";

import { formatDuration } from "@/components/measure-tool";
import { TradeChart, type ChartMarker } from "@/components/trade-chart";
import type { Trade } from "@/lib/domain";
import { activeTargetPrices, activeTargetShares } from "@/lib/exit-plan";
import { dateTime, num, pnlClass, signed } from "@/lib/format";
import { BAR_MS, floorToBar, type Candle } from "@/lib/okx";
import { pickPathBar, reviewPath, type PathPoint } from "@/lib/trade-path";

/**
 * 차트 팝업 안의 TP 도달 경로 복기(REQ-0077) — 차트에 세 시점을 찍고 아래에 요약을 붙인다.
 *
 * 차트가 쓰는 봉(구간 약 60봉)은 시점을 재기에 거칠어, 경로는 따로 가장 짧은 봉으로 받는다.
 * 청산 뒤 같은 길이까지 받는다 — 청산 뒤 TP 에 닿았는지(기다림)를 보려고.
 */
export function TradePathChart({ trade, now }: { trade: Trade; now: number }) {
  const entryMs = Date.parse(trade.entry_at);
  const exitMs = trade.exit_at ? Date.parse(trade.exit_at) : null;
  const endMs = exitMs !== null ? exitMs + Math.max(exitMs - entryMs, 0) : now;
  const bar = pickPathBar(endMs - entryMs);
  const from = floorToBar(entryMs, bar);
  const to = floorToBar(endMs, bar) + BAR_MS[bar];

  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/candles?symbol=${encodeURIComponent(trade.symbol)}&bar=${bar}&from=${from}&to=${to}`,
        );
        const json: unknown = await res.json();
        if (!res.ok) {
          const message =
            typeof json === "object" && json !== null && "error" in json
              ? String((json as { error: unknown }).error)
              : "캔들을 가져오지 못했습니다.";
          throw new Error(message);
        }
        if (!cancelled) setCandles((json as { candles: Candle[] }).candles);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "알 수 없는 오류");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trade.symbol, bar, from, to]);

  const tp = activeTargetPrices(trade)[0];
  const stop = trade.okx_stop_price ?? trade.stop_price;
  const review = useMemo(
    () =>
      candles && trade.entry_price !== null
        ? reviewPath(
            {
              side: trade.side,
              entryMs,
              entryPrice: trade.entry_price,
              exitMs,
              exitPrice: trade.exit_price,
              tp,
              stop,
              leverage: trade.leverage,
              nowMs: now,
            },
            candles,
            bar,
          )
        : null,
    [candles, trade.side, entryMs, trade.entry_price, exitMs, trade.exit_price, tp, stop, trade.leverage, now, bar],
  );

  // 차트가 렌더마다 마커를 다시 긋지 않게 경로 결과가 바뀔 때만 새로 만든다.
  const markers = useMemo<ChartMarker[]>(() => {
    if (!review) return [];
    const out: ChartMarker[] = [];
    if (review.peak) {
      out.push({
        ms: review.peak.ms,
        position: trade.side === "long" ? "aboveBar" : "belowBar",
        tone: "profit",
        text: `${review.peakFirst ? "1차 최대수익" : "최대수익"} ${pctText(review.peak.pct)}`,
      });
    }
    if (review.trough) {
      out.push({
        ms: review.trough.ms,
        position: trade.side === "long" ? "belowBar" : "aboveBar",
        tone: "loss",
        text: `최대손실 ${pctText(review.trough.pct)}`,
      });
    }
    if (review.tp) {
      out.push({ ms: review.tp.ms, position: "aboveBar", tone: "accent", text: "TP 도달" });
    }
    if (review.tpAfterExit) {
      out.push({ ms: review.tpAfterExit.ms, position: "aboveBar", tone: "accent", text: "청산 뒤 TP" });
    }
    return out;
  }, [review, trade.side]);

  return (
    <div className="space-y-2">
      <TradeChart
        tradeId={trade.id}
        symbol={trade.symbol}
        side={trade.side}
        entryAt={trade.entry_at}
        exitAt={trade.exit_at}
        entryPrice={trade.entry_price}
        exitPrice={trade.exit_price}
        stopPrice={stop}
        targets={activeTargetPrices(trade)}
        targetShares={activeTargetShares(trade)}
        notional={trade.notional}
        now={now}
        extraMarkers={markers}
      />

      <section className="rounded-lg border border-border p-2 text-xs">
        <h3 className="px-1 font-medium text-dim">TP 도달 경로</h3>
        {error ? (
          <p className="mt-1 px-1 text-loss">{error}</p>
        ) : trade.entry_price === null ? (
          <p className="mt-1 px-1 text-dim">진입가가 없어 경로를 계산할 수 없습니다.</p>
        ) : candles === null ? (
          <p className="mt-1 px-1 text-dim">경로 캔들을 불러오는 중…</p>
        ) : review === null ? (
          <p className="mt-1 px-1 text-dim">진입 구간의 캔들이 없습니다.</p>
        ) : (
          <>
            <table className="mt-1 w-full text-left">
              <thead className="text-dim">
                <tr>
                  <th className="px-1 py-0.5 font-normal">시점</th>
                  <th className="px-1 py-0.5 font-normal">시각</th>
                  <th className="px-1 py-0.5 font-normal">진입 후</th>
                  <th className="px-1 py-0.5 text-right font-normal">가격</th>
                  <th className="px-1 py-0.5 text-right font-normal">손익(가격)</th>
                  <th className="px-1 py-0.5 text-right font-normal">손익(증거금)</th>
                </tr>
              </thead>
              <tbody className="tnum">
                <PointRow
                  label={review.peakFirst ? "1차 최대수익" : "최대수익(손실 뒤)"}
                  point={review.peak}
                  empty="진입가 위로 간 적 없음"
                />
                <PointRow label="최대손실" point={review.trough} empty="역행 없음" />
                {review.tp ? (
                  <PointRow label="TP 도달" point={review.tp} />
                ) : review.exit ? (
                  <PointRow label={tp === null ? "청산" : "청산(TP 미도달)"} point={review.exit} />
                ) : (
                  <tr>
                    <td className="px-1 py-0.5">TP</td>
                    <td colSpan={5} className="px-1 py-0.5 text-dim">
                      {tp === null ? "TP 없음" : "보유중 — 아직 미도달"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {review.tpAfterExit ? (
              <p className="mt-1 px-1 text-dim">
                청산 {formatDuration(review.tpAfterExit.afterExitMs)} 뒤 TP 도달 (
                {dateTime(new Date(review.tpAfterExit.ms).toISOString())})
              </p>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1">
              <span className="text-dim">문제 후보</span>
              {review.verdicts.length === 0 ? (
                <span className="text-dim">규칙에 걸린 것 없음</span>
              ) : (
                review.verdicts.map((v) => (
                  <span key={v.key} className="rounded-full border border-beta/50 px-2 py-0.5 text-beta" title={v.reason}>
                    {v.label} · {v.reason}
                  </span>
                ))
              )}
            </div>
            <p className="mt-1 px-1 text-[11px] text-dim/80">
              {review.bar} 봉 기준 근사 — 같은 봉 안에서 무엇이 먼저였는지는 모른다.
              {review.skipped.length > 0 ? ` ${review.skipped.join(" · ")}` : ""}
            </p>
          </>
        )}
      </section>
    </div>
  );
}

function pctText(value: number): string {
  return `${signed(value)}%`;
}

function PointRow({ label, point, empty }: { label: string; point: PathPoint | null; empty?: string }) {
  if (!point) {
    return (
      <tr>
        <td className="px-1 py-0.5">{label}</td>
        <td colSpan={5} className="px-1 py-0.5 text-dim">
          {empty ?? "—"}
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td className="px-1 py-0.5">{label}</td>
      <td className="px-1 py-0.5">{dateTime(new Date(point.ms).toISOString())}</td>
      <td className="px-1 py-0.5">{formatDuration(point.elapsedMs)}</td>
      <td className="px-1 py-0.5 text-right">{num(point.price)}</td>
      <td className={`px-1 py-0.5 text-right ${pnlClass(point.pct)}`}>{pctText(point.pct)}</td>
      <td className={`px-1 py-0.5 text-right ${pnlClass(point.marginPct)}`}>
        {point.marginPct === null ? "—" : pctText(point.marginPct)}
      </td>
    </tr>
  );
}
