import { StatTile } from "@/components/stat-tile";
import type { Book } from "@/lib/domain";
import { EDGE_VERDICT_LABEL } from "@/lib/edge";
import { DASH, dateTime, num, pct, pnlClass, signed } from "@/lib/format";
import {
  BREACH_LABEL,
  breachHistory,
  closedLimitTrades,
  daySums,
  kstDayKey,
  LIMIT_RULES,
  LIMIT_STATE_LABEL,
  limitStatus,
  openRiskOf,
  periodStart,
  STREAK_RULES,
  type LimitState,
} from "@/lib/loss-limits";
import { isOpenTrade } from "@/lib/metrics";
import { getLatestBalance, listBooks, listRBaseHistory, listTrades } from "@/lib/queries";
import { buildREdgeReport } from "@/lib/r-edge-report";
import { tradeR } from "@/lib/r-multiple";

const STATE_TONE: Record<LimitState, string> = {
  ok: "border-profit/40 bg-profit/5 text-profit",
  shrink: "border-beta/40 bg-beta/5 text-beta",
  day_stop: "border-beta/40 bg-beta/5 text-beta",
  period: "border-loss/40 bg-loss/5 text-loss",
  cool: "border-loss/40 bg-loss/5 text-loss",
};

const at = (ms: number | null) => (ms === null ? DASH : dateTime(new Date(ms).toISOString()));
const rText = (v: number | null) => (v === null ? DASH : `${signed(v, 2)}R`);

/** 데이터와 기준 시각 — 시각은 읽는 순간 한 번 잡는다(렌더 안에서 `Date.now()` 금지, react-hooks/purity). */
async function load(book: Book) {
  const [trades, rHistory, balance, books] = await Promise.all([
    listTrades(book.id),
    listRBaseHistory(),
    getLatestBalance(book.id),
    listBooks(),
  ]);
  return { nowMs: Date.now(), trades, rHistory, balance, books };
}

/**
 * 손실 한도 탭 — 일·주·월·분기·연 한도와 연속 손실 멈춤 기준(REQ-0097).
 *
 * 한도·연패는 **활성 북의 거래만** 센다(11-03 사용자 결정). 예전 북은 맨 아래 이력에 참고로만 보인다.
 * 주문을 막지는 않는다 — 주 매매계정으로 나가는 주문 경로가 없다(REQ-0087). 진입 전에 보는 화면이다.
 */
export async function LimitsTab({ book }: { book: Book }) {
  const { nowMs, trades, rHistory, balance, books } = await load(book);
  const rBaseNow = rHistory[0]?.amount ?? null;
  if (rBaseNow === null) {
    return (
      <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
        기준 R 이 없습니다 — 설정에서 기준 R(USDT)을 먼저 정해 주세요. 한도는 R 단위로 정해집니다.
      </p>
    );
  }

  const closed = closedLimitTrades(trades);
  const open = trades.filter(isOpenTrade);
  const openRisks = open.map((t) => {
    const qty = t.entry_price && t.notional ? Math.abs(t.notional) / t.entry_price : null;
    return {
      symbol: t.symbol,
      riskUsd: openRiskOf(t.side, t.entry_price, qty, t.okx_stop_price ?? t.stop_price),
    };
  });
  const cash = balance
    ? {
        atMs: Date.parse(balance.at),
        amount: balance.equity - (balance.unrealized_pnl ?? 0),
      }
    : null;
  const status = limitStatus({
    trades: closed,
    nowMs,
    rBaseNow,
    cash,
    fallbackCapital: book.initial_capital,
    openRisks,
  });
  const { streak } = status;
  const equityNow = cash?.amount ?? book.initial_capital;

  // R 기준 요약은 R 엣지 탭과 같은 함수 — 활성 북 + 예전 북 포함 참고.
  const others = await Promise.all(books.filter((b) => b.id !== book.id).map((b) => listTrades(b.id)));
  const allTrades = [...trades, ...others.flat()];
  const edgeBook = buildREdgeReport(trades.map((t) => ({ trade: t, r: tradeR(t) })));
  const edgeAll = buildREdgeReport(allTrades.map((t) => ({ trade: t, r: tradeR(t) })));
  const needW = (s: typeof edgeAll.stats) =>
    s.winRate !== null && s.winRate > 0 && s.avgLossR !== null ? ((1 - s.winRate) * s.avgLossR) / s.winRate : null;

  // 이력(참고) — 예전 북 포함. 이 숫자는 지금 상태 판정에 쓰지 않는다.
  const allClosed = closedLimitTrades(allTrades);
  const breaches = breachHistory(allClosed, rBaseNow).slice(0, 15);
  const fromMs = periodStart("day", nowMs) - 55 * 86_400_000;
  const sums = new Map(daySums(allClosed, rBaseNow).map((d) => [d.day, d]));
  const bars = Array.from({ length: 56 }, (_, i) => {
    const day = kstDayKey(fromMs + i * 86_400_000);
    return {
      day,
      r: sums.get(day)?.r ?? 0,
      n: sums.get(day)?.n ?? 0,
      inBook: fromMs + i * 86_400_000 >= Date.parse(`${book.start_date}T00:00:00+09:00`),
    };
  });

  const tiers = [
    {
      key: "ok",
      label: "정상",
      when: "연패 0~1",
      todo: "—",
      active: status.state === "ok",
    },
    {
      key: "day",
      label: "당일 정지",
      when: `같은 날 ${STREAK_RULES.dayStopLosses}연패`,
      todo: "그날 신규 진입 금지 — 다음 날 00:00 재개",
      active: streak.dayStopped,
    },
    {
      key: "shrink",
      label: "축소",
      when: `날을 넘겨 누적 ${STREAK_RULES.shrinkLosses}연패`,
      todo: `다음 거래 위험 ${STREAK_RULES.shrinkFactor}R (${num(rBaseNow * STREAK_RULES.shrinkFactor, 2)} USDT), 이익 1건이면 1R 복귀`,
      active: streak.shrink,
    },
    {
      key: "cool",
      label: "냉각",
      when: `손실일 ${STREAK_RULES.coolLossDays}일 연속`,
      todo: `${STREAK_RULES.coolRestDays}일 휴식 — 마지막 손실일 다음 날부터`,
      active: streak.cooling,
    },
  ];

  return (
    <div className="space-y-5">
      {/* 1. 지금 상태 */}
      <section className={`rounded-xl border p-4 ${STATE_TONE[status.state]}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">{LIMIT_STATE_LABEL[status.state]}</h2>
          <span className="text-xs text-dim">
            {book.name} · {at(nowMs)} 기준
          </span>
        </div>
        {status.resumeMs !== null ? <p className="mt-1 text-sm">신규 진입 재개: {at(status.resumeMs)}</p> : null}
        {status.reasons.length > 0 ? (
          <ul className="mt-2 list-disc pl-5 text-sm text-text">
            {status.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
        <p className="mt-2 text-xs leading-relaxed text-text">
          보유 {open.length}건의 열린 위험(지금 손절되면 잃는 금액) {num(status.openRiskUsd, 2)} USDT ={" "}
          {num(status.openRiskUsd / rBaseNow, 2)}R.
          {status.periods.some((p) => p.openRiskExceeds)
            ? ` 손절되면 ${status.periods
                .filter((p) => p.openRiskExceeds)
                .map((p) => p.rule.label)
                .join("·")} 한도를 넘습니다.`
            : ""}
          {status.openWithoutStop.length > 0
            ? ` 손절 없는 포지션: ${status.openWithoutStop.join(", ")} — 위험을 잴 수 없습니다.`
            : ""}
        </p>
      </section>

      {/* 2. R 기준 요약 */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          R 기준 <span className="font-normal text-dim">— 한도의 단위</span>
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="기준 R"
            value={`${num(rBaseNow, 2)} USDT`}
            sub={`자금 ${num(equityNow, 2)} USDT 의 ${pct(rBaseNow / equityNow)} (책 1%)`}
            verdict={
              rBaseNow / equityNow > 0.03
                ? {
                    tone: "warn",
                    text: "자금 3% 초과 — 모든 기간에서 % 상한이 먼저 걸립니다.",
                  }
                : {
                    tone: "good",
                    text: "자금 3% 이하 — R 한도가 먼저 걸립니다.",
                  }
            }
          />
          <StatTile
            label="엣지 · 활성 북"
            value={rText(edgeBook.stats.edge)}
            valueClass={pnlClass(edgeBook.stats.edge)}
            sub={`${edgeBook.stats.n}건 · ${EDGE_VERDICT_LABEL[edgeBook.verdict]}`}
          />
          <StatTile
            label="엣지 · 예전 북 포함 (참고)"
            value={rText(edgeAll.stats.edge)}
            valueClass={pnlClass(edgeAll.stats.edge)}
            sub={
              edgeAll.interval === null
                ? `${edgeAll.stats.n}건`
                : `${edgeAll.stats.n}건 · 95% ${signed(edgeAll.interval[0], 2)} ~ ${signed(edgeAll.interval[1], 2)}`
            }
          />
          <StatTile
            label="승률 · W̄ · L̄ (예전 북 포함)"
            value={pct(edgeAll.stats.winRate)}
            sub={`평균수익 ${rText(edgeAll.stats.avgWinR)} · 평균손실 ${edgeAll.stats.avgLossR === null ? DASH : `${num(edgeAll.stats.avgLossR, 2)}R`} · 본전에 필요한 W̄ ${needW(edgeAll.stats) === null ? DASH : `${num(needW(edgeAll.stats), 2)}R`}`}
          />
        </div>
      </section>

      {/* 3. 기간 한도 */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          기간 손실 한도{" "}
          <span className="font-normal text-dim">— R 한도와 자금 % 상한 중 먼저 닿는 쪽에서 멈춤 · KST 달력</span>
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="text-left text-xs text-dim">
              <tr className="border-b border-border">
                <th className="py-2 pr-3 font-normal">기간</th>
                <th className="py-2 pr-3 font-normal">R 한도</th>
                <th className="py-2 pr-3 font-normal">% 상한 (기준 자금)</th>
                <th className="py-2 pr-3 font-normal">멈춤 금액</th>
                <th className="py-2 pr-3 font-normal">기간 손익</th>
                <th className="py-2 pr-3 font-normal">남은 금액</th>
                <th className="py-2 pr-3 font-normal">상태</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {status.periods.map((p) => {
                const used = Math.max(0, -p.pnlUsd);
                const fill = p.stopUsd > 0 ? Math.min(1, used / p.stopUsd) : 1;
                return (
                  <tr key={p.period} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{p.rule.label}</div>
                      <div className="text-xs text-dim">~ {at(p.end - 60_000)}</div>
                    </td>
                    <td className={`py-2 pr-3 ${p.binding === "r" ? "font-medium" : "text-dim"}`}>
                      −{p.rule.r}R<div className="text-xs">{num(p.limitRUsd, 2)} USDT</div>
                    </td>
                    <td className={`py-2 pr-3 ${p.binding === "pct" ? "font-medium" : "text-dim"}`}>
                      −{pct(p.rule.pct, 0)}
                      <div className="text-xs">
                        {num(p.limitPctUsd, 2)} USDT ({num(p.baseEquity, 2)})
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      {num(p.stopUsd, 2)} USDT
                      <div className="text-xs text-dim">= {num(p.stopUsd / rBaseNow, 2)}R</div>
                    </td>
                    <td className={`py-2 pr-3 ${pnlClass(p.pnlUsd)}`}>
                      {signed(p.pnlUsd)} USDT
                      <div className="text-xs">
                        {rText(p.pnlR)} · {p.trades}건{p.estimated > 0 ? ` (추정 ${p.estimated})` : ""}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      {num(p.remainingUsd, 2)} USDT
                      <div className="mt-1 h-1.5 w-24 overflow-hidden rounded bg-surface-2" aria-hidden>
                        <div
                          className={`h-full ${p.breached ? "bg-loss" : fill >= 0.5 ? "bg-beta" : "bg-profit"}`}
                          style={{ width: `${fill * 100}%` }}
                        />
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      {p.breached ? (
                        <span className="text-loss">도달 — {p.rule.action}</span>
                      ) : p.openRiskExceeds ? (
                        <span className="text-beta">보유 손절 시 초과</span>
                      ) : (
                        <span className="text-dim">여유</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-dim">
          기간 손익 = 그 기간에 청산된 거래의 순손익(수수료·펀딩 포함). R 은 거래별 진입 시점 기준 R 로 나눈 기준R
          손익입니다. 기준 자금 = 최신 잔액(미실현 제외)에서 그 기간 실현 손익을 되돌린 값 — 기간 중 입금은 시작부터
          있던 돈으로 봅니다. % 상한은 「기준 R = 자금 3%」일 때의 R 한도와 같게 맞췄습니다.
        </p>
      </section>

      {/* 4. 연속 손실 */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          연속 손실 <span className="font-normal text-dim">— 패 = 순손익 &lt; 0, 손실일 = 그날 청산 합 &lt; 0</span>
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="지금 연패"
            value={`${streak.lossStreak}연패`}
            valueClass={streak.lossStreak >= STREAK_RULES.dayStopLosses ? "text-loss" : ""}
            sub="본전은 끊지도 잇지도 않음"
          />
          <StatTile
            label="오늘"
            value={streak.dayStopped ? "당일 정지" : "진행 가능"}
            valueClass={streak.dayStopped ? "text-loss" : ""}
            sub={
              streak.dayStopAtMs !== null
                ? `${at(streak.dayStopAtMs)} 에 ${STREAK_RULES.dayStopLosses}연패`
                : `${STREAK_RULES.dayStopLosses}연패면 그날 종료`
            }
          />
          <StatTile
            label="손실일 연속"
            value={`${streak.lossDayStreak}일`}
            valueClass={streak.lossDayStreak >= STREAK_RULES.coolLossDays ? "text-loss" : ""}
            sub={streak.lastLossDay ? `마지막 손실일 ${streak.lastLossDay}` : "손실일 없음"}
          />
          <StatTile
            label="냉각"
            value={streak.cooling ? "휴식 중" : "아님"}
            valueClass={streak.cooling ? "text-loss" : ""}
            sub={
              streak.coolUntilMs !== null
                ? `해제 ${at(streak.coolUntilMs)}`
                : `${STREAK_RULES.coolLossDays}일 연속 손실이면 ${STREAK_RULES.coolRestDays}일 휴식`
            }
          />
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="text-left text-xs text-dim">
              <tr className="border-b border-border">
                <th className="py-2 pr-3 font-normal">구간</th>
                <th className="py-2 pr-3 font-normal">조건</th>
                <th className="py-2 pr-3 font-normal">할 일</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => (
                <tr
                  key={t.key}
                  className={`border-b border-border/60 ${t.active ? "bg-surface-2 font-medium" : "text-dim"}`}
                >
                  <td className="py-2 pr-3">
                    {t.active ? "▶ " : ""}
                    {t.label}
                  </td>
                  <td className="py-2 pr-3">{t.when}</td>
                  <td className="py-2 pr-3">{t.todo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-dim">
          근거: 9/6~11/2 청산 204건에 대입하면 규칙 없음 −90R, 「같은 날 2연패 → 그날 종료」만으로 −27R(단일 규칙 중
          가장 큼), 일·주·월 한도와 함께 −8R. 냉각(3일 연속 → 7일)은 손실은 줄이지만 거래당 R 은 나아지지 않아 쉬어 가는
          규칙으로 둡니다. 대시보드 연승·연패 카드와 정의가 다를 수 있습니다.
        </p>
      </section>

      {/* 5. 이력 — 참고 */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          이력 <span className="font-normal text-dim">— 예전 북 포함 참고, 지금 상태 판정에는 쓰지 않음</span>
        </h2>
        <DailyBars bars={bars} limit={-LIMIT_RULES.day.r} />
        {breaches.length > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="text-left text-xs text-dim">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3 font-normal">기간</th>
                  <th className="py-2 pr-3 font-normal">닿은 기준</th>
                  <th className="py-2 pr-3 font-normal">닿은 시각</th>
                  <th className="py-2 pr-3 font-normal">그 뒤 거래</th>
                  <th className="py-2 pr-3 font-normal">기간 전체</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {breaches.map((b) => (
                  <tr key={`${b.kind}-${b.period}`} className="border-b border-border/60">
                    <td className="py-2 pr-3">{b.period}</td>
                    <td className="py-2 pr-3">{BREACH_LABEL[b.kind]}</td>
                    <td className="py-2 pr-3">{at(b.atMs)}</td>
                    <td className={`py-2 pr-3 ${b.after > 0 ? pnlClass(b.afterR) : "text-dim"}`}>
                      {b.after > 0 ? `${b.after}건 · ${rText(b.afterR)}` : "멈춤"}
                    </td>
                    <td className={`py-2 pr-3 ${pnlClass(b.totalR)}`}>{rText(b.totalR)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="mt-3 text-xs leading-relaxed text-dim">
          이력은 R 한도로만 판정합니다 — % 상한은 그 시점 자금이 필요한데 과거 잔액을 믿을 만하게 되살릴 수 없습니다.
          기준 R 이 없던 과거 거래는 현재 기준 R({num(rBaseNow, 2)} USDT)로 환산했습니다.
        </p>
      </section>
    </div>
  );
}

/** 최근 8주 일별 기준R 손익 막대 — 일 한도선(−2R) 표시. 활성 북 시작 전 날은 흐리게. */
function DailyBars({ bars, limit }: { bars: { day: string; r: number; n: number; inBook: boolean }[]; limit: number }) {
  const W = 560;
  const H = 120;
  const max = Math.max(3, ...bars.map((b) => Math.abs(b.r)));
  const mid = H / 2;
  const scale = (H / 2 - 4) / max;
  const bw = W / bars.length;
  return (
    <figure className="mt-3">
      {/* 폭에 맞춰 가로로 늘린다 — 선 굵기는 non-scaling-stroke 로 지키고, 글자는 그림 밖 범례로 뺀다. */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-32 w-full"
        role="img"
        aria-label="최근 8주 일별 R 손익"
      >
        <line
          x1={0}
          x2={W}
          y1={mid}
          y2={mid}
          className="stroke-border"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={0}
          x2={W}
          y1={mid - limit * scale}
          y2={mid - limit * scale}
          className="stroke-loss"
          strokeWidth={1}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
        />
        {bars.map((b, i) =>
          b.n === 0 ? null : (
            <rect
              key={b.day}
              x={i * bw + 1}
              width={Math.max(1, bw - 2)}
              y={b.r >= 0 ? mid - b.r * scale : mid}
              height={Math.max(1, Math.abs(b.r) * scale)}
              className={b.r >= 0 ? "fill-profit" : "fill-loss"}
              opacity={b.inBook ? 1 : 0.4}
            >
              <title>{`${b.day} · ${b.n}건 · ${b.r >= 0 ? "+" : ""}${b.r.toFixed(2)}R`}</title>
            </rect>
          ),
        )}
      </svg>
      <figcaption className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-dim">
        <span>
          {bars[0]?.day} ~ {bars[bars.length - 1]?.day} · 흐린 막대 = 활성 북 이전
        </span>
        <span className="text-loss">점선 = 일 한도 {limit}R</span>
      </figcaption>
    </figure>
  );
}
