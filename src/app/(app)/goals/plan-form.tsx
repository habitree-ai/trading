"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { savePlanGoals, type PlanFormState } from "@/app/(app)/goals/actions";
import type { PlanTier } from "@/lib/compound-plan";

const INPUT =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent tnum";
const LABEL = "block text-xs text-dim mb-1";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? "저장하는 중…" : "계획 저장"}
    </button>
  );
}

/** 소수 → 폼의 % 문자열. 0.02 → "2", 0.0503 → "5.03" */
function pctInput(v: number): string {
  return String(Math.round(v * 10000) / 100);
}

/**
 * 계획 β / 목표 α 편집 — 정지선은 하나다. α 칸에 정지선이 없는 것은 실수가 아니라 규칙이다.
 */
export function PlanForm({ beta, alpha }: { beta: PlanTier; alpha: PlanTier }) {
  const [state, action] = useActionState<PlanFormState, FormData>(savePlanGoals, {});

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset className="space-y-3 rounded-xl border border-border bg-surface p-4">
          <legend className="px-1 text-sm font-medium">계획 β — 반드시 지킬 것</legend>
          <div>
            <label className={LABEL} htmlFor="beta_monthly">
              월수익률 (%)
            </label>
            <input id="beta_monthly" name="beta_monthly" type="number" step="0.01" min="0" max="100" defaultValue={pctInput(beta.monthly)} className={INPUT} required />
          </div>
          <div>
            <label className={LABEL} htmlFor="beta_risk">
              거래당 리스크 상한 (%)
            </label>
            <input id="beta_risk" name="beta_risk" type="number" step="0.1" min="0" max="100" defaultValue={pctInput(beta.riskPerTrade)} className={INPUT} required />
          </div>
          <div>
            <label className={LABEL} htmlFor="stop_drawdown">
              정지선 — 고점 대비 월 낙폭 (%)
            </label>
            <input id="stop_drawdown" name="stop_drawdown" type="number" step="1" min="1" max="100" defaultValue={pctInput(beta.stopDrawdown)} className={INPUT} required />
            <p className="mt-1 text-[11px] leading-snug text-dim">
              닿으면 그 달 매매 중단. α에도 같은 값이 적용됩니다 — 도전이 정지선을 옮기지는 않습니다.
            </p>
          </div>
        </fieldset>

        <fieldset className="space-y-3 rounded-xl border border-border bg-surface p-4">
          <legend className="px-1 text-sm font-medium">목표 α — 도전</legend>
          <div>
            <label className={LABEL} htmlFor="alpha_monthly">
              월수익률 (%)
            </label>
            <input id="alpha_monthly" name="alpha_monthly" type="number" step="0.01" min="0" max="100" defaultValue={pctInput(alpha.monthly)} className={INPUT} required />
          </div>
          <div>
            <label className={LABEL} htmlFor="alpha_risk">
              거래당 리스크 상한 (%)
            </label>
            <input id="alpha_risk" name="alpha_risk" type="number" step="0.1" min="0" max="100" defaultValue={pctInput(alpha.riskPerTrade)} className={INPUT} required />
          </div>
          <p className="text-[11px] leading-snug text-dim">
            레버리지 상한 {alpha.leverageCap}배는 저장 항목이 아니라 상수입니다 — 복리 회차에서
            10배 이상은 1,944설정 중 0건이 살아남았습니다.
          </p>
        </fieldset>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Submit />
        {state.error ? <p className="text-sm text-loss">{state.error}</p> : null}
        {state.message ? <p className="text-sm text-profit">{state.message}</p> : null}
      </div>
    </form>
  );
}
