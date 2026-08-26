"use server";

import { revalidatePath } from "next/cache";

import { insertPrinciple } from "@/app/(app)/principles/actions";
import { PRINCIPLE_CATEGORIES, type PrincipleCategory } from "@/lib/domain";
import { listPrinciples, requireUser } from "@/lib/queries";
import { seedTagLine, seedTagOf } from "@/lib/okx-diagnosis";

export interface SeedState {
  error?: string;
  message?: string;
}

/**
 * 진단의 발견 하나를 원칙으로 옮긴다.
 *
 * 자동으로 넣지 않고 폼을 거치는 이유: 문구를 본인이 고쳐야 지킬 수 있는 규칙이 된다.
 * 앱이 채우는 것은 근거(`detail`)뿐이고, 그 근거에는 회차·수치·발견 id 가 박힌다 —
 * 나중에 이 원칙이 어디서 왔는지 되짚을 자리가 그 줄밖에 없다.
 *
 * **과거 거래에는 소급되지 않는다.** 진단이 보는 4,023 포지션과 앱의 거래 기록은
 * 열쇠가 이어져 있지 않다(`okx_pos_id` 가 채워진 행이 11개). 등록 뒤 새로 적는
 * 거래부터 체크 대상이 되고, 증거는 체크 기록이 아니라 다음 회차 원장의 숫자다.
 */
export async function seedPrincipleFromFinding(
  _prev: SeedState,
  formData: FormData,
): Promise<SeedState> {
  const bookId = String(formData.get("book_id") ?? "");
  if (!bookId) return { error: "북을 먼저 만들어야 원칙을 적을 수 있습니다." };

  const findingId = String(formData.get("finding_id") ?? "");
  if (!findingId) return { error: "발견을 찾을 수 없습니다." };

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { error: "원칙 내용을 입력해 주세요." };

  const rawCategory = String(formData.get("category") ?? "");
  const category: PrincipleCategory = (PRINCIPLE_CATEGORIES as string[]).includes(rawCategory)
    ? (rawCategory as PrincipleCategory)
    : "risk";

  // 같은 발견에서 이미 옮긴 원칙이 있으면 두 번 넣지 않는다 — 마커로 찾는다.
  await requireUser();
  const existing = await listPrinciples(bookId);
  if (existing.some((p) => seedTagOf(p.detail) === findingId)) {
    return { error: "이미 이 발견에서 옮긴 원칙이 있습니다." };
  }

  const evidence = String(formData.get("detail") ?? "").trim();
  const detail = `${evidence}\n${seedTagLine(findingId)}`;

  const { error } = await insertPrinciple({ bookId, category, title, detail });
  if (error) return { error };

  revalidatePath("/", "layout");
  return { message: "원칙으로 옮겼습니다 — 다음 거래부터 체크리스트에 뜹니다." };
}
