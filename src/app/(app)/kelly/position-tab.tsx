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

function PositionFlow({ view, addCtx }: { view: PositionView; addCtx: AddContext | null }) {
  const { trade, rBase, flow, livePrice } = view;
  const { stages } = flow;
  const last = stages[stages.length - 1];
  const prices = stages.flatMap((s) => [s.price, s.stopPx, s.qty > 0 ? s.avgPx : null]);
  const known = prices.filter((p): p is number => p !== null && p > 0);
  const lo = Math.min(...known);
  const hi = Math.max(...known);

  const rows: { label: string; cell: (s: Stage) => React.ReactNode; strong?: boolean }[] = [
    { label: "R", cell: (s) => plain(s.r) },
    { label: "E", cell: (s) => plain(s.e), strong: true },
    {
      label: "CR",
      cell: (s) => <span className={s.riskUp ? "font-semibold text-loss" : ""}>{plain(s.cr)}</span>,
      strong: true,
    },
    { label: "잠긴 R", cell: (s) => plain(s.lockedR) },
    {
      label: "미실현",
      cell: (s) => <span className={pnlClass(s.unrealizedR)}>{rText(s.unrealizedR)}</span>,
      strong: true,
    },
    {
      label: "누적 확정",
      cell: (s) => <span className={pnlClass(s.realizedR)}>{rText(s.realizedR)}</span>,
      strong: true,
    },
  ];

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">
          #{trade.seq} {trade.symbol} {SIDE_LABEL[trade.side]}{" "}
          <span className="font-normal text-dim">
            — 1R = {num(rBase, 2)} USDT{view.estimatedR ? "(현재 기준 R, 추정)" : ""} · 1E ={" "}
            {flow.oneE === null ? "최초 손절 없음" : `${num(flow.oneE, 2)}개`} · 최대 CR {plain(flow.maxCr)} · 최대 E{" "}
            {plain(flow.maxE)}
          </span>
        </h2>
        <span className="text-xs text-dim">
          현재가 {livePrice === null ? "조회 실패" : price(livePrice)} · 실현(수수료 포함) {signed(trade.realized_pnl)}{" "}
          USDT
        </span>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-dim">
              <th className="sticky left-0 bg-surface py-2 pr-3 text-left font-normal">단계</th>
              {stages.map((s, i) => (
                <th
                  key={`${s.kind}-${s.atMs}-${i}`}
                  className={`min-w-[5.5rem] px-2 py-2 text-center font-normal ${s.kind === "now" ? "bg-surface-2 text-text" : ""}`}
                >
                  <div className={s.kind === "stop_widen" || s.riskUp ? "text-loss" : "text-text"}>
                    {s.kind === "now" ? STAGE_LABEL.now : `${i + 1} ${STAGE_LABEL[s.kind]}`}
                  </div>
                  <div className="tnum">{at(s.atMs)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="tnum">
            {/* 책 표의 가격 사다리 — 같은 세로 눈금에 ★ 가격, 빨간 선 손절, 점선 평단. */}
            <tr className="border-b border-border/60">
              <td className="sticky left-0 bg-surface py-2 pr-3 text-xs text-dim">
                가격
                <div>{price(hi)}</div>
                <div className="mt-14">{price(lo)}</div>
              </td>
              {stages.map((s, i) => (
                <td key={i} className={`px-2 py-2 text-center ${s.kind === "now" ? "bg-surface-2" : ""}`}>
                  <Ladder stage={s} lo={lo} hi={hi} />
                  <div className="text-xs">{s.price === null ? DASH : price(s.price)}</div>
                </td>
              ))}
            </tr>
            <tr className="border-b border-border/60 text-xs text-dim">
              <td className="sticky left-0 bg-surface py-1.5 pr-3">수량 · 평단 · 손절</td>
              {stages.map((s, i) => (
                <td key={i} className={`px-2 py-1.5 text-center ${s.kind === "now" ? "bg-surface-2" : ""}`}>
                  <div>{num(s.qty, 0)}개</div>
                  <div>{s.qty > 0 ? price(s.avgPx) : DASH}</div>
                  <div className="text-loss">{s.stopPx === null ? "손절 없음" : price(s.stopPx)}</div>
                </td>
              ))}
            </tr>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-border/60">
                <td className={`sticky left-0 bg-surface py-1.5 pr-3 ${row.strong ? "font-medium" : "text-dim"}`}>
                  {row.label}
                </td>
                {stages.map((s, i) => (
                  <td
                    key={i}
                    className={`px-2 py-1.5 text-center ${s.kind === "now" ? "bg-surface-2 font-medium" : ""}`}
                  >
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

/** 한 단계의 가격 사다리 칸 — 모든 칸이 같은 눈금이라 옆으로 읽으면 가격의 흐름이 된다. */
function Ladder({ stage, lo, hi }: { stage: Stage; lo: number; hi: number }) {
  const H = 72;
  const pad = 8;
  const y = (p: number) => (hi === lo ? H / 2 : pad + ((hi - p) / (hi - lo)) * (H - 2 * pad));
  return (
    <svg viewBox={`0 0 40 ${H}`} width={40} height={H} className="mx-auto" aria-hidden>
      {stage.qty > 0 ? (
        <line
          x1={2}
          x2={38}
          y1={y(stage.avgPx)}
          y2={y(stage.avgPx)}
          className="stroke-dim"
          strokeWidth={1}
          strokeDasharray="3 2"
        />
      ) : null}
      {stage.stopPx !== null ? (
        <line x1={2} x2={38} y1={y(stage.stopPx)} y2={y(stage.stopPx)} className="stroke-loss" strokeWidth={1.5} />
      ) : null}
      {stage.price !== null ? (
        <text x={20} y={y(stage.price) + 5} textAnchor="middle" className="fill-text text-[14px]">
          ★
        </text>
      ) : null}
    </svg>
  );
}
