import Link from "next/link";

import { ChartDialogButton } from "@/app/(app)/notes/chart-dialog";
import { formatDuration } from "@/components/measure-tool";
import { SIDE_LABEL, type Trade } from "@/lib/domain";
import { date, pnlClass, signed } from "@/lib/format";
import { isOpenTrade, netOf } from "@/lib/metrics";
import { fetchCandles, toInstId } from "@/lib/okx";
import {
  pathRequest,
  reviewPath,
  summarizePathReviews,
  VERDICT_KEYS,
  VERDICT_LABEL,
  type PathPoint,
  type PathReview,
} from "@/lib/trade-path";

interface Row {
  trade: Trade;
  bookName: string;
  /** 실현손익 — 보유중이면 null("보유중" 표기, 요약 합산 제외). `netOf` 는 보유중 거래에 수수료만 돌려준다 */
  net: number | null;
  /** 기록된 손절가 — 없으면 손절선 칸에 "미기록" */
  stop: number | null;
  review: PathReview | null;
  error: string | null;
}

/**
 * 경로 복기 리스트(REQ-0079, REQ-0081 개편) — TP 를 기록한 거래(보유중 포함)를 모아 실제 청산과 무관하게
 * TP 에 언제 닿았는지, 닿기 전에 얼마나 잃을 뻔했는지, 문제가 방향성·진입·목표가·청산 타이밍 중 어디에
 * 몰렸는지 본다.
 *
 * 서버에서 캔들을 받아 계산한다(하루 캐시). 봉·구간은 팝업과 같은 `pathRequest` — 행의 📈 로 연
 * 팝업과 숫자가 같다. OKX 가 몰리지 않게 거래는 하나씩 부른다.
 */
export async function PathReviewList({
  trades,
  bookNames,
  excludedNoTp,
  now,
  backHref,
}: {
  /** TP 를 기록한 거래(보유중 포함) — 최신순 */
  trades: Trade[];
  bookNames: Record<string, string>;
  /** TP 를 안 적어 뺀 거래 수 */
  excludedNoTp: number;
  now: number;
  backHref: string;
}) {
  const rows: Row[] = [];
  for (const trade of trades) {
    const req = pathRequest(trade, now);
    let review: PathReview | null = null;
    let error: string | null = null;
    if (req.input) {
      try {
        const candles = await fetchCandles(toInstId(trade.symbol), req.bar, req.from, req.to);
        review = reviewPath(req.input, candles, req.bar);
      } catch (e: unknown) {
        error = e instanceof Error ? e.message : "캔들을 가져오지 못했습니다";
      }
    }
    rows.push({
      trade,
      bookName: bookNames[trade.book_id] ?? "",
      net: isOpenTrade(trade) ? null : netOf(trade),
      stop: req.input?.stop ?? null,
      review,
      error,
    });
  }

  const reviewed = rows.flatMap((r) => (r.review ? [{ review: r.review, net: r.net }] : []));
  const summary = summarizePathReviews(reviewed);
  const avg = (ms: number | null) => (ms === null ? "—" : formatDuration(ms));
  const troughAvg = summary.avgTroughAmount === null ? "—" : `${signed(summary.avgTroughAmount)} USDT`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link href={backHref} className="text-xs text-dim hover:text-text lg:hidden">
          ← 목록
        </Link>
        <h2 className="text-base font-medium">경로 복기</h2>
        <span className="text-xs text-dim">
          진입 → TP 도달(실제 청산 무관) · TP 기록 거래 {rows.length}건(북 전체·보유중 포함)
        </span>
      </div>

      <section className="rounded-xl border border-border bg-surface p-3 text-sm">
        <h3 className="text-xs font-medium text-dim">문제가 어디에 몰렸나</h3>
        {summary.total === 0 ? (
          <p className="mt-2 text-xs text-dim">계산된 거래가 없습니다.</p>
        ) : (
          <>
            <table className="mt-2 w-full text-left text-xs">
              <thead className="text-dim">
                <tr>
                  <th className="py-0.5 font-normal">판정</th>
                  <th className="py-0.5 text-right font-normal">건수</th>
                  <th className="py-0.5 text-right font-normal">순손익 합</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {VERDICT_KEYS.map((k) => (
                  <tr key={k} className={summary.top === k ? "font-medium" : ""}>
                    <td className="py-0.5">{VERDICT_LABEL[k]}</td>
                    <td className="py-0.5 text-right">{summary.byVerdict[k].count}</td>
                    <td className={`py-0.5 text-right ${pnlClass(summary.byVerdict[k].net)}`}>
                      {signed(summary.byVerdict[k].net)}
                    </td>
                  </tr>
                ))}
                <tr className="text-dim">
                  <td className="py-0.5">걸린 것 없음</td>
                  <td className="py-0.5 text-right">{summary.clean.count}</td>
                  <td className={`py-0.5 text-right ${pnlClass(summary.clean.net)}`}>{signed(summary.clean.net)}</td>
                </tr>
                <tr className="text-dim">
                  <td className="py-0.5">보유중 · 미도달</td>
                  <td className="py-0.5 text-right">{summary.pending}</td>
                  <td className="py-0.5 text-right">—</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-2 text-xs">
              {summary.top === null
                ? "규칙에 걸린 거래가 없습니다."
                : `가장 많은 문제: ${VERDICT_LABEL[summary.top]} ${summary.byVerdict[summary.top].count}건`}
              <span className="text-dim"> · 한 거래가 여러 판정에 걸리면 각각 센다 · 보유중은 건수만, 순손익 합에는 넣지 않는다</span>
            </p>
            <p className="mt-1 text-xs text-dim">
              도달 {summary.tpReached}/{summary.total}건 · 평균 도달 시간 {avg(summary.avgToTpMs)} · 도달 전 최대손실 평균 금액{" "}
              {troughAvg}
            </p>
          </>
        )}
      </section>

      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full text-left text-xs">
          <thead className="text-dim">
            <tr className="border-b border-border">
              <th className="px-2 py-1.5 font-normal">진입</th>
              <th className="px-2 py-1.5 font-normal">거래</th>
              <th className="px-2 py-1.5 text-right font-normal">손익</th>
              <th className="px-2 py-1.5 font-normal">TP 도달 · 청산</th>
              <th className="px-2 py-1.5 font-normal">도달 전 최대손실</th>
              <th className="px-2 py-1.5 font-normal">손절선</th>
              <th className="px-2 py-1.5 font-normal">판정</th>
              <th className="px-2 py-1.5 font-normal">
                <span className="sr-only">경로 복기</span>
              </th>
            </tr>
          </thead>
          <tbody className="tnum">
            {rows.map(({ trade, bookName, net, stop, review, error }) => (
              <tr key={trade.id} className="border-t border-border align-top">
                <td className="px-2 py-1.5 whitespace-nowrap">
                  {date(trade.entry_at)}
                  <span className="block text-xs text-dim">{bookName}</span>
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  #{trade.seq} {trade.symbol}{" "}
                  <span className={trade.side === "long" ? "text-profit" : "text-loss"}>{SIDE_LABEL[trade.side]}</span>
                </td>
                <td className={`px-2 py-1.5 text-right whitespace-nowrap ${net === null ? "text-dim" : pnlClass(net)}`}>
                  {net === null ? "보유중" : signed(net)}
                </td>
                {review ? (
                  <>
                    {/* 첫 줄은 도달 경과(또는 미도달), 둘째 줄은 실제 청산과의 관계 — 열 하나를 아끼려 합쳤다. */}
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {review.tp ? (
                        <>
                          {formatDuration(review.tp.elapsedMs)}{" "}
                          <span className={pnlClass(review.tp.pct)}>{signed(review.tp.pct)}%</span>
                          <span className="block text-xs text-dim">{exitVsTp(review, trade)}</span>
                        </>
                      ) : (
                        <span className="text-dim">
                          미도달
                          <span className="block text-xs">
                            {formatDuration(Math.max(0, review.analyzedUntilMs - Date.parse(trade.entry_at)))} 추적 ·{" "}
                            {review.status === "open-unreached" ? "보유중" : "청산됨"}
                          </span>
                        </span>
                      )}
                    </td>
                    <PointCell point={review.trough} />
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {review.stopHit ? (
                        <>
                          {formatDuration(review.stopHit.elapsedMs)} <span className="text-loss">도달</span>
                        </>
                      ) : (
                        <span className="text-dim">{stop === null ? "미기록" : "—"}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {review.status === "open-unreached" ? (
                        <span className="rounded-full border border-border px-1.5 py-0.5 whitespace-nowrap text-dim">대기</span>
                      ) : review.verdicts.length === 0 ? (
                        <span className="text-dim">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {review.verdicts.map((v) => (
                            <span
                              key={v.key}
                              title={v.reason}
                              className="rounded-full border border-beta/50 px-1.5 py-0.5 whitespace-nowrap text-beta"
                            >
                              {v.label}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </>
                ) : (
                  <td colSpan={4} className="px-2 py-1.5 text-dim">
                    {error ?? (trade.entry_price === null ? "진입가 없음" : "진입 구간의 캔들이 없습니다")}
                  </td>
                )}
                <td className="px-2 py-1.5">
                  <ChartDialogButton
                    trade={trade}
                    now={now}
                    mode="path"
                    className="rounded px-1 text-sm text-dim hover:text-accent"
                  >
                    <span aria-hidden>🧭</span>
                    <span className="sr-only">경로 복기</span>
                  </ChartDialogButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="px-1 text-xs text-dim">
        TP 미기록 {excludedNoTp}건은 제외 — 매매 노트의 🧭 경로 복기나 거래 표에서 TP 를 적으면 여기에 들어온다. 실제 청산과 무관하게
        진입부터 지금까지 추적. 봉 단위 근사라 같은 봉 안의 순서는 모른다. 판정은 후보다.
      </p>
    </div>
  );
}

/** 시점 한 칸 — 진입 후 경과와 가격 기준 손익%, 명목가를 알면 금액(USDT) */
function PointCell({ point }: { point: PathPoint | null }) {
  if (!point) return <td className="px-2 py-1.5 text-dim">—</td>;
  return (
    <td className="px-2 py-1.5 whitespace-nowrap">
      {formatDuration(point.elapsedMs)}{" "}
      <span className={pnlClass(point.pct)}>{signed(point.pct)}%</span>
      {point.amount !== null ? <span className="block text-xs text-dim">{signed(point.amount)} USDT</span> : null}
    </td>
  );
}

/**
 * 도달한 거래의 실제 청산이 TP 도달 전인지 뒤인지 한 마디로. 청산이 없으면 "보유중". 청산가 없이 청산
 * 시각만 있는 거래는 `review.exit` 가 비므로 시각은 거래 행에서 읽는다.
 */
function exitVsTp(review: PathReview, trade: Trade): string {
  if (!trade.exit_at) return "보유중";
  if (review.tpVsExit === "after-exit" && review.tp) return `청산 ${formatDuration(review.tp.ms - Date.parse(trade.exit_at))} 뒤 도달`;
  return "도달 후 청산";
}
