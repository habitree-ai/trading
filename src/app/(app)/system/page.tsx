import Link from "next/link";

import { ModeTabs } from "@/app/(app)/system/mode-tabs";
import { MEMBER_LABEL, resolveModes } from "@/app/(app)/system/shared";
import { SystemEquityCurve, type SystemEquityPoint } from "@/components/charts";
import { StatTile } from "@/components/stat-tile";
import { DASH, dateTime, num, pct, pnlClass, signed, signedPct } from "@/lib/format";
import { nowMs } from "@/lib/okx";
import { listBooks } from "@/lib/queries";
import {
  SYSTEM_BOOK_NAMES,
  SYSTEM_MODE_META,
  readSystemEquity,
  readSystemState,
  readSystemTradesAll,
  readSystemDecisions,
  summarizeSystem,
  systemDrawdown,
} from "@/lib/system-trading";
import { readSample, readWinRate, readPayoff } from "@/lib/verdict";

/**
 * 시스템 운용 현황 — 봇이 남긴 정본(`system_*`)을 그대로 읽는다.
 *
 * 수동 일지의 북을 거치지 않는다. 예전에는 봇 기록을 북으로 "가져와야" 성적이 보였고,
 * 가져오기를 안 한 동안은 실제로 손실이 나고 있어도 화면이 0건이었다. 여기서는
 * 봇이 쓴 그 표가 곧 화면이다 — 사람이 눌러야 보이는 단계가 없다.
 */

/** 봇이 사이클을 놓쳤는지 — 4H 기준 두 사이클(9시간)이 지나면 의심 구간이다. */
const STALE_MS = 9 * 3600_000;

export default async function SystemPage({
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
          <h1 className="text-xl font-semibold tracking-tight">시스템 운용 현황</h1>
        </header>
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          봇이 아직 한 사이클도 돌지 않았습니다. 첫 사이클이 끝나면 잔고·포지션·판정이 여기에
          나타납니다.
          <br />
          <Link href="/system/criteria" className="mt-2 inline-block text-alpha">
            매매 기준 먼저 보기 →
          </Link>
        </p>
      </div>
    );
  }

  const mode = selection.current;
  const meta = SYSTEM_MODE_META[mode];

  const [state, trades, equity, decisions, books] = await Promise.all([
    readSystemState(mode),
    readSystemTradesAll(mode),
    readSystemEquity(mode),
    readSystemDecisions(mode, 40),
    listBooks(),
  ]);

  const summary = summarizeSystem(trades);
  const dd = systemDrawdown(equity);
  const openTrades = trades.filter((t) => t.open);

  // 곡선의 기준선은 관측 첫 스냅샷 — 봇의 "시작 잔고"다.
  const first = equity.find((p) => p.equity !== null)?.equity ?? null;
  const latest = [...equity].reverse().find((p) => p.equity !== null)?.equity ?? state?.equity ?? null;
  const curve: SystemEquityPoint[] = equity
    .filter((p): p is typeof p & { equity: number } => p.equity !== null)
    .map((p) => ({
      t: p.at,
      label: dateTime(new Date(p.at).toISOString()),
      equity: p.equity,
      open: p.openMembers.map((m) => MEMBER_LABEL[m] ?? m).join(", "),
    }));

  const lastEval = state ? Math.max(0, ...Object.values(state.lastBarTs)) || null : null;
  const stale = state ? nowMs() - state.updatedAt > STALE_MS : false;
  const warnings = decisions.filter((d) => d.warn);

  // 북 사본과의 관계 — 이 화면은 정본을 읽지만, 북이 남아 있으면 어긋남이 눈에 보여야 한다.
  const bookName = mode in SYSTEM_BOOK_NAMES ? SYSTEM_BOOK_NAMES[mode as keyof typeof SYSTEM_BOOK_NAMES] : null;
  const book = bookName ? (books.find((b) => b.name === bookName) ?? null) : null;

  const returnPct =
    first !== null && latest !== null && first > 0 ? (latest - first) / first : null;

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">시스템 운용 현황</h1>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
              meta.real ? "border-loss text-loss" : "border-alpha text-alpha"
            }`}
          >
            {meta.real ? "실계좌" : "가상"}
          </span>
          <p className="text-sm text-dim">{meta.desc}</p>
        </div>
        <ModeTabs items={selection.items} current={mode} />
      </header>

      {/* ── 지금 상태 ─────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            <div className="text-[11px] text-dim">현재 잔고 (USDT)</div>
            <div className="tnum mt-0.5 text-3xl font-semibold">{num(latest, 2)}</div>
          </div>
          <div>
            <div className="text-[11px] text-dim">관측 시작 대비</div>
            <div className={`tnum mt-0.5 text-2xl font-semibold ${pnlClass(returnPct)}`}>
              {returnPct === null ? DASH : signedPct(returnPct)}
            </div>
          </div>
          <div className="tnum text-[11px] leading-relaxed text-dim">
            시작 {num(first, 2)} · 완결 {summary.closed}건 · 진행 {openTrades.length}건
            <br />
            마지막 사이클{" "}
            {state ? (
              <span className={stale ? "text-beta" : ""}>
                {dateTime(new Date(state.updatedAt).toISOString())}
                {stale ? " (지연 의심)" : ""}
              </span>
            ) : (
              DASH
            )}
            {lastEval ? ` · 마지막 평가봉 ${dateTime(new Date(lastEval).toISOString())}` : ""}
          </div>
          {meta.real ? (
            <div className="ml-auto text-right">
              <div className="text-[11px] text-dim">킬스위치</div>
              <div
                className={`mt-0.5 text-sm font-semibold ${state?.liveEnabled ? "text-profit" : "text-dim"}`}
              >
                {state?.liveEnabled ? "실주문 허용" : "실주문 차단"}
              </div>
            </div>
          ) : null}
        </div>

        {stale ? (
          <p className="mt-3 rounded-lg border border-beta/40 bg-surface-2 p-3 text-[12px] text-beta">
            마지막 사이클이 9시간(4H 두 사이클)을 넘겼습니다 — 봇이 멈췄거나 스케줄러가 죽었을 수
            있습니다. 열린 포지션의 손절·목표는 거래소 브래킷이 계속 지키지만, 시한 청산과 새 진입은
            멈춰 있습니다.
          </p>
        ) : null}

        {warnings.length > 0 ? (
          <div className="mt-3 rounded-lg border border-loss/40 bg-surface-2 p-3">
            <div className="text-[12px] font-medium text-loss">
              사람 손이 필요한 경고 {warnings.length}건
            </div>
            <ul className="mt-1 space-y-0.5">
              {warnings.slice(0, 3).map((w, i) => (
                <li key={i} className="text-[11.5px] text-dim">
                  {dateTime(new Date(w.at).toISOString())} · {w.warn}
                </li>
              ))}
            </ul>
            <Link href={`/system/decisions?mode=${mode}`} className="mt-1 inline-block text-[11px] text-alpha">
              판정 로그에서 전부 보기 →
            </Link>
          </div>
        ) : null}
      </section>

      {/* ── 열린 포지션 ───────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium">
          열린 포지션{" "}
          <span className="font-normal text-dim">— 손절·목표는 거래소 브래킷이 지킨다</span>
        </h2>
        {openTrades.length === 0 && Object.keys(state?.positions ?? {}).length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-dim">
            열린 포지션이 없습니다.
          </p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {openTrades.map((t) => {
              const pos = state?.positions?.[t.member];
              const risk = t.riskPct ?? pos?.riskPct ?? null;
              return (
                <div key={t.tradeId} className="rounded-xl border border-alpha/40 bg-surface p-4">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-sm font-medium">{t.name || MEMBER_LABEL[t.member] || t.member}</h3>
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                        t.side === "long" ? "border-profit text-profit" : "border-loss text-loss"
                      }`}
                    >
                      {t.side === "long" ? "롱" : "숏"}
                    </span>
                    <span className="tnum ml-auto text-[11px] text-dim">
                      {dateTime(new Date(t.entryTs).toISOString())} 진입
                    </span>
                  </div>
                  <div className="tnum mt-2 grid grid-cols-3 gap-2 text-[12px]">
                    <div>
                      <div className="text-[10px] text-dim">진입가</div>
                      {num(t.entryPrice, 1)}
                    </div>
                    <div>
                      <div className="text-[10px] text-dim">손절</div>
                      <span className="text-loss">{num(t.stop ?? pos?.stop ?? null, 1)}</span>
                    </div>
                    <div>
                      <div className="text-[10px] text-dim">목표</div>
                      <span className="text-profit">{num(t.target ?? pos?.target ?? null, 1)}</span>
                    </div>
                  </div>
                  <p className="tnum mt-2 border-t border-border pt-2 text-[11px] text-dim">
                    레버리지 {num(t.lev, 1)}× · 리스크 {risk === null ? DASH : `${num(risk, 0)}%`}
                    {t.notionalUsd ? ` · 명목가 $${num(t.notionalUsd, 0)}` : ""}
                    {t.eqAtEntry ? ` · 진입 시 잔고 $${num(t.eqAtEntry, 2)}` : ""}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 성적 ─────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">
          성적 <span className="font-normal text-dim">— 완결 {summary.closed}건 기준, 진행 중인 포지션은 빠진다</span>
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="누적 손익 (USDT)"
            value={signed(summary.netPnlUsd, 2)}
            valueClass={pnlClass(summary.netPnlUsd)}
            sub={`수익 ${num(summary.grossProfit, 2)} · 손실 ${num(summary.grossLoss, 2)}`}
            verdict={readSample(summary.closed)}
          />
          <StatTile
            label="승률"
            value={summary.winRate === null ? DASH : pct(summary.winRate)}
            sub={`${summary.wins}승 ${summary.losses}패`}
            verdict={readWinRate(summary.winRate, summary.payoff)}
          />
          <StatTile
            label="손익비"
            value={summary.payoff === null ? DASH : num(summary.payoff, 2)}
            sub="평균수익 ÷ 평균손실"
            verdict={readPayoff(summary.payoff)}
          />
          <StatTile
            label="건당 기대"
            value={summary.expectancyPct === null ? DASH : `${signed(summary.expectancyPct, 2)}%`}
            valueClass={pnlClass(summary.expectancyPct)}
            sub={
              summary.expectancyUsd === null
                ? "계좌 기준 손익률 평균"
                : `${signed(summary.expectancyUsd, 2)} USDT/건`
            }
          />
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="최대 낙폭"
            value={dd.maxDrawdownPct === 0 ? DASH : pct(dd.maxDrawdownPct)}
            valueClass={dd.maxDrawdownPct < 0 ? "text-loss" : ""}
            sub={
              dd.peak === null
                ? "잔고 스냅샷 기준"
                : `고점 ${num(dd.peak, 2)} → 저점 ${num(dd.trough, 2)}`
            }
          />
          <StatTile
            label="연속"
            value={
              summary.currentStreak === 0
                ? DASH
                : summary.currentStreak > 0
                  ? `${summary.currentStreak}연승`
                  : `${-summary.currentStreak}연패`
            }
            valueClass={
              summary.currentStreak > 0 ? "text-profit" : summary.currentStreak < 0 ? "text-loss" : ""
            }
            sub={`최다 ${summary.maxLossStreak}연패`}
          />
          <StatTile
            label="마지막 청산"
            value={
              summary.lastExitAt === null
                ? DASH
                : dateTime(new Date(summary.lastExitAt).toISOString()).slice(5)
            }
            sub={summary.closed > 0 ? `완결 ${summary.closed}건` : "아직 없음"}
          />
          <StatTile
            label="사이클 기록"
            value={`${equity.length}회`}
            sub={`판정 로그 ${decisions.length}줄 (최근분)`}
          />
        </div>
      </section>

      {/* ── 자금 곡선 ─────────────────────────────── */}
      {curve.length > 1 ? (
        <section className="rounded-xl border border-border bg-surface p-4">
          <h2 className="text-sm font-medium">
            잔고 곡선{" "}
            <span className="font-normal text-dim">
              — 사이클마다 남긴 실측 잔고. 거래가 없는 사이클에도 점이 찍힌다
            </span>
          </h2>
          <div className="mt-3">
            <SystemEquityCurve data={curve} start={first ?? curve[0].equity} />
          </div>
        </section>
      ) : null}

      {/* ── 데이터 위치 안내 ───────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">이 화면의 데이터</h2>
        <p className="mt-2 text-[12px] text-dim">
          시스템 매매 기록은 <code className="rounded bg-surface-2 px-1">system_state</code>·
          <code className="rounded bg-surface-2 px-1">system_trades</code>·
          <code className="rounded bg-surface-2 px-1">system_equity</code>·
          <code className="rounded bg-surface-2 px-1">system_decisions</code> 에만 있습니다. 수동매매
          일지(북)와 표가 다르고 계산도 따로 돕니다 — 한쪽을 지워도 다른 쪽은 그대로입니다.
        </p>
        {book ? (
          <p className="mt-2 rounded-lg border border-beta/40 bg-surface-2 p-3 text-[12px] text-dim">
            <b className="text-text">북 사본 “{book.name}” 이 남아 있습니다.</b> 예전 방식(봇 →
            북으로 가져오기)의 잔재이고, 이 화면의 숫자와 무관합니다. 초기자본이{" "}
            <span className="tnum">{num(book.initial_capital, 2)}</span> 로 잡혀 있어 그 북의 수익률은
            실제와 어긋납니다 — 수동매매 영역의{" "}
            <Link href="/books" className="text-accent">
              북 관리
            </Link>
            에서 정리하거나 그대로 두어도 시스템 성적에는 영향이 없습니다.
          </p>
        ) : null}
      </section>
    </div>
  );
}
