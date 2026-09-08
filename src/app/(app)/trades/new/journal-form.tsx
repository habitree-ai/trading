"use client";

import { useActionState, useState } from "react";

import { BasisLine, changeText, EventChip, fillText } from "@/app/(app)/trades/new/basis-line";
import {
  addPositionNote,
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
import { PhotoRow, PhotoStrip } from "@/components/photos";
import {
  JOURNAL_EVENT_LABEL,
  JOURNAL_EVENTS,
  RESULT_LABEL,
  SIDE_LABEL,
  type JournalEvent,
  type JournalNote,
  type Trade,
  type TradeAnnotation,
  type TradeFill,
} from "@/lib/domain";
import { DASH, date, dateTime, num, pnlClass, signed } from "@/lib/format";
import { addOnFills, diffBasis, fillBasis, hasPositionRecord, snapshotBasis } from "@/lib/journal-basis";
import { isOpenTrade } from "@/lib/metrics";
import type { FieldSuggestions } from "@/lib/queries";

/**
 * 기록 추가 — 기록은 두 가지뿐이다.
 *
 * 포지션 기록은 거래를 고르면 그 정보가 카드로 깔리고, 그 포지션의 기록이 시간순으로 이어진다 —
 * 진입 기록(거래 행의 근거·복기·감정) 뒤에 추가 기록(추가 진입·변경·메모 기준, journal_notes)이
 * 쌓인다(REQ-0049). 일반 기록은 종목(선택)·내용·감정만 적는다(저장은 journal_notes). 어느 쪽이든
 * 「차트」를 누르면 그 차트가 폼 안에 열리고, 거기 그린 메모가 기록에 붙는다.
 * 감정 칩은 두 종류가 같은 것을 본다 — 같은 말로 적어야 통계가 묶인다.
 */
type Kind = "position" | "free";

const KIND_LABEL: Record<Kind, { label: string; hint: string }> = {
  position: { label: "포지션 기록", hint: "포지션을 고르면 진입 기록 뒤에 추가 진입·변경·메모를 쌓습니다" },
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

/** 진입 기록의 칸들 — 저장이 끝나면 부모가 key 를 바꿔 새로 그린다(닫힌 요약으로 돌아간다). */
function EntryRecordFields({
  trade,
  userId,
  suggestions,
}: {
  trade: Trade;
  userId: string;
  suggestions: FieldSuggestions;
}) {
  const recorded = hasPositionRecord(trade);
  // 아직 안 적은 포지션은 바로 적게 열어 둔다 — 첫 기록의 흐름은 예전과 같아야 한다.
  const [editing, setEditing] = useState(!recorded);

  if (!editing) {
    return (
      <div className="sm:col-span-3 xl:col-span-4 space-y-1 text-sm whitespace-pre-wrap">
        {trade.rationale ? (
          <p>
            <span className="mr-1 text-xs text-dim">근거</span>
            {trade.rationale}
          </p>
        ) : null}
        {trade.review ? (
          <p>
            <span className="mr-1 text-xs text-dim">복기</span>
            {trade.review}
          </p>
        ) : null}
        {trade.emotion ? (
          <p>
            <span className="mr-1 text-xs text-dim">감정</span>
            {trade.emotion}
          </p>
        ) : null}
        <PhotoRow paths={trade.image_paths} />
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs text-accent hover:underline"
        >
          수정
        </button>
      </div>
    );
  }

  return (
    <>
      <SuggestTextarea
        name="rationale"
        label="근거"
        rows={5}
        defaultValue={trade.rationale ?? ""}
        options={suggestions.rationale}
      />
      <SuggestTextarea
        name="review"
        label="복기"
        rows={3}
        defaultValue={trade.review ?? ""}
        options={suggestions.review}
      />
      <SuggestField
        name="emotion"
        label="감정"
        hint="같은 말로 적어야 감정별 통계가 묶인다"
        defaultValue={trade.emotion ?? ""}
        options={suggestions.emotion}
      />
      <div className="sm:col-span-3 xl:col-span-4">
        <div className={LABEL}>
          사진 <span className="ml-1 text-dim/70">찍어 둔 메모·캡쳐를 이 복기에 붙입니다</span>
        </div>
        <PhotoStrip name="image_paths" userId={userId} bookId={trade.book_id} initial={trade.image_paths} />
      </div>
      <div className="sm:col-span-3 xl:col-span-4 flex items-center gap-3">
        <Submit label="진입 기록 저장" />
        {recorded ? (
          <button type="button" onClick={() => setEditing(false)} className="text-xs text-dim hover:text-text">
            취소
          </button>
        ) : null}
      </div>
    </>
  );
}

/**
 * 진입 기록 — 거래 행의 근거·복기·감정. 시간순 기록의 첫 줄이고, 저장 경로는 REQ-0048 그대로다.
 *
 * `/review` 통계와 `/order` 근거 게이트가 이 칸을 본다 — 추가 기록과 섞지 않는다.
 */
function EntryRecord({
  trade,
  userId,
  suggestions,
}: {
  trade: Trade;
  userId: string;
  suggestions: FieldSuggestions;
}) {
  const [state, action] = useActionState<JournalFormState, FormData>(savePositionRecord, {});
  return (
    <form action={action}>
      <input type="hidden" name="trade_id" value={trade.id} />
      <Section title={`진입 기록 · ${dateTime(trade.entry_at)}`}>
        <EntryRecordFields key={state.savedAt ?? 0} trade={trade} userId={userId} suggestions={suggestions} />
        {state.error || state.message ? (
          <div className="sm:col-span-3 xl:col-span-4">
            <Feedback state={state} />
          </div>
        ) : null}
      </Section>
    </form>
  );
}

/** 이 포지션에 쌓인 추가 기록 — 오래된 것부터. 삭제는 아래 최근 기록 목록에서. */
function PositionNotes({ notes }: { notes: JournalNote[] }) {
  if (notes.length === 0) return null;
  return (
    <ol className="space-y-2" aria-label="추가 기록">
      {notes.map((note) => (
        <li key={note.id} className="rounded-xl border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="tnum text-dim">{dateTime(note.created_at)}</span>
            {note.event ? <EventChip event={note.event} /> : null}
            {note.event ? <BasisLine event={note.event} basis={note.basis} /> : null}
            {note.emotion ? (
              <span className="rounded border border-beta/40 px-1.5 py-0.5 text-[11px] text-beta">감정 · {note.emotion}</span>
            ) : null}
          </div>
          {note.body ? <p className="mt-2 text-sm whitespace-pre-wrap">{note.body}</p> : null}
          <PhotoRow paths={note.image_paths} />
        </li>
      ))}
    </ol>
  );
}

const EVENT_HINT: Record<JournalEvent, string> = {
  add: "추가 진입 체결을 기준으로",
  change: "손절·TP·투입이 달라진 것을 기준으로",
  note: "사건 없이 지금 상태에서",
};

/**
 * 새 기록의 칸들 — 기준(추가 진입·변경·메모)을 고르고 내용·감정을 적는다.
 *
 * 기준은 자료가 이끄는 대로 미리 고른다: 아직 기록하지 않은 추가 진입 체결이 있으면 그것,
 * 직전 기록 대비 달라진 값이 있으면 변경, 아니면 메모. 사람은 바꿀 수 있다. 저장이 끝나면
 * 부모가 key 를 바꿔 통째로 새로 그린다.
 */
function NewPositionNoteFields({
  trade,
  userId,
  notes,
  fills,
  suggestions,
}: {
  trade: Trade;
  userId: string;
  notes: JournalNote[];
  fills: TradeFill[];
  suggestions: FieldSuggestions;
}) {
  const addOns = addOnFills(fills);
  // 이미 기록한 체결은 뒤로 — 같은 체결에 두 번 적는 일은 드물다.
  const recordedAt = new Set(notes.flatMap((n) => (n.basis?.fill ? [n.basis.fill.filled_at] : [])));
  const unrecorded = addOns.filter((f) => !recordedAt.has(f.filled_at));
  const prevBasis = [...notes].reverse().find((n) => n.basis !== null)?.basis ?? null;
  const changes = diffBasis(prevBasis, snapshotBasis(trade));

  const [event, setEvent] = useState<JournalEvent>(
    unrecorded.length > 0 ? "add" : changes.length > 0 ? "change" : "note",
  );
  const [fillId, setFillId] = useState(unrecorded[0]?.id ?? addOns.at(-1)?.id ?? "");
  const fill = addOns.find((f) => f.id === fillId) ?? null;

  const counts: Record<JournalEvent, number> = { add: unrecorded.length, change: changes.length, note: 0 };

  return (
    <Section title="새 기록">
      <input type="hidden" name="event" value={event} />
      <div className="sm:col-span-3 xl:col-span-4">
        <div className={LABEL}>기준</div>
        <div role="radiogroup" aria-label="기준" className="flex flex-wrap gap-2">
          {JOURNAL_EVENTS.map((e) => (
            <button
              key={e}
              type="button"
              role="radio"
              aria-checked={event === e}
              onClick={() => setEvent(e)}
              title={EVENT_HINT[e]}
              className={`rounded-lg border px-3 py-1.5 text-xs ${
                event === e ? "border-accent bg-accent/10 text-accent" : "border-border text-dim hover:text-text"
              }`}
            >
              {JOURNAL_EVENT_LABEL[e]}
              {counts[e] > 0 ? <span className="tnum ml-1 opacity-80">{counts[e]}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {event === "add" ? (
        <div className="sm:col-span-2 xl:col-span-3">
          <label className={LABEL} htmlFor="f-fill">
            체결{" "}
            <span className="ml-1 text-dim/70">
              {addOns.length === 0 ? "첫 진입 이후 체결이 아직 없습니다 — 체결 없이 남깁니다" : "첫 진입 이후의 진입 체결"}
            </span>
          </label>
          <select
            id="f-fill"
            name="fill_id"
            value={fillId}
            onChange={(e) => setFillId(e.target.value)}
            className={INPUT}
            disabled={addOns.length === 0}
          >
            <option value="">체결 없이</option>
            {addOns.map((f) => (
              <option key={f.id} value={f.id}>
                {fillText(fillBasis(f))}
                {recordedAt.has(f.filled_at) ? " · 기록됨" : ""}
              </option>
            ))}
          </select>
          {fill ? <p className="tnum mt-1 text-xs text-dim">기준 · {fillText(fillBasis(fill))}</p> : null}
        </div>
      ) : null}

      {event === "change" ? (
        <div className="sm:col-span-3 xl:col-span-4 text-xs">
          <div className={LABEL}>달라진 것 <span className="ml-1 text-dim/70">직전 기록의 스냅샷과 지금을 견줌</span></div>
          {changes.length > 0 ? (
            <ul className="flex flex-wrap gap-1" aria-label="달라진 것">
              {changes.map((c) => (
                <li key={c.label} className="tnum rounded border border-beta/40 px-1.5 py-0.5 text-beta">
                  {changeText(c)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-dim">
              {prevBasis === null
                ? "견줄 직전 기록이 없습니다 — 무엇을 바꿨는지 내용에 적어 주세요. 지금 값은 함께 저장됩니다."
                : "직전 기록과 같습니다 — 동기화가 아직 안 됐으면 먼저 동기화해 주세요."}
            </p>
          )}
        </div>
      ) : null}

      <SuggestField
        name="note_emotion"
        label="감정"
        hint="같은 말로 적어야 감정별 통계가 묶인다"
        options={suggestions.emotion}
      />
      <div className="sm:col-span-3 xl:col-span-4">
        <label className={LABEL} htmlFor="f-note-body">
          기록 내용 <span className="ml-1 text-dim/70">사진만 붙여도 됩니다</span>
        </label>
        <textarea id="f-note-body" name="body" rows={3} className={INPUT} />
      </div>
      <div className="sm:col-span-3 xl:col-span-4">
        <div className={LABEL}>사진</div>
        <PhotoStrip name="image_paths" userId={userId} bookId={trade.book_id} />
      </div>
    </Section>
  );
}

function NewPositionNoteForm({
  trade,
  userId,
  notes,
  fills,
  suggestions,
}: {
  trade: Trade;
  userId: string;
  notes: JournalNote[];
  fills: TradeFill[];
  suggestions: FieldSuggestions;
}) {
  const [state, action] = useActionState<JournalFormState, FormData>(addPositionNote, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="trade_id" value={trade.id} />
      <NewPositionNoteFields
        key={state.savedAt ?? 0}
        trade={trade}
        userId={userId}
        notes={notes}
        fills={fills}
        suggestions={suggestions}
      />
      <div className="flex items-center gap-3">
        <Submit label="기록 추가" />
        <Feedback state={state} />
      </div>
    </form>
  );
}

/**
 * 포지션 기록 — 포지션을 고르면 카드·차트, 그 아래 시간순 기록(진입 기록 → 추가 기록)과 새 기록 폼.
 *
 * 폼이 둘이다(진입 기록 저장 · 새 기록 추가) — 저장 경로가 다르고, 하나가 다른 하나를 덮어쓰면 안 된다.
 * 포지션을 바꾸면 아래를 통째로 새로 그린다 — 그 거래의 값이 기본값으로 들어와야 한다.
 */
function PositionPanel({
  trades,
  userId,
  notesByTrade,
  fillsByTrade,
  suggestions,
  now,
  initialTradeId,
}: {
  trades: Trade[];
  userId: string;
  notesByTrade: Record<string, JournalNote[]>;
  fillsByTrade: Record<string, TradeFill[]>;
  suggestions: FieldSuggestions;
  now: number;
  initialTradeId: string | null;
}) {
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
    <div className="space-y-3">
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

      {trade ? (
        <div key={trade.id} className="space-y-3">
          <EntryRecord trade={trade} userId={userId} suggestions={suggestions} />
          <PositionNotes notes={notesByTrade[trade.id] ?? []} />
          <NewPositionNoteForm
            trade={trade}
            userId={userId}
            notes={notesByTrade[trade.id] ?? []}
            fills={fillsByTrade[trade.id] ?? []}
            suggestions={suggestions}
          />
        </div>
      ) : null}
    </div>
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
  userId,
  bookId,
  suggestions,
  symbols,
  now,
}: {
  symbol: string;
  onSymbolChange: (value: string) => void;
  userId: string;
  bookId: string;
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
            기록 내용 <span className="ml-1 text-dim/70">사진만 붙여도 됩니다</span>
          </label>
          <textarea id="f-body" name="body" rows={4} className={INPUT} />
        </div>
        <div className="sm:col-span-3 xl:col-span-4">
          <div className={LABEL}>사진</div>
          <PhotoStrip name="image_paths" userId={userId} bookId={bookId} />
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
  userId,
  suggestions,
  symbols,
  now,
}: {
  bookId: string;
  userId: string;
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
        userId={userId}
        bookId={bookId}
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
  userId,
  trades,
  notesByTrade,
  fillsByTrade,
  suggestions,
  symbols,
  now,
  initialTradeId = null,
}: {
  bookId: string;
  /** 사진을 올릴 자리 — Storage 경로의 첫 폴더가 곧 권한이다 */
  userId: string;
  /** 고를 수 있는 포지션 — 보유중이 먼저, 그다음 최근 청산 순으로 정렬돼 온다 */
  trades: Trade[];
  /** 거래별 추가 기록 — 오래된 것부터 */
  notesByTrade: Record<string, JournalNote[]>;
  /** 거래별 체결 — 추가 진입 후보를 고르는 재료 */
  fillsByTrade: Record<string, TradeFill[]>;
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
        <PositionPanel
          trades={trades}
          userId={userId}
          notesByTrade={notesByTrade}
          fillsByTrade={fillsByTrade}
          suggestions={suggestions}
          now={now}
          initialTradeId={initialTradeId}
        />
      ) : (
        <FreeRecordForm
          bookId={bookId}
          userId={userId}
          suggestions={suggestions}
          symbols={symbols}
          now={now}
        />
      )}
    </div>
  );
}
