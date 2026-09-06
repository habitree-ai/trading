"use client";

import { useActionState, useState } from "react";

import {
  createJournalNote,
  savePositionRecord,
  type JournalFormState,
} from "@/app/(app)/trades/new/journal-actions";
import { DraftChart, PositionChart } from "@/app/(app)/trades/new/journal-charts";
import {
  INPUT,
  LABEL,
  Section,
  Submit,
  SuggestField,
  SuggestTextarea,
} from "@/app/(app)/trades/trade-form";
import { serializeDraftAnnotations } from "@/components/annotation-store";
import { RESULT_LABEL, SIDE_LABEL, type Trade, type TradeAnnotation } from "@/lib/domain";
import { DASH, date, dateTime, num, pnlClass, signed } from "@/lib/format";
import { isOpenTrade } from "@/lib/metrics";
import type { FieldSuggestions } from "@/lib/queries";

/**
 * 기록 추가 — 기록은 두 가지뿐이다.
 *
 * 포지션 기록은 거래를 고르면 그 정보가 카드로 깔리고 그 위에 근거·복기·감정을 적는다(저장은
 * 거래 행). 일반 기록은 종목(선택)·내용·감정만 적는다(저장은 journal_notes). 어느 쪽이든
 * 「차트」를 누르면 그 차트가 폼 안에 열리고, 거기 그린 메모가 기록에 붙는다.
 * 감정 칩은 두 종류가 같은 것을 본다 — 같은 말로 적어야 통계가 묶인다.
 */
type Kind = "position" | "free";

const KIND_LABEL: Record<Kind, { label: string; hint: string }> = {
  position: { label: "포지션 기록", hint: "포지션을 고르면 그 정보 위에 적습니다" },
  free: { label: "일반 기록", hint: "포지션과 무관한 관찰·감정" },
};

const CHART_BUTTON =
  "rounded-lg border px-3 py-1.5 text-xs disabled:opacity-40";
const CHART_ON = `${CHART_BUTTON} border-accent bg-accent text-white`;
const CHART_OFF = `${CHART_BUTTON} border-border text-accent hover:border-accent`;

/** 고르는 목록의 한 줄 — 순번·종목·방향·상태(보유중 / 승패와 손익)·진입일. */
function optionLabel(trade: Trade): string {
  const open = isOpenTrade(trade);
  const status = open
    ? "보유중"
    : `${RESULT_LABEL[trade.result]} ${signed(trade.realized_pnl ?? trade.pnl)}`;
  return `#${trade.seq} · ${trade.symbol} ${SIDE_LABEL[trade.side]} · ${status} · ${date(trade.entry_at)}`;
}

function Stat({ label, wide = false, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={wide ? "col-span-2 min-w-0" : "min-w-0"}>
      <div className="text-[11px] text-dim">{label}</div>
      <div className="tnum text-sm break-words">{children}</div>
    </div>
  );
}

/** 고른 포지션의 정보 — 동기화가 채운 값을 그대로 깔아 둔다. 여기서는 고치지 않는다. */
function PositionCard({ trade }: { trade: Trade }) {
  const open = isOpenTrade(trade);
  const targets = [trade.okx_tp_price ?? trade.tp1_price, trade.tp2_price, trade.tp3_price];
  return (
    <div className="sm:col-span-3 xl:col-span-4 grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-border bg-bg p-3 sm:grid-cols-4 xl:grid-cols-6">
      <Stat label="방향 · 종목">
        <span className={trade.side === "long" ? "text-profit" : "text-loss"}>{SIDE_LABEL[trade.side]}</span>{" "}
        {trade.symbol}
      </Stat>
      <Stat label="상태">{open ? "보유중" : RESULT_LABEL[trade.result]}</Stat>
      <Stat label="진입">
        {num(trade.entry_price)}
        <span className="block text-[11px] text-dim">{dateTime(trade.entry_at)}</span>
      </Stat>
      <Stat label={open ? "평가손익" : "청산"}>
        {open ? (
          <span className={pnlClass(trade.unrealized_pnl)}>{signed(trade.unrealized_pnl)}</span>
        ) : (
          <>
            {num(trade.exit_price)}
            <span className="block text-[11px] text-dim">{dateTime(trade.exit_at)}</span>
          </>
        )}
      </Stat>
      {open ? null : (
        <Stat label="실현손익">
          <span className={pnlClass(trade.realized_pnl ?? trade.pnl)}>{signed(trade.realized_pnl ?? trade.pnl)}</span>
        </Stat>
      )}
      <Stat label="투입 · Lv">
        {num(trade.notional, 0)} · {num(trade.leverage, 1)}
      </Stat>
      <Stat label="손절">{num(trade.okx_stop_price ?? trade.stop_price)}</Stat>
      <Stat label="목표 TP1 / 2 / 3" wide>
        {targets.map((t) => (t === null ? DASH : num(t))).join(" / ")}
      </Stat>
    </div>
  );
}

function Feedback({ state }: { state: JournalFormState }) {
  if (state.error) return <span className="text-sm text-loss">{state.error}</span>;
  if (state.message) return <span className="text-sm text-profit">{state.message}</span>;
  return null;
}

function PositionRecordForm({
  trades,
  suggestions,
  now,
  initialTradeId,
}: {
  trades: Trade[];
  suggestions: FieldSuggestions;
  now: number;
  initialTradeId: string | null;
}) {
  const [state, action] = useActionState<JournalFormState, FormData>(savePositionRecord, {});
  const [tradeId, setTradeId] = useState(
    () => trades.find((t) => t.id === initialTradeId)?.id ?? trades[0]?.id ?? "",
  );
  const [showChart, setShowChart] = useState(false);
  const trade = trades.find((t) => t.id === tradeId) ?? null;

  if (trades.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-dim">
        이 북에 포지션이 없습니다. 동기화하거나 일반 기록으로 적어 주세요.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="trade_id" value={tradeId} />

      <Section title="포지션">
        <div className="sm:col-span-2 xl:col-span-3">
          <label className={LABEL} htmlFor="f-trade">
            포지션 <span className="ml-1 text-dim/70">보유중이 먼저, 그다음 최근 청산</span>
          </label>
          <select
            id="f-trade"
            value={tradeId}
            onChange={(e) => setTradeId(e.target.value)}
            className={INPUT}
          >
            {trades.map((t) => (
              <option key={t.id} value={t.id}>
                {optionLabel(t)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <button
            type="button"
            aria-pressed={showChart}
            onClick={() => setShowChart((v) => !v)}
            className={showChart ? CHART_ON : CHART_OFF}
            title={trade && isOpenTrade(trade) ? "진입부터 지금까지의 차트" : "진입부터 청산까지의 차트"}
          >
            {showChart ? "차트 닫기" : "차트"}
          </button>
        </div>
        {trade ? <PositionCard trade={trade} /> : null}
      </Section>

      {trade && showChart ? <PositionChart trade={trade} now={now} /> : null}

      {/* 포지션을 바꾸면 칸을 새로 그린다 — 그 거래에 적어 둔 값이 기본값으로 들어와야 한다. */}
      <div key={tradeId}>
        <Section title="기록">
          <SuggestTextarea
            name="rationale"
            label="근거"
            rows={3}
            defaultValue={trade?.rationale ?? ""}
            options={suggestions.rationale}
          />
          <SuggestTextarea
            name="review"
            label="복기"
            rows={3}
            defaultValue={trade?.review ?? ""}
            options={suggestions.review}
          />
          <SuggestField
            name="emotion"
            label="감정"
            hint="같은 말로 적어야 감정별 통계가 묶인다"
            defaultValue={trade?.emotion ?? ""}
            options={suggestions.emotion}
          />
        </Section>
      </div>

      <div className="flex items-center gap-3">
        <Submit label="기록 저장" />
        <Feedback state={state} />
      </div>
    </form>
  );
}

/**
 * 일반 기록의 칸들 — 저장이 끝나면 부모가 key 를 바꿔 통째로 새로 그린다.
 *
 * 내용·감정·차트 메모·차트 열림이 한 번에 비워진다. 종목만 부모가 들고 있어 남는다 —
 * 다음 기록도 같은 종목일 때가 많다.
 */
function FreeRecordFields({
  symbol,
  onSymbolChange,
  suggestions,
  symbols,
  now,
}: {
  symbol: string;
  onSymbolChange: (value: string) => void;
  suggestions: FieldSuggestions;
  symbols: string[];
  now: number;
}) {
  const [showChart, setShowChart] = useState(false);
  const [drafts, setDrafts] = useState<TradeAnnotation[]>([]);
  const chartSymbol = symbol.trim().toUpperCase();

  return (
    <>
      <input type="hidden" name="annotations" value={serializeDraftAnnotations(drafts)} />

      <Section title="일반 기록">
        <div>
          <label className={LABEL} htmlFor="f-symbol">
            종목 <span className="ml-1 text-dim/70">없어도 됩니다</span>
          </label>
          <input
            id="f-symbol"
            name="symbol"
            list="dl-symbol"
            value={symbol}
            onChange={(e) => {
              onSymbolChange(e.target.value);
              // 종목이 바뀌면 그려 둔 메모는 다른 차트의 것이다 — 비우고 차트도 접는다.
              if (e.target.value.trim().toUpperCase() !== chartSymbol) {
                setDrafts([]);
                setShowChart(false);
              }
            }}
            placeholder="BTC"
            className={INPUT}
          />
          <datalist id="dl-symbol">
            {symbols.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <div className="flex items-end">
          <button
            type="button"
            aria-pressed={showChart}
            disabled={chartSymbol === ""}
            onClick={() => setShowChart((v) => !v)}
            className={showChart ? CHART_ON : CHART_OFF}
            title={chartSymbol === "" ? "종목을 적으면 현재 차트를 열 수 있습니다" : "그 종목의 현재 차트"}
          >
            {showChart ? "차트 닫기" : "차트"}
          </button>
        </div>
        <SuggestField
          name="emotion"
          label="감정"
          hint="같은 말로 적어야 감정별 통계가 묶인다"
          options={suggestions.emotion}
        />
        <div className="sm:col-span-3 xl:col-span-4">
          <label className={LABEL} htmlFor="f-body">
            기록 내용
          </label>
          <textarea id="f-body" name="body" rows={4} className={INPUT} />
        </div>
      </Section>

      {showChart && chartSymbol !== "" ? (
        <DraftChart key={chartSymbol} symbol={chartSymbol} now={now} initial={drafts} onChange={setDrafts} />
      ) : null}

      {drafts.length > 0 ? (
        <p className="text-xs text-dim">차트 메모 {drafts.length}개 — 저장 시 기록과 함께 저장됩니다</p>
      ) : null}
    </>
  );
}

function FreeRecordForm({
  bookId,
  suggestions,
  symbols,
  now,
}: {
  bookId: string;
  suggestions: FieldSuggestions;
  symbols: string[];
  now: number;
}) {
  const [state, action] = useActionState<JournalFormState, FormData>(createJournalNote, {});
  const [symbol, setSymbol] = useState("");

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="book_id" value={bookId} />

      {/* 저장 시각이 key 다 — 저장이 끝날 때마다 칸이 비워진다. */}
      <FreeRecordFields
        key={state.savedAt ?? 0}
        symbol={symbol}
        onSymbolChange={setSymbol}
        suggestions={suggestions}
        symbols={symbols}
        now={now}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Submit label="기록 저장" />
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function JournalForm({
  bookId,
  trades,
  suggestions,
  symbols,
  now,
  initialTradeId = null,
}: {
  bookId: string;
  /** 고를 수 있는 포지션 — 보유중이 먼저, 그다음 최근 청산 순으로 정렬돼 온다 */
  trades: Trade[];
  suggestions: FieldSuggestions;
  /** 종목 자동완성 — 이 북에서 거래한 종목 */
  symbols: string[];
  /** 페이지를 그린 시각(ms) — 차트가 어디까지 그릴지 */
  now: number;
  /** 목록에서 "이 포지션 기록하기"로 들어온 거래 — 있으면 포지션 기록으로 시작한다 */
  initialTradeId?: string | null;
}) {
  const [kind, setKind] = useState<Kind>(
    initialTradeId !== null || trades.length > 0 ? "position" : "free",
  );

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="기록 종류" className="flex flex-wrap gap-2">
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            className={`rounded-lg border px-3 py-2 text-left ${
              kind === k ? "border-accent bg-accent/10 text-accent" : "border-border text-dim hover:text-text"
            }`}
          >
            <span className="block text-sm font-medium">{KIND_LABEL[k].label}</span>
            <span className="block text-[11px] opacity-80">{KIND_LABEL[k].hint}</span>
          </button>
        ))}
      </div>

      {kind === "position" ? (
        <PositionRecordForm
          trades={trades}
          suggestions={suggestions}
          now={now}
          initialTradeId={initialTradeId}
        />
      ) : (
        <FreeRecordForm bookId={bookId} suggestions={suggestions} symbols={symbols} now={now} />
      )}
    </div>
  );
}
