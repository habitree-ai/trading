"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import { updateTradeTargets } from "@/app/(app)/trades/actions";

import { formatDuration } from "@/components/measure-tool";
import { TradeChart, type ChartMarker } from "@/components/trade-chart";
import type { Trade } from "@/lib/domain";
import { activeTargetPrices, activeTargetShares } from "@/lib/exit-plan";
import { dateTime, num, pnlClass, signed } from "@/lib/format";
import type { Candle } from "@/lib/okx";
import { pathRequest, reviewPath, type PathPoint } from "@/lib/trade-path";

/**
 * 거래 하나의 경로 복기 계산 — 경로 캔들을 받아 세 시점·판정·차트 마커를 낸다(REQ-0077·0080).
 *
 * 차트가 쓰는 봉(구간 약 60봉)은 시점을 재기에 거칠어, 경로는 따로 가장 짧은 봉으로 받는다.
 * 봉·구간·입력은 경로 복기 리스트(서버)와 같은 `pathRequest` — 두 화면의 숫자가 같게.
 * `enabled` 가 꺼져 있으면 캔들을 부르지 않는다(거래 표에서 TP 없는 거래).
 */
export function usePathReview(trade: Trade, now: number, enabled = true) {
  const req = useMemo(() => pathRequest(trade, now), [trade, now]);
  const { bar, from, to } = req;
  const on = enabled && req.input !== null;

  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!on) return;
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
  }, [on, trade.symbol, bar, from, to]);

  // TP 를 고치면 req 만 바뀐다 — 캔들은 그대로 두고 다시 계산한다.
  const review = useMemo(
    () => (on && candles && req.input ? reviewPath(req.input, candles, req.bar) : null),
    [on, candles, req],
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

  return { req, candles, error, review, markers };
}

/**
 * 경로 마커를 얹은 거래 차트 — 거래 표 행 차트(REQ-0080). TP 가 있는 거래만 경로를 계산하고,
 * 없으면 추가 요청 없이 지금 차트와 같다.
 */
export function PathMarkedChart({ trade, now, startInReplay }: { trade: Trade; now: number; startInReplay?: boolean }) {
  const { markers } = usePathReview(trade, now, activeTargetPrices(trade)[0] !== null);
  return <TradeChartFor trade={trade} now={now} markers={markers} startInReplay={startInReplay} />;
}

/** 거래 행 하나로 `TradeChart` 를 그린다 — 팝업·거래 표가 같은 props 로. 마커를 안 주면 진입·청산만 */
export function TradeChartFor({
  trade,
  now,
  markers,
  startInReplay,
}: {
  trade: Trade;
  now: number;
  markers?: ChartMarker[];
  startInReplay?: boolean;
}) {
  return (
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
      targetShares={activeTargetShares(trade)}
      notional={trade.notional}
      now={now}
      startInReplay={startInReplay}
      extraMarkers={markers}
    />
  );
}

/**
 * 경로 복기 팝업 본문(REQ-0077·0080) — 경로 마커 차트 + 세 시점 표 + 판정 + TP 입력.
 * TP 를 저장하면 페이지가 새 값을 내려보내고 그 자리에서 다시 계산된다(청산된 거래도).
 */
export function TradePathChart({ trade, now }: { trade: Trade; now: number }) {
  const { req, candles, error, review, markers } = usePathReview(trade, now);
  const tp = req.input?.tp ?? null;

  return (
    <div className="space-y-2">
      <TradeChartFor trade={trade} now={now} markers={markers} />

      <TargetsForm trade={trade} />

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

/**
 * TP 입력(REQ-0080) — 청산된 거래도 복기용으로 TP 를 적는다. 저장은 거래 표의 TP 수정과 같은
 * `updateTradeTargets`(같은 검증·같은 칸). 거래소에 걸렸던 TP 가 있으면 경로 기준은 그쪽이 먼저다.
 */
function TargetsForm({ trade }: { trade: Trade }) {
  const [values, setValues] = useState(() =>
    [trade.tp1_price, trade.tp2_price, trade.tp3_price].map((p) => (p === null ? "" : String(p))),
  );
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      const result = await updateTradeTargets(trade.id, { tp1: values[0], tp2: values[1], tp3: values[2] });
      setMessage(result.error ? { ok: false, text: result.error } : { ok: true, text: "저장했습니다 — 경로를 다시 계산합니다" });
    });

  return (
    <section className="rounded-lg border border-border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-dim">TP</span>
        {values.map((v, i) => (
          <input
            key={i}
            aria-label={`TP${i + 1} 가격`}
            value={v}
            inputMode="decimal"
            placeholder={`TP${i + 1}`}
            onChange={(e) => setValues((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))}
            className="tnum w-24 rounded border border-border bg-bg px-1.5 py-0.5 outline-none focus:border-accent"
          />
        ))}
        <button type="button" disabled={pending} onClick={save} className="text-accent disabled:opacity-50">
          {pending ? "저장 중…" : "저장"}
        </button>
        {message ? <span className={message.ok ? "text-dim" : "text-loss"}>{message.text}</span> : null}
      </div>
      <p className="mt-1 text-[11px] text-dim/80">
        {trade.okx_tp_price !== null
          ? `경로 기준 TP 는 거래소에 걸렸던 ${num(trade.okx_tp_price)} — 여기 적은 TP1 보다 먼저다.`
          : "청산 뒤에도 적을 수 있다 — 저장하면 경로·판정을 다시 계산하고 경로 복기 리스트에도 들어간다. 비우면 해제."}
      </p>
    </section>
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
