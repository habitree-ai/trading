"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { createTrade, updateTrade, type TradeFormState } from "@/app/(app)/trades/actions";
import type { Trade } from "@/lib/domain";
import type { Prefill } from "@/lib/extract/to-prefill";
import type { ExtractedFill } from "@/lib/extract/types";
import { checkTpSplit } from "@/lib/exit-plan";
import { toLocalInput } from "@/lib/format";
import { crossCheckPnl, type PnlCrossCheck } from "@/lib/metrics";
import type { FieldSuggestions } from "@/lib/queries";

const NO_SUGGESTIONS: FieldSuggestions = { setup: [], rationale: [], emotion: [], review: [] };

function numberField(data: FormData, key: string): number | null {
  const raw = String(data.get(key) ?? "").trim().replace(/,/g, "");
  if (raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 폼에 지금 들어 있는 값으로 손익 교차검증을 돌린다. */
function readCrossCheck(form: HTMLFormElement, side: "long" | "short"): PnlCrossCheck | null {
  const data = new FormData(form);
  const n = (key: string) => numberField(data, key);

  return crossCheckPnl({
    side,
    notional: n("notional"),
    entry_price: n("entry_price"),
    exit_price: n("exit_price"),
    pnl: n("pnl"),
  });
}

/**
 * TP 비중 경고 — 저장을 막지 않는다.
 *
 * TP1 자리는 거래소 익절이 먼저 선다(카드와 같은 판정). 손으로 가격을 안 적어도 거래소에
 * 걸려 있으면 그 단은 살아 있어, 비중만 적은 것이 "가격 없는데 비율만" 으로 잡히지 않게.
 */
function readTpSplit(form: HTMLFormElement, okxTpPrice: number | null): string | null {
  const data = new FormData(form);
  const n = (key: string) => numberField(data, key);
  return checkTpSplit({
    prices: [okxTpPrice ?? n("tp1_price"), n("tp2_price"), n("tp3_price")],
    pcts: [n("tp1_pct"), n("tp2_pct"), n("tp3_pct")],
  });
}

const INPUT =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent";
const LABEL = "block text-xs text-dim mb-1";

function Field({
  name,
  label,
  hint,
  defaultValue,
  suspect,
  type = "text",
  numeric = false,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultValue?: string;
  suspect?: boolean;
  type?: string;
  numeric?: boolean;
}) {
  return (
    <div>
      <label className={LABEL} htmlFor={`f-${name}`}>
        {label}
        {hint ? <span className="ml-1 text-dim/70">{hint}</span> : null}
      </label>
      <input
        id={`f-${name}`}
        name={name}
        type={type}
        defaultValue={defaultValue}
        inputMode={numeric ? "decimal" : undefined}
        className={`${INPUT} ${numeric ? "tnum" : ""} ${suspect ? "border-beta" : ""}`}
      />
    </div>
  );
}

/** 칩으로 보여 줄 최대 개수 — 그 뒤는 자동완성 목록에만 남는다. */
const CHIP_LIMIT = 8;

/**
 * 한 줄 입력 + 이전 값 칩 — 감정·기준처럼 같은 말이 반복되는 칸.
 *
 * 복기 분석은 같은 문자열끼리 묶어 센다. "불안"과 "불안함"이 다른 줄로 갈리지 않으려면
 * 새로 치는 것보다 골라 넣는 편이 낫다. 자동완성 목록은 칩에 없는 값까지 담는다.
 */
function SuggestField({
  name,
  label,
  hint,
  defaultValue,
  options,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultValue?: string;
  options: string[];
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const listId = `dl-${name}`;
  return (
    <div>
      <label className={LABEL} htmlFor={`f-${name}`}>
        {label}
        {hint ? <span className="ml-1 text-dim/70">{hint}</span> : null}
      </label>
      <input
        id={`f-${name}`}
        name={name}
        list={listId}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={INPUT}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      {options.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {options.slice(0, CHIP_LIMIT).map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => setValue(o)}
              aria-pressed={value === o}
              className={`rounded-full border px-2 py-0.5 text-[11px] ${
                value === o ? "border-accent text-accent" : "border-border text-dim"
              }`}
            >
              {o}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 여러 줄 입력 + 이전 글 불러오기 — 근거·복기.
 *
 * 골라 넣을 때 비어 있으면 그대로 두고, 이미 적은 게 있으면 줄을 바꿔 덧붙인다 —
 * 쓰던 글이 조용히 지워지면 안 된다.
 */
function SuggestTextarea({
  name,
  label,
  rows,
  defaultValue,
  options,
}: {
  name: string;
  label: string;
  rows: number;
  defaultValue?: string;
  options: string[];
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  return (
    <div className="sm:col-span-3">
      <div className="mb-1 flex items-baseline gap-2">
        <label className="text-xs text-dim" htmlFor={`f-${name}`}>
          {label}
        </label>
        {options.length > 0 ? (
          <select
            aria-label={`이전 ${label} 불러오기`}
            value=""
            onChange={(e) => {
              const picked = e.target.value;
              if (!picked) return;
              setValue((cur) => (cur.trim() === "" ? picked : `${cur.trimEnd()}\n${picked}`));
            }}
            className="ml-auto max-w-[60%] rounded-lg border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
          >
            <option value="">이전 {label}에서 불러오기…</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {o.length > 60 ? `${o.slice(0, 60)}…` : o}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <textarea
        id={`f-${name}`}
        name={name}
        rows={rows}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={INPUT}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-xl border border-border bg-surface p-4">
      <legend className="px-1 text-xs font-medium text-dim">{title}</legend>
      <div className="grid gap-3 sm:grid-cols-3">{children}</div>
    </fieldset>
  );
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? "저장 중…" : label}
    </button>
  );
}

export function TradeForm({
  bookId,
  trade,
  prefill,
  suspectFields = [],
  imageIds = [],
  fills,
  suggestions = NO_SUGGESTIONS,
}: {
  bookId: string;
  trade?: Trade;
  prefill?: Prefill;
  /** 이 북에서 전에 적었던 기준·근거·감정·복기 — 골라 넣을 선택지. */
  suggestions?: FieldSuggestions;
  /** 값이 채워졌어도 사람이 확인해야 하는 칸 — 테두리로 표시한다. */
  suspectFields?: string[];
  /** 저장 시 이 거래에 연결할 캡쳐 이미지들. */
  imageIds?: string[];
  /** 캡쳐에서 읽은 낱개 체결 — 차트가 실제 좌표를 찍는 데 쓴다. */
  fills?: ExtractedFill[];
}) {
  const [state, action] = useActionState<TradeFormState, FormData>(
    trade ? updateTrade : createTrade,
    {},
  );
  const [side, setSide] = useState<"long" | "short">(
    (prefill?.side as "long" | "short" | undefined) ?? trade?.side ?? "long",
  );
  const suspect = new Set(suspectFields);
  const [check, setCheck] = useState<PnlCrossCheck | null>(null);
  const [tpNote, setTpNote] = useState<string | null>(null);

  const v = (key: keyof Trade): string => {
    const fromPrefill = prefill?.[key];
    if (fromPrefill !== undefined) return fromPrefill;
    const raw = trade?.[key];
    return raw === null || raw === undefined ? "" : String(raw);
  };

  return (
    <form
      action={action}
      className="space-y-4"
      onInput={(e) => {
        setCheck(readCrossCheck(e.currentTarget, side));
        setTpNote(readTpSplit(e.currentTarget, trade?.okx_tp_price ?? null));
      }}
    >
      <input type="hidden" name="book_id" value={bookId} />
      {trade ? <input type="hidden" name="trade_id" value={trade.id} /> : null}
      {imageIds.map((id) => (
        <input key={id} type="hidden" name="image_ids" value={id} />
      ))}
      {fills && fills.length > 0 ? (
        <input type="hidden" name="fills" value={JSON.stringify(fills)} />
      ) : null}

      <Section title="거래 개요">
        <div>
          <span className={LABEL}>방향</span>
          <div className="flex gap-2">
            {(["long", "short"] as const).map((s) => (
              <label
                key={s}
                className={`flex-1 cursor-pointer rounded-lg border px-3 py-2 text-center text-sm ${
                  side === s
                    ? s === "long"
                      ? "border-profit text-profit"
                      : "border-loss text-loss"
                    : "border-border text-dim"
                }`}
              >
                <input
                  type="radio"
                  name="side"
                  value={s}
                  checked={side === s}
                  onChange={() => setSide(s)}
                  className="sr-only"
                />
                {s === "long" ? "롱 (L)" : "숏 (S)"}
              </label>
            ))}
          </div>
        </div>
        <Field name="symbol" label="종목 *" defaultValue={v("symbol")} suspect={suspect.has("symbol")} />
        <div>
          <label className={LABEL} htmlFor="f-result">
            승패 <span className="text-dim/70">비우면 손익 부호로 자동 판정</span>
          </label>
          <select
            id="f-result"
            name="result"
            defaultValue={trade?.result ?? "auto"}
            className={INPUT}
          >
            <option value="auto">자동</option>
            <option value="win">승</option>
            <option value="loss">패</option>
            <option value="be">본전</option>
            <option value="open">보유중</option>
          </select>
        </div>
        <Field
          name="entry_at"
          label="진입 *"
          type="datetime-local"
          defaultValue={prefill?.entry_at ?? toLocalInput(trade?.entry_at ?? null)}
          suspect={suspect.has("entry_at")}
        />
        <Field
          name="exit_at"
          label="종료"
          type="datetime-local"
          defaultValue={prefill?.exit_at ?? toLocalInput(trade?.exit_at ?? null)}
          suspect={suspect.has("exit_at")}
        />
        <Field
          name="pnl"
          label="손익 (TP/SP)"
          hint="부호 포함"
          numeric
          defaultValue={v("pnl")}
          suspect={suspect.has("pnl")}
        />
        <Field
          name="fee"
          label="거래 수수료"
          hint="체결 비용"
          numeric
          defaultValue={v("fee")}
          suspect={suspect.has("fee")}
        />
        <Field
          name="funding_fee"
          label="펀딩비"
          hint="보유 비용"
          numeric
          defaultValue={v("funding_fee")}
        />
      </Section>

      <Section title="자금 · 포지션">
        <Field name="equity_before" label="진입 전 자금" numeric defaultValue={v("equity_before")} />
        <Field
          name="equity_after"
          label="청산 후 자금"
          hint="비우면 자동 계산"
          numeric
          defaultValue={v("equity_after")}
          suspect={suspect.has("equity_after")}
        />
        <Field name="withdrawal" label="출금" numeric defaultValue={v("withdrawal")} />
        <Field
          name="notional"
          label="투입 (명목가)"
          numeric
          defaultValue={v("notional")}
          suspect={suspect.has("notional")}
        />
        <Field
          name="leverage"
          label="레버리지 (Lv)"
          numeric
          defaultValue={v("leverage")}
          suspect={suspect.has("leverage")}
        />
        <div>
          <label className={LABEL} htmlFor="f-margin_mode">
            마진 모드
          </label>
          <select
            id="f-margin_mode"
            name="margin_mode"
            defaultValue={v("margin_mode")}
            className={INPUT}
          >
            <option value="">미지정</option>
            <option value="cross">교차 (Cross)</option>
            <option value="isolated">격리 (Isolated)</option>
          </select>
        </div>
      </Section>

      <Section title="가격 · 목표">
        <Field
          name="entry_price"
          label="진입가"
          numeric
          defaultValue={v("entry_price")}
          suspect={suspect.has("entry_price")}
        />
        <Field
          name="exit_price"
          label="청산가"
          numeric
          defaultValue={v("exit_price")}
          suspect={suspect.has("exit_price")}
        />
        <Field name="stop_price" label="손절가" numeric defaultValue={v("stop_price")} />
        <Field name="tp1_price" label="TP1 (익절1)" numeric defaultValue={v("tp1_price")} />
        <Field name="tp2_price" label="TP2" numeric defaultValue={v("tp2_price")} />
        <Field name="tp3_price" label="TP3" numeric defaultValue={v("tp3_price")} />
        {/* 비중은 셋 다 비우면 균등, 하나라도 적으면 빈 칸은 0 이다 — 합이 안 맞으면 아래 경고. */}
        <Field name="tp1_pct" label="TP1 비중 %" hint="비우면 균등" numeric defaultValue={v("tp1_pct")} />
        <Field name="tp2_pct" label="TP2 비중 %" numeric defaultValue={v("tp2_pct")} />
        <Field name="tp3_pct" label="TP3 비중 %" numeric defaultValue={v("tp3_pct")} />
        {tpNote ? (
          <p className="sm:col-span-3 rounded-lg border border-beta/50 bg-beta/10 px-3 py-2 text-xs text-beta">
            ⚠ {tpNote}
          </p>
        ) : null}
      </Section>

      <Section title="복기">
        <SuggestField
          name="setup"
          label="기준 (셋업)"
          defaultValue={v("setup")}
          options={suggestions.setup}
        />
        <SuggestField
          name="emotion"
          label="감정"
          hint="같은 말로 적어야 감정별 통계가 묶인다"
          defaultValue={v("emotion")}
          options={suggestions.emotion}
        />
        <SuggestTextarea
          name="rationale"
          label="근거"
          rows={3}
          defaultValue={v("rationale")}
          options={suggestions.rationale}
        />
        <SuggestTextarea
          name="review"
          label="복기"
          rows={4}
          defaultValue={v("review")}
          options={suggestions.review}
        />
        <div className="sm:col-span-3">
          <label className={LABEL} htmlFor="f-note">
            비고
          </label>
          <input id="f-note" name="note" defaultValue={v("note")} className={INPUT} />
        </div>
      </Section>

      {check && !check.ok ? (
        <p className="rounded-lg border border-beta/50 bg-beta/10 px-3 py-2 text-xs text-beta">
          ⚠ 투입·진입가·청산가로 계산한 손익은{" "}
          <b className="tnum">
            {check.expected > 0 ? "+" : ""}
            {check.expected.toFixed(2)}
          </b>
          인데 입력값은{" "}
          <b className="tnum">
            {check.actual > 0 ? "+" : ""}
            {check.actual.toFixed(2)}
          </b>
          입니다.
          {check.signFlipped
            ? " 부호가 반대입니다 — 방향(롱/숏)을 잘못 읽었을 수 있습니다."
            : " 숫자를 확인해 주세요."}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Submit label={trade ? "수정 저장" : "거래 저장"} />
        {state.error ? <span className="text-sm text-loss">{state.error}</span> : null}
      </div>
    </form>
  );
}
