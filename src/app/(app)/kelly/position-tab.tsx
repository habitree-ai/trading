import { loadAddContext, type AddContext } from "@/app/(app)/kelly/add-context";
import { AddPreviewPanel } from "@/app/(app)/kelly/add-preview";
import { EntryCalcPanel, type EntryCalcProps } from "@/app/(app)/kelly/entry-calc";
import { SyncAction } from "@/app/(app)/trades/okx-sync-button";
import { StatTile } from "@/components/stat-tile";
import { SIDE_LABEL, type Book, type Trade } from "@/lib/domain";
import { DASH, dateTime, num, pnlClass, price, signed } from "@/lib/format";
import { closedLimitTrades, STREAK_RULES, streakStatus } from "@/lib/loss-limits";
import { isOpenTrade } from "@/lib/metrics";
import { firstEntry } from "@/lib/mer-report";
import { stageChange, stopOutcome } from "@/lib/position-flow-text";
import { lastPrice } from "@/lib/okx-live";
import { buildFlow, STAGE_LABEL, type Flow, type Stage } from "@/lib/position-r";
import {
  getLastSync,
  getLatestBalance,
  listFills,
  listPositionSnapshots,
  listRBaseHistory,
  listTrades,
} from "@/lib/queries";

const rText = (v: number | null) => (v === null ? DASH : `${signed(v, 2)}R`);
const plain = (v: number | null) => (v === null ? DASH : num(v, 2));
const at = (ms: number) => dateTime(new Date(ms).toISOString());

/**
 * 직전 동기화가 이보다 오래면 화면을 열 때 동기화를 한 번 돌린다(REQ-0099). 손절 이동은 동기화 때만 기록되므로
 * 화면을 여는 순간 OKX 를 읽어야 옮긴 손절이 단계와 「현재」 열에 나온다. 1분은 다시 그려질 때 되풀이를 막는 여유다.
 */
const AUTO_SYNC_AFTER_MS = 60_000;

interface PositionView {
  trade: Trade;
  rBase: number;
  estimatedR: boolean;
  livePrice: number | null;
  flow: Flow;
  /** 첫 진입 체결가 — 공통 손절의 기준(REQ-0102). 모르면 null */
  entry0: number | null;
  /** 진입 때 수수료율, 없으면 지금 설정값 */
  feeRate: number | null;
}

/** 보유 포지션마다 체결·스냅샷·현재가를 읽어 흐름을 만든다. 시각은 읽는 순간 한 번(렌더 안 `Date.now()` 금지). */
async function load(book: Book): Promise<{
  views: PositionView[];
  nowMs: number;
  calc: EntryCalcProps | null;
  lastSyncMs: number | null;
  addCtx: AddContext | null;
}> {
  const linked = Boolean(book.exchange_account_id);
  const [trades, rHistory, balance, lastSync] = await Promise.all([
    listTrades(book.id),
    listRBaseHistory(),
    getLatestBalance(book.id),
    linked ? getLastSync(book.id) : null,
  ]);
  const rNow = rHistory[0]?.amount ?? null;
  const open = trades.filter(isOpenTrade);
  const nowMs = Date.now();
  // 진입 계산기 — 연속 손실 단계는 손실 한도 탭과 같은 판정(활성 북 청산 거래, REQ-0097).
  let calc: EntryCalcProps | null = null;
  if (rNow !== null) {
    const streak = streakStatus(closedLimitTrades(trades), nowMs, rNow);
    calc = {
      rBase: rNow,
      feeRate: rHistory[0]?.fee_rate ?? 0,
      equity: balance?.equity ?? null,
      riskFactor: streak.shrink ? STREAK_RULES.shrinkFactor : 1,
      streakNote: streak.cooling
        ? `휴식 중 — 손실일 ${streak.lossDayStreak}일 연속`
        : streak.dayStopped
          ? `오늘 ${STREAK_RULES.dayStopLosses}연패 — 그날 종료`
          : streak.shrink
            ? `축소 단계 — ${streak.lossStreak}연패, 다음 거래 ${STREAK_RULES.shrinkFactor}R`
            : null,
    };
  }
  const views = await Promise.all(
    open.map(async (trade): Promise<PositionView | null> => {
      const rBase = trade.r_base_at_entry ?? rNow;
      if (rBase === null) return null;
      const [fills, snaps, live] = await Promise.all([
        listFills(trade.id),
        listPositionSnapshots(trade.id),
        // 공개 시세 — 실패하면 「현재」 열의 미실현만 비운다.
        lastPrice(`${trade.symbol}-USDT-SWAP`).catch(() => null),
      ]);
      const qtyNow = trade.entry_price && trade.notional ? Math.abs(trade.notional) / trade.entry_price : 0;
      const flow = buildFlow({
        side: trade.side,
        rBase,
        stop0: trade.stop_px_0,
        fills: fills
          .filter((f) => f.price > 0 && f.amount !== null && f.amount > 0)
          .map((f) => ({
            atMs: Date.parse(f.filled_at),
            role: f.role,
            price: f.price,
            qty: (f.amount as number) / f.price,
          })),
        snapshots: snaps.map((s) => ({
          atMs: Date.parse(s.at),
          qty: s.qty,
          avgPx: s.avg_px,
          markPx: s.mark_px,
          stopPx: s.stop_px,
        })),
        now:
          trade.entry_price !== null && qtyNow > 0
            ? {
                atMs: nowMs,
                price: live,
                qty: qtyNow,
                avgPx: trade.entry_price,
                stopPx: trade.okx_stop_price ?? trade.stop_price,
              }
            : null,
      });
      return {
        trade,
        rBase,
        estimatedR: trade.r_base_at_entry === null,
        livePrice: live,
        flow,
        entry0: firstEntry(trade, fills)?.px ?? null,
        feeRate: trade.fee_rate_at_entry ?? rHistory[0]?.fee_rate ?? null,
      };
    }),
  );
  const kept = views.filter((v): v is PositionView => v !== null);
  // 추가 진입 체크리스트 재료 — 보유가 있을 때만 읽는다(임계점 수집은 외부 API 여러 번).
  const addCtx =
    kept.length > 0 ? await loadAddContext(book, trades, kept.map((v) => v.trade.symbol), nowMs) : null;
  return {
    views: kept,
    nowMs,
    calc,
    lastSyncMs: lastSync ? Date.parse(lastSync.started_at) : null,
    addCtx,
  };
}

/**
 * 포지션 흐름 탭 — 책 표 3-6 처럼 보유 포지션의 단계마다 R·E·CR·미실현·누적 확정이 어떻게 바뀌는지(REQ-0090).
 *
 * 단계는 체결(진입·추가·청산, 정확한 시각)과 동기화 스냅샷(손절 이동, 동기화 시각)에서 나온다.
 * 「현재」 열만 화면을 여는 순간의 공개 시세로 다시 계산한다.
 */
export async function PositionTab({ book }: { book: Book }) {
  const { views, nowMs, calc, lastSyncMs, addCtx } = await load(book);
  const linked = Boolean(book.exchange_account_id);
  const syncStale = lastSyncMs === null || nowMs - lastSyncMs > AUTO_SYNC_AFTER_MS;
  // 화면을 열 때 OKX 를 읽는다 — 옮긴 손절이 「손절 이동」 단계와 「현재」 열에 들어오게(REQ-0099).
  const syncBar = (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-dim">
      <span>
        {linked
          ? `마지막 동기화 ${lastSyncMs === null ? "없음" : at(lastSyncMs)} — 화면을 열면 OKX 손절·수량을 다시 읽습니다`
          : "거래소 계정이 연결되지 않은 북 — 손절 변경을 받아 올 수 없습니다"}
      </span>
      <SyncAction linked={linked} auto={syncStale} />
    </div>
  );
  const calcPanel = calc ? <EntryCalcPanel {...calc} /> : null;

  if (views.length === 0) {
    return (
      <div className="space-y-5">
        {syncBar}
        {calcPanel}
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          보유 중인 포지션이 없습니다. 진입한 뒤 동기화하면 이곳에 단계별 흐름이 쌓입니다.
        </p>
      </div>
    );
  }

  // 맨 위 합계 — 여러 포지션은 합계를 한 포지션처럼 본다(명세). 「현재」 열 기준.
  const nowStages = views.map((v) => v.flow.stages[v.flow.stages.length - 1]);
  const sum = (pick: (s: Stage) => number | null) => {
    const xs = nowStages.map(pick);
    return xs.some((x) => x === null) ? null : xs.reduce<number>((a, x) => a + (x as number), 0);
  };

  return (
    <div className="space-y-5">
      {syncBar}
      {calcPanel}
      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">
            보유 전체 <span className="font-normal text-dim">— {views.length}개 포지션의 합, 지금 기준</span>
          </h2>
          <span className="text-xs text-dim">
            {book.name} · {at(nowMs)}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="CR · 지금 남은 위험"
            value={rText(sum((s) => s.cr))}
            valueClass={(sum((s) => s.cr) ?? 0) > 1 ? "text-loss" : ""}
            sub={`잠긴 R ${rText(sum((s) => s.lockedR))}`}
            verdict={
              (sum((s) => s.cr) ?? 0) > 1
                ? { tone: "bad", text: "1R 초과 — 지금 손절되면 처음 정한 위험보다 더 잃습니다." }
                : undefined
            }
          />
          <StatTile label="E · 포지션 크기" value={plain(sum((s) => s.e))} sub="1E = 기준 R 위험으로 진입한 수량" />
          <StatTile
            label="미실현"
            value={rText(sum((s) => s.unrealizedR))}
            valueClass={pnlClass(sum((s) => s.unrealizedR))}
            sub="현재가 기준, 가격만"
          />
          <StatTile
            label="누적 확정"
            value={rText(sum((s) => s.realizedR))}
            valueClass={pnlClass(sum((s) => s.realizedR))}
            sub="부분 청산 가격손익, 수수료 전"
          />
        </div>
      </section>

      {views.map((v) => (
        <PositionFlow key={v.trade.id} view={v} addCtx={addCtx} />
      ))}

      <p className="text-xs leading-relaxed text-dim">
        R = 처음 감수한 위험(진입 때 고정) · CR = 지금 손절에 걸리면 잃는 R(0 아래는 잠긴 R) · E = 현재 수량 ÷ 1E 수량 ·
        미실현·누적 확정은 가격만(책 정의) — 수수료·펀딩은 거래 행의 실현손익에 있습니다. 손절 이동은 동기화 때
        기록됩니다(이 화면을 열 때 · 하루 1회 · 수동). 단계 시각은 옮긴 시각이 아니라 동기화 시각이고, 그 사이에 옮겼다
        되돌린 손절은 보이지 않습니다. 손절을 수량별로 나눠 걸었으면 손절 칸은 수량 가중 평균입니다 — CR 은 손절별로
        더한 값과 같습니다.
      </p>
    </div>
  );
}

/** 단계 한 열의 폭(px) — 가격 그림이 표의 열과 같은 눈금이어야 옆으로 읽힌다. */
const COL = 112;
/** 행 이름 열의 폭(px) */
const LABEL_COL = 152;
const EPS = 1e-9;

const crClass = (s: Stage) =>
  s.riskUp ? "font-semibold text-loss" : s.cr !== null && s.cr <= EPS ? "text-profit" : "";

const OUTCOME_CLASS = {
  bad: "bg-loss/15 text-loss",
  good: "bg-profit/15 text-profit",
  flat: "bg-surface text-dim",
} as const;

function PositionFlow({ view, addCtx }: { view: PositionView; addCtx: AddContext | null }) {
  const { trade, rBase, flow, livePrice } = view;
  const { stages } = flow;
  const last = stages[stages.length - 1];
  const outcome = stopOutcome(last);

  // 행 이름 아래 한 줄 설명 — 맨 아래 긴 문단까지 내려가지 않아도 뜻이 읽히게(REQ-0109).
  const rows: { label: string; help: string; cell: (s: Stage) => React.ReactNode; strong?: boolean }[] = [
    { label: "R", help: "진입 때 정한 위험 · 고정", cell: (s) => plain(s.r) },
    { label: "E", help: "포지션 크기 (1E 배수)", cell: (s) => plain(s.e), strong: true },
    {
      label: "CR",
      help: "지금 손절되면 잃는 R",
      cell: (s) => <span className={crClass(s)}>{plain(s.cr)}</span>,
      strong: true,
    },
    {
      label: "잠긴 R",
      help: "손절돼도 남는 이익",
      cell: (s) => <span className={(s.lockedR ?? 0) > EPS ? "text-profit" : ""}>{plain(s.lockedR)}</span>,
    },
    {
      label: "미실현",
      help: "그 시점 가격 기준 평가",
      cell: (s) => <span className={pnlClass(s.unrealizedR)}>{rText(s.unrealizedR)}</span>,
      strong: true,
    },
    {
      label: "누적 확정",
      help: "부분 청산으로 확정된 몫",
      cell: (s) => <span className={pnlClass(s.realizedR)}>{rText(s.realizedR)}</span>,
      strong: true,
    },
  ];

  const nowCell = (s: Stage) => (s.kind === "now" ? "bg-surface-2" : "");
  const chips = [
    { k: "1R", v: `${num(rBase, 2)} USDT${view.estimatedR ? " (추정)" : ""}`, tip: "1R = 한 번에 감수하기로 정한 손실 금액" },
    {
      k: "1E",
      v: flow.oneE === null ? "최초 손절 없음" : `${num(flow.oneE, 2)}개`,
      tip: "1E = 최초 손절까지 1R 만 잃는 수량",
    },
    { k: "최대 CR", v: plain(flow.maxCr), tip: "보유 중 가장 컸던 남은 위험" },
    { k: "최대 E", v: plain(flow.maxE), tip: "보유 중 가장 컸던 포지션 크기" },
  ];

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <span>
            #{trade.seq} {trade.symbol}
          </span>
          <span
            className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${trade.side === "long" ? "bg-profit/15 text-profit" : "bg-loss/15 text-loss"}`}
          >
            {SIDE_LABEL[trade.side]}
          </span>
        </h2>
        <span className="text-xs text-dim">
          현재가 {livePrice === null ? "조회 실패" : price(livePrice)} · 실현(수수료 포함) {signed(trade.realized_pnl)}{" "}
          USDT
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        {chips.map((c) => (
          <span key={c.k} title={c.tip} className="rounded-md border border-border px-2 py-0.5">
            <span className="text-dim">{c.k}</span> <span className="tnum">{c.v}</span>
          </span>
        ))}
      </div>

      {/* 지금 상태 한 줄 — 표를 읽기 전에 결론부터. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-surface-2 px-3 py-2 text-sm">
        <span className="text-xs text-dim">지금</span>
        {last.qty > 0 ? (
          <>
            <span className="tnum">
              {num(last.qty, 0)}개 · 평단 {price(last.avgPx)} · 손절{" "}
              <span className="text-loss">{last.stopPx === null ? "없음" : price(last.stopPx)}</span>
            </span>
            {outcome ? (
              <span className={`rounded-md px-2 py-0.5 text-xs font-medium tnum ${OUTCOME_CLASS[outcome.tone]}`}>
                {outcome.text}
              </span>
            ) : null}
            <span className={`tnum ${pnlClass(last.unrealizedR)}`}>미실현 {rText(last.unrealizedR)}</span>
          </>
        ) : (
          <span className="tnum">
            포지션 없음 · 누적 확정 <span className={pnlClass(last.realizedR)}>{rText(last.realizedR)}</span>
          </span>
        )}
      </div>

      <p className="mt-3 text-xs text-dim">왼쪽부터 시간순으로 단계가 쌓이고, 맨 오른쪽 「현재」 열이 지금 상태입니다.</p>
      <div className="mt-1.5 overflow-x-auto">
        <table className="table-fixed text-sm" style={{ width: LABEL_COL + stages.length * COL }}>
          <colgroup>
            <col style={{ width: LABEL_COL }} />
            {stages.map((s, i) => (
              <col key={`${s.kind}-${s.atMs}-${i}`} style={{ width: COL }} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-border text-xs text-dim">
              <th className="sticky left-0 z-10 bg-surface py-2 pr-3 text-left font-normal">단계</th>
              {stages.map((s, i) => {
                const change = stageChange(i === 0 ? null : stages[i - 1], s);
                return (
                  <th key={i} className={`px-1 py-2 text-center align-top font-normal ${nowCell(s)}`}>
                    <div
                      className={`text-sm font-medium ${s.kind === "stop_widen" || s.riskUp ? "text-loss" : "text-text"}`}
                    >
                      {s.kind === "now" ? STAGE_LABEL.now : `${i + 1} ${STAGE_LABEL[s.kind]}`}
                    </div>
                    <div className="mt-0.5 min-h-4 text-[11px] leading-tight text-text/80">{change ?? ""}</div>
                    <div className="mt-0.5 tnum">{at(s.atMs)}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="tnum">
            <tr className="border-b border-border/60">
              <td className="sticky left-0 z-10 bg-surface py-2 pr-3 align-top text-xs text-dim">
                <div className="font-medium text-text">가격 흐름</div>
                <ul className="mt-1.5 space-y-1">
                  <li className="flex items-center gap-1.5">
                    <span className="inline-block size-2 rounded-full bg-text" /> 체결·시세가
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span className="inline-block w-3 border-t border-dashed border-dim" /> 평단
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span className="inline-block w-3 border-t-2 border-loss" /> 손절
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span className="inline-block size-2 rounded-sm bg-profit/40" /> 손절이 이익 쪽
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span className="inline-block size-2 rounded-sm bg-loss/40" /> 손절이 손실 쪽
                  </li>
                </ul>
              </td>
              <td colSpan={stages.length} className="p-0">
                <FlowChart stages={stages} side={trade.side} />
              </td>
            </tr>
            <tr className="border-b border-border/60 text-xs">
              <td className="sticky left-0 z-10 bg-surface py-1.5 pr-3 text-dim">
                가격
                <div className="text-[11px] text-dim/80">체결가 · 현재는 시세</div>
              </td>
              {stages.map((s, i) => (
                <td key={i} className={`px-1 py-1.5 text-center font-medium ${nowCell(s)}`}>
                  {s.price === null ? DASH : price(s.price)}
                </td>
              ))}
            </tr>
            <tr className="border-b border-border/60 text-xs text-dim">
              <td className="sticky left-0 z-10 bg-surface py-1.5 pr-3">
                수량 · 평단 · 손절
                <div className="text-[11px] text-dim/80">단계가 끝난 뒤 상태</div>
              </td>
              {stages.map((s, i) => (
                <td key={i} className={`px-1 py-1.5 text-center ${nowCell(s)}`}>
                  <div className="text-text">{num(s.qty, 0)}개</div>
                  <div>{s.qty > 0 ? price(s.avgPx) : DASH}</div>
                  <div className="text-loss">{s.stopPx === null ? "손절 없음" : price(s.stopPx)}</div>
                </td>
              ))}
            </tr>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-border/60">
                <td className="sticky left-0 z-10 bg-surface py-1.5 pr-3">
                  <div className={row.strong ? "font-medium" : "text-dim"}>{row.label}</div>
                  <div className="text-[11px] leading-tight text-dim">{row.help}</div>
                </td>
                {stages.map((s, i) => (
                  <td key={i} className={`px-1 py-1.5 text-center ${s.kind === "now" ? "bg-surface-2 font-medium" : ""}`}>
                    {row.cell(s)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {stages.some((s) => s.riskUp) ? (
        <p className="mt-2 text-xs text-loss">
          빨간 CR = 진입 때 위험({plain(stages[0].cr)})보다 커진 단계 — 손절을 올리지 않고 추가했거나 손절을 넓혔습니다.
        </p>
      ) : null}
      {stages.some((s) => s.cr !== null && s.cr <= EPS) ? (
        <p className="mt-1 text-xs text-profit">초록 CR = 손절이 평단 이익 쪽으로 올라와 손절돼도 잃지 않는 단계입니다.</p>
      ) : null}
      {last.qty > 0 ? (
        <AddPreviewPanel
          side={trade.side}
          rBase={rBase}
          oneE={flow.oneE}
          cr0={stages[0].cr}
          qty={last.qty}
          avgPx={last.avgPx}
          stopPx={last.stopPx}
          livePrice={livePrice}
          tradeId={trade.id}
          stop0={trade.stop_px_0}
          entry0={view.entry0}
          feeRate={view.feeRate}
          merRows={addCtx?.merRows ?? null}
          threshold={addCtx?.thresholds[trade.symbol] ?? null}
          accel={addCtx?.accel ?? []}
        />
      ) : null}
    </section>
  );
}

/** 값이 null 인 곳에서 끊어 이어진 구간만 선으로 — 손절이 없던 단계를 0 으로 잇지 않는다. */
function runs(points: ({ x: number; y: number } | null)[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const p of points) {
    if (p === null) {
      if (cur.length > 1) out.push(cur.join(" "));
      cur = [];
    } else cur.push(`${p.x},${p.y}`);
  }
  if (cur.length > 1) out.push(cur.join(" "));
  return out;
}

/**
 * 단계 전체를 가로지르는 한 장의 가격 그림 — 표의 열과 같은 폭이라 칸 아래 숫자와 줄이 맞는다.
 *
 * 열마다 평단(점선)과 손절(빨간 선)을 그 칸 폭만큼 긋고 다음 칸과 이어, 손절이 평단을 넘어서는 순간이
 * 선의 교차로 보인다. 둘 사이는 손절이 이익 쪽이면 초록, 손실 쪽이면 빨강으로 칠한다(REQ-0109).
 */
function FlowChart({ stages, side }: { stages: Stage[]; side: Trade["side"] }) {
  const H = 132;
  const pad = 14;
  const inset = 10;
  const W = stages.length * COL;
  const known = stages
    .flatMap((s) => [s.price, s.stopPx, s.qty > 0 ? s.avgPx : null])
    .filter((p): p is number => p !== null && p > 0);
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  const y = (p: number) => (hi === lo ? H / 2 : pad + ((hi - p) / (hi - lo)) * (H - 2 * pad));
  const x0 = (i: number) => i * COL + inset;
  const x1 = (i: number) => (i + 1) * COL - inset;
  const xc = (i: number) => i * COL + COL / 2;

  const step = (pick: (s: Stage) => number | null) =>
    runs(
      stages.flatMap((s, i) => {
        const v = pick(s);
        return v === null ? [null] : [{ x: x0(i), y: y(v) }, { x: x1(i), y: y(v) }];
      }),
    );
  const avgRuns = step((s) => (s.qty > 0 ? s.avgPx : null));
  const stopRuns = step((s) => s.stopPx);
  const priceRuns = runs(stages.map((s, i) => (s.price === null ? null : { x: xc(i), y: y(s.price) })));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block" role="img" aria-label="단계별 가격·평단·손절 흐름">
      {stages.map((s, i) =>
        s.kind === "now" ? <rect key={`bg${i}`} x={i * COL} y={0} width={COL} height={H} className="fill-surface-2" /> : null,
      )}
      <text x={4} y={11} className="fill-dim text-[10px]">
        {price(hi)}
      </text>
      <text x={4} y={H - 3} className="fill-dim text-[10px]">
        {price(lo)}
      </text>
      {stages.map((s, i) => {
        if (s.qty <= 0 || s.stopPx === null) return null;
        const safe = side === "long" ? s.stopPx >= s.avgPx : s.stopPx <= s.avgPx;
        const top = Math.min(y(s.avgPx), y(s.stopPx));
        const h = Math.max(Math.abs(y(s.avgPx) - y(s.stopPx)), 1);
        return (
          <rect
            key={`z${i}`}
            x={x0(i)}
            y={top}
            width={x1(i) - x0(i)}
            height={h}
            className={safe ? "fill-profit/25" : "fill-loss/20"}
          />
        );
      })}
      {avgRuns.map((pts, k) => (
        <polyline key={`a${k}`} points={pts} fill="none" className="stroke-dim" strokeWidth={1.2} strokeDasharray="4 3" />
      ))}
      {stopRuns.map((pts, k) => (
        <polyline key={`s${k}`} points={pts} fill="none" className="stroke-loss" strokeWidth={2} />
      ))}
      {priceRuns.map((pts, k) => (
        <polyline key={`p${k}`} points={pts} fill="none" className="stroke-text/40" strokeWidth={1.2} />
      ))}
      {stages.map((s, i) =>
        s.price === null ? null : (
          <circle
            key={`c${i}`}
            cx={xc(i)}
            cy={y(s.price)}
            r={s.kind === "now" ? 5 : 3.5}
            className="fill-text"
          />
        ),
      )}
    </svg>
  );
}
