"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { createTrade, updateTrade, type TradeFormState } from "@/app/(app)/trades/actions";
import type { Trade } from "@/lib/domain";
import type { Prefill } from "@/lib/extract/to-prefill";
import type { ExtractedFill } from "@/lib/extract/types";
import { toLocalInput } from "@/lib/format";
import { crossCheckPnl, type PnlCrossCheck } from "@/lib/metrics";

/** 폼에 지금 들어 있는 값으로 손익 교차검증을 돌린다. */
function readCrossCheck(form: HTMLFormElement, side: "long" | "short"): PnlCrossCheck | null {
  const data = new FormData(form);
  const n = (key: string): number | null => {
    const raw = String(data.get(key) ?? "").trim().replace(/,/g, "");
    if (raw === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return crossCheckPnl({
    side,
    notional: n("notional"),
    entry_price: n("entry_price"),
    exit_price: n("exit_price"),
    pnl: n("pnl"),
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
}: {
  bookId: string;
  trade?: Trade;
  prefill?: Prefill;
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
      onInput={(e) => setCheck(readCrossCheck(e.currentTarget, side))}
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
          label="수수료"
          hint="보통 음수"
          numeric
          defaultValue={v("fee")}
          suspect={suspect.has("fee")}
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
      </Section>

      <Section title="복기">
        <Field name="setup" label="기준 (셋업)" defaultValue={v("setup")} />
        <Field name="rationale" label="근거" defaultValue={v("rationale")} />
        <Field name="emotion" label="감정" defaultValue={v("emotion")} />
        <div className="sm:col-span-3">
          <label className={LABEL} htmlFor="f-review">
            복기
          </label>
          <textarea
            id="f-review"
            name="review"
            rows={3}
            defaultValue={v("review")}
            className={INPUT}
          />
        </div>
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
