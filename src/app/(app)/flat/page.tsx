import Link from "next/link";

import { Elapsed, WaitGauge } from "@/app/(app)/flat/flat-clock";
import { StartFlatButton } from "@/app/(app)/flat/start-button";
import { SyncAction } from "@/app/(app)/trades/okx-sync-button";
import { EmptyBook } from "@/components/empty-book";
import { formatDuration } from "@/components/measure-tool";
import { StatTile } from "@/components/stat-tile";
import { isCounterTrend, SIDE_LABEL, TREND_LABEL, type Side } from "@/lib/domain";
import { flatState, REENTRY_MIN_SAMPLE, reentryStats, type ReentryBucket, type ReentryStats } from "@/lib/flat";
import { dateTime, DASH, num, pct, pnlClass, signed, signedPct } from "@/lib/format";
import { computeMetrics, deriveTrades, latestExit, type TradeDerived } from "@/lib/metrics";
import { nowMs } from "@/lib/okx";
import { getActiveBook, getLastSync, getLatestFlat, listCashFlows, listTrades } from "@/lib/queries";

/**
 * 무포지션 — 포지션이 없는 것도 내가 선택해서 드는 포지션이다(REQ-0087).
 *
 * 포지션이 없으면 볼 것이 없고, 볼 것이 없으니 포지션을 만든다. 그 고리를 끊으려고 "없음"을
 * 화면에 올린다. 시작은 사람이 누른다 — 매매 버튼을 누르듯 중립 기어를 넣는 버릇을 들이기 위해서다.
 * 끝은 누르지 않는다: OKX 에 새 진입이 잡히면 그 시각에 저절로 끝난다.
 *
 * 주문 화면이 있던 자리다. 들어가려고 여는 화면 대신 안 들어가려고 여는 화면을 둔다.
 */

/** 화면을 열었을 때 마지막 동기화가 이보다 오래됐으면 한 번 받아 온다 — 종결은 동기화가 돌아야 잡힌다. */
const AUTO_SYNC_AFTER_MS = 10 * 60_000;

const sideClass = (side: Side) => (side === "long" ? "text-profit" : "text-loss");

/** 실측 두 묶음의 차이를 한 문장으로 — 규칙과 반대로 나와도 그대로 적는다. */
function readReentry({ quick, waited }: ReentryStats): string {
  if (quick.avgNet === null || waited.avgNet === null || Math.min(quick.count, waited.count) < REENTRY_MIN_SAMPLE) {
    return `표본 부족 — 한쪽이 ${REENTRY_MIN_SAMPLE}건 미만이라 두 묶음의 차이는 읽지 않습니다.`;
  }
  const diff = waited.avgNet - quick.avgNet;
  if (diff > 0) return `이 북에서는 60분을 넘겨 들어간 거래가 건당 ${num(diff, 2)} 더 남겼습니다.`;
  if (diff < 0) {
    return `이 북에서는 60분 안에 다시 들어간 거래가 건당 ${num(-diff, 2)} 더 남겼습니다 — 규칙과 반대입니다. 숫자는 그대로 둡니다.`;
  }
  return "두 묶음의 건당 손익이 같습니다.";
}

function ReentryTile({ label, bucket }: { label: string; bucket: ReentryBucket }) {
  return (
    <StatTile
      label={label}
      value={bucket.count === 0 ? DASH : signed(bucket.net, 2)}
      valueClass={bucket.count === 0 ? "" : pnlClass(bucket.net)}
      sub={`${bucket.count}건 · 승률 ${pct(bucket.winRate)} (${bucket.wins}승 ${bucket.losses}패) · 건당 ${signed(bucket.avgNet, 2)}`}
    />
  );
}

/** 직전 매매 — 일부러 크다. 다음 진입을 생각하기 전에 방금 무슨 일이 있었는지부터 읽는다. */
function PrevTrade({ d, currency }: { d: TradeDerived; currency: string }) {
  const t = d.trade;
  const holdMs = t.exit_at === null ? null : Date.parse(t.exit_at) - Date.parse(t.entry_at);
  const netPct = d.equityBefore > 0 ? d.net / d.equityBefore : null;
  // 진입 때 적어 둔 청산 이후 계획(REQ-0084) — 실제 결과에 맞는 쪽만 꺼낸다.
  const plan =
    d.net < 0
      ? { when: "손절 시", text: t.plan_on_loss }
      : d.net > 0
        ? { when: "수익 시", text: t.plan_on_profit }
        : null;

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-sm font-medium">직전 매매</h2>
        <span className="tnum text-xs text-dim">
          #{t.seq} {t.symbol} · {dateTime(t.entry_at)} 진입 → {dateTime(t.exit_at)} 청산
          {holdMs === null ? "" : ` · ${formatDuration(holdMs)} 보유`}
        </span>
        <Link href={`/notes?trade=${t.id}`} className="ml-auto text-xs text-accent">
          매매 노트에서 보기 →
        </Link>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-x-12 gap-y-4">
        <div>
          <div className="text-xs text-dim">손익 ({currency})</div>
          <div className={`tnum mt-0.5 text-5xl font-semibold leading-none ${pnlClass(d.net)}`}>
            {signed(d.net, 2)}
          </div>
          <div className="mt-1.5 text-xs text-dim">
            진입 직전 잔고 대비 <span className="tnum">{signedPct(netPct)}</span>
          </div>
        </div>
        <div>
          <div className="text-xs text-dim">방향</div>
          <div className={`mt-0.5 text-5xl font-semibold leading-none ${sideClass(t.side)}`}>
            {SIDE_LABEL[t.side]}
          </div>
          <div className="mt-1.5 text-xs text-dim">
            {t.trend
              ? `장기추세 ${TREND_LABEL[t.trend]}${isCounterTrend(t.trend, t.side) ? " · 역추세 진입" : ""}`
              : "장기추세 미기재"}
          </div>
        </div>
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <div className="text-xs text-dim">근거{t.setup ? ` · 기준 ${t.setup}` : ""}</div>
        {t.rationale?.trim() ? (
          <p className="mt-1 whitespace-pre-wrap break-words text-xl leading-relaxed">{t.rationale.trim()}</p>
        ) : (
          <p className="mt-1 text-xl font-medium text-loss">근거 없음 — 적지 않고 들어간 거래입니다</p>
        )}
        {plan?.text?.trim() ? (
          <p className="mt-3 whitespace-pre-wrap break-words text-sm">
            <span className="text-dim">진입 때 적어 둔 계획 ({plan.when}) — </span>
            {plan.text.trim()}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export default async function FlatPage() {
  const book = await getActiveBook();
  if (!book) return <EmptyBook />;

  const linked = Boolean(book.exchange_account_id);
  const [trades, flows, latestFlat, lastSync] = await Promise.all([
    listTrades(book.id),
    listCashFlows(book.id),
    getLatestFlat(book.id),
    linked ? getLastSync(book.id) : null,
  ]);
  const now = nowMs();

  const derived = deriveTrades(book, trades, flows);
  const m = computeMetrics(book, derived, flows);
  const state = flatState(latestFlat, trades);
  const last = latestExit(derived);
  const reentry = reentryStats(derived);
  const reentryCount = reentry.quick.count + reentry.waited.count;
  const syncStale = lastSync === null || now - Date.parse(lastSync.started_at) > AUTO_SYNC_AFTER_MS;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">무포지션</h1>
          <p className="mt-1 text-sm text-dim">
            {book.name} · 포지션이 없는 것도 포지션입니다 — 시작은 내가 누르고, 끝은 OKX 진입이 정합니다
            {linked ? <> · 마지막 동기화 {lastSync ? dateTime(lastSync.started_at) : "없음"}</> : null}
          </p>
        </div>
        <div className="ml-auto">
          <SyncAction linked={linked} auto={syncStale} />
        </div>
      </header>

      {state.kind === "holding" ? (
        <section className="rounded-xl border border-border bg-surface p-5">
          <div className="text-xs text-dim">지금 포지션</div>
          <div className="mt-0.5 text-3xl font-semibold leading-none">포지션 보유 중</div>
          <ul className="mt-4 divide-y divide-border border-y border-border">
            {state.open.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/notes?trade=${t.id}`}
                  className="tnum flex flex-wrap items-baseline gap-x-3 py-2 text-sm hover:bg-surface-2/60"
                >
                  <span className={`text-lg font-semibold ${sideClass(t.side)}`}>{SIDE_LABEL[t.side]}</span>
                  <span className="font-medium">{t.symbol}</span>
                  <span className="text-xs text-dim">#{t.seq}</span>
                  <span className="text-xs text-dim">{dateTime(t.entry_at)} 진입</span>
                  <span className="ml-auto">
                    <Elapsed since={Date.parse(t.entry_at)} now={now} /> 보유
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-dim">무포지션은 이 포지션이 청산된 뒤에 시작할 수 있습니다.</p>
          {state.endedFlat ? (
            <p className="tnum mt-1 text-sm">
              직전 무포지션 {formatDuration(state.endedFlat.endMs - state.endedFlat.startMs)} 유지 → #
              {state.endedFlat.endedBy.seq} 진입으로 종결
              <span className="text-dim">
                {" "}
                ({dateTime(new Date(state.endedFlat.startMs).toISOString())} 시작)
              </span>
            </p>
          ) : null}
        </section>
      ) : null}

      {state.kind === "idle" ? (
        <section className="rounded-xl border border-dashed border-border p-8 text-center">
          <div className="text-xs text-dim">지금 포지션</div>
          <div className="mt-1 text-2xl font-semibold">없음 — 아직 무포지션을 들지 않았습니다</div>
          {last ? (
            <p className="tnum mt-2 text-sm text-dim">
              직전 청산 #{last.closed.trade.seq} {last.closed.trade.symbol}{" "}
              {SIDE_LABEL[last.closed.trade.side]}{" "}
              <span className={pnlClass(last.closed.net)}>{signed(last.closed.net, 2)}</span> ·{" "}
              <Elapsed since={last.exitMs} now={now} /> 전
            </p>
          ) : null}
          <div className="mt-5">
            <StartFlatButton />
          </div>
          <p className="mt-4 text-xs text-dim">
            누른 시각부터 유지 시간이 쌓입니다. OKX 에 새 진입이 잡히면 저절로 끝납니다 — 끝내는 버튼은 없습니다.
          </p>
        </section>
      ) : null}

      {state.kind === "flat" ? (
        <>
          {/* ── 지금 들고 있는 것 — 포지션 카드와 같은 모양으로 ── */}
          <section className="rounded-xl border border-accent/40 bg-surface p-5">
            <div className="flex flex-wrap items-end gap-x-12 gap-y-4">
              <div>
                <div className="text-xs text-dim">지금 포지션</div>
                <div className="mt-0.5 text-4xl font-semibold leading-none text-accent">무포지션</div>
              </div>
              <div>
                <div className="text-xs text-dim">유지 시간</div>
                <div className="tnum mt-0.5 text-4xl font-semibold leading-none">
                  <Elapsed since={state.startMs} now={now} />
                </div>
              </div>
              <div className="text-xs leading-relaxed text-dim">
                {dateTime(new Date(state.startMs).toISOString())} 시작 · 방향 중립 · 증거금 0
                <br />
                미실현 손익 0.00 — 시세가 어디로 가도 그대로입니다
              </div>
            </div>
            <p className="mt-4 border-t border-border pt-3 text-xs text-dim">
              OKX 에 새 진입이 잡히면 이 무포지션은 그 진입 시각에 저절로 끝납니다. 끝내는 버튼은 없습니다.
            </p>
          </section>

          {last ? <PrevTrade d={last.closed} currency={book.base_currency} /> : null}

          {/* ── 기다림 — 규칙이 말하는 것 ── */}
          {last ? (
            <section className="rounded-xl border border-border bg-surface p-4">
              <h2 className="text-sm font-medium">
                기다림 — 규칙{" "}
                <span className="font-normal text-dim">
                  — 청산 후 60분, 손실이 컸으면 더 (docs/repeatable §2.2)
                </span>
              </h2>
              <div className="mt-3">
                <WaitGauge exitMs={last.exitMs} prev={last.prev} now={now} />
              </div>
            </section>
          ) : null}

          {/* ── 기다림 — 내 거래가 말하는 것 ── */}
          <section className="rounded-xl border border-border bg-surface p-4">
            <h2 className="text-sm font-medium">
              기다림 — 내 실측{" "}
              <span className="font-normal text-dim">
                — 이 북의 청산 거래를 직전 청산 후 60분으로 가른 성과 ({book.base_currency})
              </span>
            </h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <ReentryTile label="청산 60분 안에 다시 들어간 거래" bucket={reentry.quick} />
              <ReentryTile label="60분을 넘겨 들어간 거래" bucket={reentry.waited} />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-dim">
              {reentryCount > 0 ? (
                <>
                  재진입 {reentryCount}건 중 {reentry.quick.count}건(
                  {pct(reentry.quick.count / reentryCount, 0)})이 60분 안이었습니다.{" "}
                </>
              ) : null}
              {readReentry(reentry)}
            </p>
          </section>

          {/* ── 매매 실패 — 지금까지 잃은 것 ── */}
          <section className="rounded-xl border border-border bg-surface p-4">
            <h2 className="text-sm font-medium">
              매매 실패{" "}
              <span className="font-normal text-dim">
                — 이 북에서 손실로 끝난 거래, 비용 반영 ({book.base_currency})
              </span>
            </h2>
            <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile
                label="손실 거래"
                value={`${m.losses}건`}
                valueClass={m.losses > 0 ? "text-loss" : ""}
                sub={`청산 ${m.closedCount}건 중 · 승률 ${pct(m.winRate)}`}
              />
              <StatTile
                label="손실 합계"
                value={signed(m.grossLoss, 2)}
                valueClass={pnlClass(m.grossLoss)}
                sub={`평균 손실 ${num(m.avgLoss, 2)} · 누적 손익 ${signed(m.netPnl, 2)}`}
              />
              <StatTile
                label="최대 손실"
                value={signed(m.maxLoss, 2)}
                valueClass={pnlClass(m.maxLoss)}
                sub="한 거래에서 가장 크게 잃은 금액"
              />
              <StatTile
                label="지금 연속"
                value={
                  m.currentStreak === 0
                    ? DASH
                    : m.currentStreak > 0
                      ? `${m.currentStreak}연승`
                      : `${-m.currentStreak}연패`
                }
                valueClass={m.currentStreak > 0 ? "text-profit" : m.currentStreak < 0 ? "text-loss" : ""}
                sub={`최다 ${m.maxLossStreak}연패`}
              />
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
