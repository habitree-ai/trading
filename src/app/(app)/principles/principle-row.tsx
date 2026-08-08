"use client";

import { useState, useTransition } from "react";

import {
  deletePrinciple,
  movePrinciple,
  setPrincipleActive,
  updatePrinciple,
} from "@/app/(app)/principles/actions";
import { PRINCIPLE_CATEGORIES, PRINCIPLE_CATEGORY_LABEL, type Principle } from "@/lib/domain";
import { pct, signed } from "@/lib/format";

const INPUT =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent";

/** 이 원칙이 실제로 어떻게 지켜졌는지 — 복기에서 계산해 넘겨준다. */
export interface PrincipleStats {
  /** 지켰는지 어겼는지 판단한 거래 수 */
  judged: number;
  /** 그중 어긴 거래 수 */
  broken: number;
  /** 어긴 거래들의 손익 합계. 판단이 없으면 null */
  brokenPnl: number | null;
}

export function PrincipleRow({
  principle,
  stats,
  isFirst,
  isLast,
  currency,
}: {
  principle: Principle;
  stats: PrincipleStats;
  isFirst: boolean;
  isLast: boolean;
  currency: string;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<void>) => startTransition(() => void fn());

  // 저장에 성공하면 폼을 닫는다 — 결과를 보고 닫아야 하므로 액션 안에서 처리한다.
  async function save(formData: FormData) {
    const result = await updatePrinciple({}, formData);
    if (result.error) setError(result.error);
    else {
      setError(null);
      setEditing(false);
    }
  }
  const keptRate = stats.judged === 0 ? null : (stats.judged - stats.broken) / stats.judged;

  if (editing) {
    return (
      <form action={save} className="rounded-lg border border-accent bg-surface p-3">
        <input type="hidden" name="principle_id" value={principle.id} />
        <div className="grid gap-2 sm:grid-cols-[8rem_1fr]">
          <select name="category" className={INPUT} defaultValue={principle.category}>
            {PRINCIPLE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {PRINCIPLE_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <input name="title" className={INPUT} defaultValue={principle.title} required />
        </div>
        <textarea
          name="detail"
          rows={2}
          className={`${INPUT} mt-2`}
          defaultValue={principle.detail ?? ""}
          placeholder="왜 이 원칙인지"
        />
        <div className="mt-2 flex items-center gap-2 text-xs">
          <button
            type="submit"
            className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white"
          >
            저장
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setEditing(false);
            }}
            className="rounded-lg border border-border px-3 py-1.5 text-dim hover:text-text"
          >
            취소
          </button>
          {error ? <span className="text-loss">{error}</span> : null}
        </div>
      </form>
    );
  }

  return (
    <article
      className={`rounded-lg border border-border bg-surface p-3 ${
        principle.active ? "" : "opacity-60"
      }`}
    >
      <div className="flex flex-wrap items-start gap-2">
        <p className={`text-sm ${principle.active ? "" : "line-through decoration-dim"}`}>
          {principle.title}
        </p>
        {principle.active ? null : (
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-dim">보관</span>
        )}
      </div>

      {principle.detail ? (
        <p className="mt-1 text-xs whitespace-pre-line text-dim">{principle.detail}</p>
      ) : null}

      {/* 지킨 비율과 어겼을 때의 손익 — 원칙이 값을 하는지 여기서 갈린다. */}
      <p className="tnum mt-2 text-[11px] text-dim">
        {stats.judged === 0 ? (
          "아직 판단한 거래가 없습니다"
        ) : (
          <>
            판단 {stats.judged}건 · 지킴 {pct(keptRate, 0)}
            {stats.broken > 0 ? (
              <>
                {" · "}
                <span className="text-loss">어김 {stats.broken}건</span>
                {stats.brokenPnl === null ? null : (
                  <>
                    {" ("}
                    <span className={stats.brokenPnl < 0 ? "text-loss" : "text-profit"}>
                      {signed(stats.brokenPnl, 1)} {currency}
                    </span>
                    {")"}
                  </>
                )}
              </>
            ) : null}
          </>
        )}
      </p>

      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        <Action onClick={() => run(() => movePrinciple(principle.id, "up"))} disabled={pending || isFirst}>
          ↑
        </Action>
        <Action
          onClick={() => run(() => movePrinciple(principle.id, "down"))}
          disabled={pending || isLast}
        >
          ↓
        </Action>
        <Action onClick={() => setEditing(true)} disabled={pending}>
          수정
        </Action>
        <Action
          onClick={() => run(() => setPrincipleActive(principle.id, !principle.active))}
          disabled={pending}
        >
          {principle.active ? "보관" : "다시 쓰기"}
        </Action>
        <Action
          danger
          disabled={pending}
          onClick={() => {
            const ok = window.confirm(
              stats.judged > 0
                ? `이 원칙과 거래 ${stats.judged}건에 남긴 준수 기록이 함께 삭제됩니다. 더 안 쓰는 원칙이라면 '보관'을 쓰면 기록이 남습니다. 계속할까요?`
                : "이 원칙을 삭제합니다. 계속할까요?",
            );
            if (ok) run(() => deletePrinciple(principle.id));
          }}
        >
          삭제
        </Action>
      </div>
    </article>
  );
}

function Action({
  children,
  onClick,
  disabled,
  danger = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-2.5 py-1 disabled:opacity-40 ${
        danger ? "border-loss/40 text-loss" : "border-border text-dim hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
