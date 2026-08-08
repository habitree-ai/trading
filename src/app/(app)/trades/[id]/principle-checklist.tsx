"use client";

import { useOptimistic, useTransition } from "react";

import { setPrincipleCheck } from "@/app/(app)/principles/actions";
import {
  PRINCIPLE_CATEGORY_LABEL,
  type Principle,
  type TradePrincipleCheck,
} from "@/lib/domain";

/**
 * 거래 하나의 원칙 체크리스트.
 *
 * 상태가 셋이다 — 지킴 / 어김 / 아직 안 봄. 둘로 줄이면(체크박스) 안 본 것과 어긴 것이
 * 한 칸에 섞여, 복기에서 위반 통계를 그대로 못 믿게 된다. 같은 버튼을 다시 누르면
 * 판단이 지워져 '안 봄'으로 돌아간다.
 */
export function PrincipleChecklist({
  tradeId,
  principles,
  checks,
}: {
  tradeId: string;
  principles: Principle[];
  checks: TradePrincipleCheck[];
}) {
  const saved = new Map(checks.map((c) => [c.principle_id, c.kept]));
  const [pending, startTransition] = useTransition();

  // 서버 왕복을 기다리는 동안 눌린 버튼이 그대로 있어야 한다 — 목록이 길면 왕복이 티가 난다.
  const [state, apply] = useOptimistic(
    saved,
    (current, next: { id: string; kept: boolean | null }) => {
      const draft = new Map(current);
      if (next.kept === null) draft.delete(next.id);
      else draft.set(next.id, next.kept);
      return draft;
    },
  );

  if (principles.length === 0) {
    return (
      <p className="text-sm text-dim">
        아직 원칙이 없습니다. 원칙 탭에서 지키기로 한 규칙을 적어 두면 여기에 체크리스트로
        뜹니다.
      </p>
    );
  }

  const judged = principles.filter((p) => state.has(p.id)).length;
  const broken = principles.filter((p) => state.get(p.id) === false).length;

  const set = (id: string, kept: boolean) => {
    // 같은 버튼을 다시 누르면 판단을 지운다.
    const next = state.get(id) === kept ? null : kept;
    startTransition(async () => {
      apply({ id, kept: next });
      await setPrincipleCheck(tradeId, id, next);
    });
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-dim">
        {judged}/{principles.length} 판단
        {broken > 0 ? <span className="ml-1.5 text-loss">· {broken}개 어김</span> : null}
      </p>

      <ul className="space-y-1.5">
        {principles.map((p) => {
          const value = state.get(p.id);
          return (
            <li
              key={p.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2"
            >
              <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-dim">
                {PRINCIPLE_CATEGORY_LABEL[p.category]}
              </span>
              <span className={`text-sm ${value === false ? "text-loss" : ""}`}>{p.title}</span>
              <div className="ml-auto flex shrink-0 gap-1">
                <Choice
                  active={value === true}
                  tone="profit"
                  disabled={pending}
                  onClick={() => set(p.id, true)}
                >
                  지킴
                </Choice>
                <Choice
                  active={value === false}
                  tone="loss"
                  disabled={pending}
                  onClick={() => set(p.id, false)}
                >
                  어김
                </Choice>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Choice({
  children,
  active,
  tone,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  tone: "profit" | "loss";
  disabled: boolean;
  onClick: () => void;
}) {
  const on =
    tone === "profit"
      ? "border-profit bg-profit/10 text-profit"
      : "border-loss bg-loss/10 text-loss";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`rounded-lg border px-2.5 py-1 text-xs disabled:opacity-50 ${
        active ? on : "border-border text-dim hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
