"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { updateTradeNotes } from "@/app/(app)/notes/actions";
import type { JournalFormState } from "@/app/(app)/trades/new/journal-actions";
import { NewPositionNoteForm, PositionCard, PositionNotes } from "@/app/(app)/trades/new/journal-form";
import {
  INPUT,
  LABEL,
  Section,
  Submit,
  SuggestField,
  SuggestTextarea,
} from "@/app/(app)/trades/trade-form";
import { PhotoRow, PhotoStrip } from "@/components/photos";
import {
  BIAS_TIMEFRAMES,
  ENTRY_TIMEFRAMES,
  isCounterTrend,
  OPENNESS_LABEL,
  OPENNESSES,
  SIDE_LABEL,
  TIMEFRAME_LABEL,
  TREND_LABEL,
  TRENDS,
  type JournalNote,
  type Trade,
  type TradeFill,
} from "@/lib/domain";
import { dateTime } from "@/lib/format";
import type { FieldSuggestions } from "@/lib/queries";

export interface PrincipleMark {
  title: string;
  kept: boolean;
  note: string | null;
}

const EDIT_BUTTON = "text-xs text-accent hover:underline";

function Feedback({ state }: { state: JournalFormState }) {
  if (state.error) return <span className="text-sm text-loss">{state.error}</span>;
  if (state.message) return <span className="text-sm text-profit">{state.message}</span>;
  return null;
}

/** 읽기 모드의 한 칸 — 비어 있으면 "미기재"를 흐리게 보여 빈 곳이 눈에 띄게 한다. */
function Field({ label, value, wide = false }: { label: string; value: string | null; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-3 xl:col-span-4" : ""}>
      <div className="text-[11px] text-dim">{label}</div>
      <div className={`text-sm whitespace-pre-wrap break-words ${value ? "" : "text-dim/60"}`}>
        {value || "미기재"}
      </div>
    </div>
  );
}

function Select({
  id,
  name,
  label,
  hint,
  value,
  options,
}: {
  id: string;
  name: string;
  label: string;
  hint: string;
  value: string | null;
  options: [string, string][];
}) {
  return (
    <div>
      <label className={LABEL} htmlFor={id}>
        {label} <span className="ml-1 text-dim/70">{hint}</span>
      </label>
      <select id={id} name={name} defaultValue={value ?? ""} className={INPUT}>
        <option value="">미기재</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * 근거 카드의 칸 — 5층 중 사람이 적는 L0~L3(추세·위아래·시계열·셋업·근거 글).
 * L4(손절·목표)는 숫자라 위 포지션 카드에서 읽기만 한다.
 * 저장이 끝나면 부모가 key 를 바꿔 새로 그린다 — 읽기 모드로 돌아간다.
 */
function BasisFields({ trade, suggestions }: { trade: Trade; suggestions: FieldSuggestions }) {
  const [editing, setEditing] = useState(false);
  const [trigger, ...rest] = (trade.rationale ?? "").split("\n");
  const counter = isCounterTrend(trade.trend, trade.side);

  if (!editing) {
    return (
      <>
        <Field
          label="장기추세"
          value={
            trade.trend ? `${TREND_LABEL[trade.trend]}${counter ? ` · 역추세 ${SIDE_LABEL[trade.side]}` : ""}` : null
          }
        />
        <Field label="위·아래" value={trade.openness ? OPENNESS_LABEL[trade.openness] : null} />
        <Field
          label="방향 / 진입 시계열"
          value={
            trade.timeframe_bias || trade.timeframe_entry
              ? `${trade.timeframe_bias ? TIMEFRAME_LABEL[trade.timeframe_bias] : "—"} / ${
                  trade.timeframe_entry ? TIMEFRAME_LABEL[trade.timeframe_entry] : "—"
                }`
              : null
          }
        />
        <Field label="기준 (셋업)" value={trade.setup} />
        <Field label="트리거 (근거 첫 줄)" value={trigger?.trim() || null} wide />
        {rest.join("\n").trim() ? <Field label="보조 근거" value={rest.join("\n").trim()} wide /> : null}
        <div className="sm:col-span-3 xl:col-span-4">
          <button type="button" onClick={() => setEditing(true)} className={EDIT_BUTTON}>
            ✎ 근거 수정
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <Select
        id="n-trend"
        name="trend"
        label="장기추세"
        hint="진입 때의 중장기 판단"
        value={trade.trend}
        options={TRENDS.map((t) => [t, TREND_LABEL[t]])}
      />
      <Select
        id="n-openness"
        name="openness"
        label="위·아래"
        hint="각각 막혀 있었는가"
        value={trade.openness}
        options={OPENNESSES.map((o) => [o, OPENNESS_LABEL[o]])}
      />
      <Select
        id="n-tf-bias"
        name="timeframe_bias"
        label="방향 시계열"
        hint="방향을 본 봉"
        value={trade.timeframe_bias}
        options={BIAS_TIMEFRAMES.map((t) => [t, TIMEFRAME_LABEL[t]])}
      />
      <Select
        id="n-tf-entry"
        name="timeframe_entry"
        label="진입 시계열"
        hint="타이밍을 잡은 봉"
        value={trade.timeframe_entry}
        options={ENTRY_TIMEFRAMES.map((t) => [t, TIMEFRAME_LABEL[t]])}
      />
      <SuggestField name="setup" label="기준 (셋업)" defaultValue={trade.setup ?? ""} options={suggestions.setup} />
      <SuggestTextarea
        name="rationale"
        label="근거 — 첫 줄이 트리거"
        rows={5}
        defaultValue={trade.rationale ?? ""}
        options={suggestions.rationale}
      />
      <div className="sm:col-span-3 xl:col-span-4 flex items-center gap-3">
        <Submit label="근거 저장" />
        <button type="button" onClick={() => setEditing(false)} className="text-xs text-dim hover:text-text">
          취소
        </button>
      </div>
    </>
  );
}

/** 복기 카드의 칸 — 복기·감정·비고·사진. */
function ReviewFields({
  trade,
  userId,
  suggestions,
}: {
  trade: Trade;
  userId: string;
  suggestions: FieldSuggestions;
}) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <>
        <Field label="복기" value={trade.review} wide />
        <Field label="감정" value={trade.emotion} />
        <Field label="비고" value={trade.note} />
        {trade.image_paths.length > 0 ? (
          <div className="sm:col-span-3 xl:col-span-4">
            <PhotoRow paths={trade.image_paths} />
          </div>
        ) : null}
        <div className="sm:col-span-3 xl:col-span-4">
          <button type="button" onClick={() => setEditing(true)} className={EDIT_BUTTON}>
            ✎ 복기 수정
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <SuggestTextarea
        name="review"
        label="복기"
        rows={4}
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
      <div>
        <label className={LABEL} htmlFor="n-note">
          비고
        </label>
        <input id="n-note" name="note" defaultValue={trade.note ?? ""} className={INPUT} />
      </div>
      <div className="sm:col-span-3 xl:col-span-4">
        <div className={LABEL}>
          사진 <span className="ml-1 text-dim/70">찍어 둔 메모·캡쳐를 이 복기에 붙입니다</span>
        </div>
        <PhotoStrip name="image_paths" userId={userId} bookId={trade.book_id} initial={trade.image_paths} />
      </div>
      <div className="sm:col-span-3 xl:col-span-4 flex items-center gap-3">
        <Submit label="복기 저장" />
        <button type="button" onClick={() => setEditing(false)} className="text-xs text-dim hover:text-text">
          취소
        </button>
      </div>
    </>
  );
}

/** 카드 하나 = 폼 하나. 근거와 복기는 저장 칸이 겹치지 않게 구역(section)으로 나눈다. */
function NotesCard({
  trade,
  section,
  title,
  children,
}: {
  trade: Trade;
  section: "basis" | "review";
  title: string;
  children: (savedAt: number) => React.ReactNode;
}) {
  const [state, action] = useActionState<JournalFormState, FormData>(updateTradeNotes, {});
  return (
    <form action={action}>
      <input type="hidden" name="trade_id" value={trade.id} />
      <input type="hidden" name="section" value={section} />
      <Section title={title}>
        {children(state.savedAt ?? 0)}
        {state.error || state.message ? (
          <div className="sm:col-span-3 xl:col-span-4">
            <Feedback state={state} />
          </div>
        ) : null}
      </Section>
    </form>
  );
}

/**
 * 매매 한 건의 노트 — 위에서부터 숫자(읽기) → 근거 → 복기 → 원칙 → 추가 기록.
 *
 * 매매를 되짚는 순서대로 놓았다: 무엇을 했나, 왜 들어갔나, 돌아보니 어땠나, 원칙을 지켰나,
 * 그 사이 무슨 일이 있었나. 부모가 거래 id 를 key 로 주므로 거래를 바꾸면 통째로 새로 그린다.
 */
export function TradeDetail({
  trade,
  notes,
  fills,
  principles,
  suggestions,
  userId,
  backHref,
}: {
  trade: Trade;
  notes: JournalNote[];
  fills: TradeFill[];
  principles: PrincipleMark[];
  suggestions: FieldSuggestions;
  userId: string;
  /** 좁은 화면에서 목록으로 돌아가는 링크 */
  backHref: string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link href={backHref} className="text-xs text-dim hover:text-text lg:hidden">
          ← 목록
        </Link>
        <h2 className="text-base font-medium">
          #{trade.seq} {trade.symbol}{" "}
          <span className={trade.side === "long" ? "text-profit" : "text-loss"}>{SIDE_LABEL[trade.side]}</span>
        </h2>
        <span className="tnum text-xs text-dim">{dateTime(trade.entry_at)}</span>
        <Link href={`/trades/${trade.id}`} className="ml-auto text-xs text-accent hover:underline">
          숫자 고치기 →
        </Link>
      </div>

      <PositionCard trade={trade} />

      <NotesCard trade={trade} section="basis" title="근거">
        {(savedAt) => <BasisFields key={savedAt} trade={trade} suggestions={suggestions} />}
      </NotesCard>

      <NotesCard trade={trade} section="review" title="복기">
        {(savedAt) => <ReviewFields key={savedAt} trade={trade} userId={userId} suggestions={suggestions} />}
      </NotesCard>

      {principles.length > 0 ? (
        <section className="rounded-xl border border-border bg-surface p-3">
          <h3 className="px-1 text-xs font-medium text-dim">원칙</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {principles.map((p) => (
              <li key={p.title} className="flex gap-2">
                <span className={p.kept ? "text-profit" : "text-loss"}>{p.kept ? "✓ 지킴" : "✗ 어김"}</span>
                <span>{p.title}</span>
                {p.note ? <span className="text-dim">— {p.note}</span> : null}
              </li>
            ))}
          </ul>
          <p className="mt-2 px-1 text-[11px] text-dim">
            고치는 곳은 <Link href="/principles" className="text-accent hover:underline">원칙</Link> 화면입니다.
          </p>
        </section>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-sm font-medium">
          추가 기록 <span className="font-normal text-dim">— 추가 진입·변경·메모, 오래된 것부터</span>
        </h3>
        {notes.length === 0 ? <p className="text-xs text-dim">아직 추가 기록이 없습니다.</p> : null}
        <PositionNotes notes={notes} deletable />
        <NewPositionNoteForm trade={trade} userId={userId} notes={notes} fills={fills} suggestions={suggestions} />
      </section>
    </div>
  );
}
