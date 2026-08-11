"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { calibrateBook, type BookFormState } from "@/app/(app)/books/actions";
import { DASH, num, pct, signed } from "@/lib/format";
import type { EquityReconcile } from "@/lib/reconcile";
import { TONE_CLASS } from "@/lib/verdict";

const INPUT =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent";
const LABEL = "block text-xs text-dim mb-1";

/** 입력칸에 넣을 문자열 — 부동소수점 꼬리를 자르되 유효숫자는 남긴다. */
function toInput(value: number): string {
  return String(Number(value.toFixed(6)));
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? "맞추는 중…" : "초기 세팅 맞추기"}
    </button>
  );
}

function Row({
  label,
  value,
  hint,
  strong = false,
  className = "",
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
  className?: string;
}) {
  return (
    <div className="flex items-baseline gap-3 py-1">
      <span className={`text-xs ${strong ? "text-text" : "text-dim"}`}>{label}</span>
      {hint ? <span className="text-[10px] text-dim">{hint}</span> : null}
      <span
        className={`tnum ml-auto ${strong ? "text-sm font-medium" : "text-xs"} ${className}`}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * 자금 대조 — 화면의 `현재자금`이 어떤 항을 더해 만들어졌는지 펼쳐 보인다.
 *
 * "거래소와 다릅니다"라는 경고만으로는 손댈 곳을 못 찾는다. 네 항(초기자금·실현손익·
 * 순이체·출금) 가운데 어느 쪽이 틀렸는지 짚고, 초기자금을 얼마로 두면 맞아떨어지는지
 * 계산해 그 자리에서 고치게 한다.
 *
 * 초기자금은 **시작일 0시의 거래계좌 잔액**이다. 이걸 "이체가 끝난 뒤의 잔고"로 잡으면
 * 같은 돈이 동기화로 한 번 더 들어와 자금이 두 배로 뛴다.
 */
export function CapitalAudit({
  bookId,
  startDate,
  currency,
  report,
}: {
  bookId: string;
  startDate: string;
  currency: string;
  report: EquityReconcile;
}) {
  const [state, action] = useActionState<BookFormState, FormData>(calibrateBook, {});
  const suggested = report.suggestedInitialCapital;

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h3 className="text-sm font-medium">
        자금 대조{" "}
        <span className="font-normal text-dim">
          — 현재자금이 어떻게 만들어졌고 거래소와 어디서 갈리는지 ({currency})
        </span>
      </h3>

      <div className="mt-3 divide-y divide-border">
        <Row label="초기자금" hint={`${startDate} 0시 거래계좌 잔액`} value={num(report.initialCapital)} />
        <Row label="＋ 누적 실현손익" value={signed(report.netPnl)} />
        <Row label="＋ 거래계좌 순이체" value={signed(report.netTransfer)} />
        <Row label="− 거래 출금" value={num(report.tradeWithdrawal)} />
        <Row label="＝ 계산 자금" value={num(report.computedEquity)} strong />
        <Row
          label="거래소 잔고 (정산 기준)"
          hint={
            report.unrealizedPnl !== null && report.unrealizedPnl !== 0
              ? `미청산 ${signed(report.unrealizedPnl)} 제외`
              : undefined
          }
          value={report.settled === null ? DASH : num(report.settled)}
        />
        <Row
          label="차이"
          value={
            report.diff === null
              ? DASH
              : `${signed(report.diff)}${report.diffPct === null ? "" : ` (${pct(report.diffPct, 1)})`}`
          }
          strong
          className={TONE_CLASS[report.tone]}
        />
      </div>

      <ul className="mt-3 space-y-2">
        {report.notes.map((note) => (
          <li key={note.code} className="text-[11px] leading-snug">
            <span className={TONE_CLASS[note.tone]}>{note.text}</span>
            {note.fix ? <span className="block text-dim">→ {note.fix}</span> : null}
          </li>
        ))}
      </ul>

      {/* 어긋나 있을 때는 펼쳐 둔다 — 맞아떨어지는 북에서까지 고칠 자리를 내밀 이유는 없다. */}
      <details className="mt-3 border-t border-border pt-3" open={report.tone !== "good"}>
        <summary className="cursor-pointer text-xs text-accent">초기 세팅 보정</summary>

        <form action={action} className="mt-3 space-y-3">
          <input type="hidden" name="book_id" value={bookId} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor="audit-capital">
                초기자금
              </label>
              <input
                id="audit-capital"
                className={`${INPUT} tnum`}
                name="initial_capital"
                inputMode="decimal"
                defaultValue={toInput(suggested ?? report.initialCapital)}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="audit-start">
                시작일
              </label>
              <input
                id="audit-start"
                className={INPUT}
                name="start_date"
                type="date"
                defaultValue={startDate}
              />
            </div>
          </div>

          {suggested === null ? null : (
            <p className="text-[11px] text-dim">
              제안값 <span className="tnum text-text">{num(suggested)}</span> = 거래소 잔고 −
              누적 실현손익 − 순이체 + 출금. 이 값을 넣으면 계산 자금이 거래소 잔고와
              같아집니다. 조회 구간 밖의 거래·이체가 있다면 그 몫까지 초기자금에 담기는
              셈이니, 그 이전 성과는 이 북의 수익률에서 빠집니다.
            </p>
          )}

          <div className="flex items-center gap-3">
            <Submit />
            {state.error ? <span className="text-sm text-loss">{state.error}</span> : null}
            {state.message ? <span className="text-sm text-profit">{state.message}</span> : null}
          </div>
        </form>
      </details>
    </section>
  );
}
