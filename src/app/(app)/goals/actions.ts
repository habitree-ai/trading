"use server";

import { revalidatePath } from "next/cache";

import { goalsFromPlan, PLAN_DEFAULT, type PlanTier } from "@/lib/compound-plan";
import { getActiveBook, upsertGoals } from "@/lib/queries";

export interface PlanFormState {
  error?: string;
  message?: string;
}

/** 폼의 % 칸 → 소수. 범위 밖이면 null — 조용히 기본값으로 바꾸면 사용자가 무엇을 저장했는지 모른다. */
function parsePct(value: FormDataEntryValue | null, min: number, max: number): number | null {
  const n = Number(String(value ?? "").trim());
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n / 100;
}

/**
 * 계획 β / 목표 α 저장 — 북은 폼이 아니라 세션의 활성 북이다. 폼에 북 id 를 실으면
 * 다른 북의 목표를 바꿔 넣을 길이 생긴다(RLS 는 소유자만 볼 뿐 북 소속은 안 본다).
 */
export async function savePlanGoals(
  _prev: PlanFormState,
  formData: FormData,
): Promise<PlanFormState> {
  const book = await getActiveBook();
  if (!book) return { error: "활성 북이 없습니다." };

  const betaMonthly = parsePct(formData.get("beta_monthly"), 0, 100);
  const alphaMonthly = parsePct(formData.get("alpha_monthly"), 0, 100);
  const stop = parsePct(formData.get("stop_drawdown"), 1, 100);
  const betaRisk = parsePct(formData.get("beta_risk"), 0, 100);
  const alphaRisk = parsePct(formData.get("alpha_risk"), 0, 100);
  if (betaMonthly === null || alphaMonthly === null) return { error: "월수익률은 0~100% 사이 숫자여야 합니다." };
  if (stop === null) return { error: "정지선은 1~100% 사이 숫자여야 합니다." };
  if (betaRisk === null || alphaRisk === null) return { error: "거래당 리스크는 0~100% 사이 숫자여야 합니다." };
  if (alphaMonthly < betaMonthly) return { error: "목표 α는 계획 β보다 낮을 수 없습니다." };

  const beta: PlanTier = {
    ...PLAN_DEFAULT.beta,
    monthly: betaMonthly,
    stopDrawdown: stop,
    riskPerTrade: betaRisk,
  };
  const alpha: PlanTier = {
    ...PLAN_DEFAULT.alpha,
    monthly: alphaMonthly,
    stopDrawdown: stop,
    riskPerTrade: alphaRisk,
  };

  try {
    await upsertGoals(book.id, goalsFromPlan({ beta, alpha }));
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : "저장에 실패했습니다." };
  }

  revalidatePath("/goals");
  return { message: "저장했습니다. 이번 달 판정이 새 기준으로 다시 계산됩니다." };
}
