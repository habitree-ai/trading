"use server";

import { revalidatePath } from "next/cache";

import { deployGuard } from "@/lib/okx-live";
import { requireUser } from "@/lib/queries";
import type { SystemMode } from "@/lib/system-trading";

/**
 * 라이브 킬스위치 — 서버 사이클(`/api/cron/quad`)이 실주문을 낼지 정하는 단 하나의 게이트.
 *
 * 로컬 PC 에서 봇을 돌리던 시절의 게이트는 실행기 안의 환경변수(LIVE_TRADING_ACK)였다.
 * 그건 사람이 그 PC 앞에 있을 때만 뜻이 있는 잠금이다 — 서버에 올리는 순간 상시 켜짐이
 * 되어 잠글 방법이 없어진다. 그래서 `0019_system_trading.sql` 이 이 칸을 미리 잡아 뒀고,
 * 사이클을 서버로 옮기면서 그 자리가 실제 게이트가 됐다.
 *
 * 화면에서 끌 수 없는 킬스위치는 킬스위치가 아니다 — 이 액션이 그 손잡이다.
 */

export interface KillSwitchResult {
  error?: string;
  enabled?: boolean;
}

export async function setLiveEnabled(
  mode: SystemMode,
  enabled: boolean,
): Promise<KillSwitchResult> {
  const { supabase } = await requireUser();

  // 켜는 방향에만 문턱을 둔다. 끄는 것은 언제나 한 번에 되어야 한다 —
  // 안전한 방향으로 가는 길에 조건을 달면 급할 때 그 조건이 사고가 된다.
  if (enabled) {
    const blocked = deployGuard();
    if (blocked) return { error: blocked };
  }

  const { data, error } = await supabase
    .from("system_state")
    .update({ live_enabled: enabled })
    .eq("mode", mode)
    .select("live_enabled")
    .maybeSingle();

  if (error) return { error: `킬스위치 변경 실패: ${error.message}` };
  if (!data) {
    return { error: "이 모드의 상태 행이 아직 없습니다 — 사이클이 한 번 돈 뒤에 켤 수 있습니다." };
  }

  revalidatePath("/", "layout");
  return { enabled: data.live_enabled };
}
