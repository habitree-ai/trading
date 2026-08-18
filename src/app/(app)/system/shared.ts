import type { ModeTabItem } from "@/app/(app)/system/mode-tabs";
import {
  SYSTEM_MODE_META,
  listActiveModes,
  readModeCounts,
  type SystemMode,
} from "@/lib/system-trading";

export interface ModeSelection {
  modes: SystemMode[];
  current: SystemMode;
  items: ModeTabItem[];
}

/**
 * 시스템 화면 셋(현황·거래·판정)이 공유하는 모드 결정.
 *
 * 실제로 돈 모드만 후보로 세우고, 쿼리로 지정된 모드가 그 안에 없으면 첫 번째로
 * 떨어뜨린다 — 손으로 고친 URL이 빈 화면을 열지 않게. 후보가 아예 없으면 null 이고,
 * 그건 "봇이 한 번도 안 돌았다"는 뜻이다.
 */
export async function resolveModes(requested?: string): Promise<ModeSelection | null> {
  const modes = await listActiveModes();
  if (modes.length === 0) return null;

  const counts = await readModeCounts();
  const current = modes.find((m) => m === requested) ?? modes[0];

  return {
    modes,
    current,
    items: modes.map((mode) => ({
      mode,
      meta: SYSTEM_MODE_META[mode],
      closed: counts[mode]?.closed ?? 0,
      open: counts[mode]?.open ?? 0,
    })),
  };
}

/** 기준(member) 코드 → 사람이 읽는 이름. 봇이 name 을 안 남긴 행의 대비책. */
export const MEMBER_LABEL: Record<string, string> = {
  gc: "골든크로스",
  ob: "RSI 과매도",
  fade: "RSI 과매수",
  dc: "20봉 신저가",
};

export const EXIT_LABEL: Record<string, string> = {
  tp: "목표 도달",
  sl: "손절",
  time: "시한 만료",
  algo: "브래킷",
  unknown: "미상",
};
