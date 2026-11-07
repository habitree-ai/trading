"use server";

import { revalidatePath } from "next/cache";

import type { Trade } from "@/lib/domain";
import { parseChecklist, type CheckItem, type LegSignals } from "@/lib/legs";
import { isOpenTrade } from "@/lib/metrics";
import { requireUser } from "@/lib/queries";
import type { Json } from "@/lib/supabase/database.types";
import { collectThreshold, toLegSignals } from "@/lib/threshold";

export interface RecordLegInput {
  tradeId: string;
  /** 추가가(의도) */
  price: number;
  /** 코인 수량 */
  qty: number;
  zoneR: number | null;
  commonStop: number | null;
  checklist: CheckItem[];
  note: string | null;
}

export type RecordLegResult = { ok: true; legNo: number } | { ok: false; error: string };

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * 다리 기록 — 추가를 결정한 순간의 의도·구간·공통 손절·체크리스트와 그 순간 임계점 값을 남긴다(REQ-0102).
 * 체크리스트 미통과여도 남긴다(D9). 임계점 수집이 실패해도 기록은 signals 없이 저장한다.
 * 체결 연결은 하지 않는다 — 화면이 시각 근접으로 잇는다(D7).
 */
export async function recordLeg(input: RecordLegInput): Promise<RecordLegResult> {
  const { tradeId } = input;
  if (typeof tradeId !== "string" || tradeId === "") return { ok: false, error: "거래를 골라 주세요." };
  if (!positive(input.price) || !positive(input.qty)) return { ok: false, error: "추가가와 수량을 넣어 주세요." };
  if (!(input.commonStop === null || positive(input.commonStop))) return { ok: false, error: "공통 손절이 이상합니다." };
  if (!(input.zoneR === null || (typeof input.zoneR === "number" && Number.isFinite(input.zoneR)))) {
    return { ok: false, error: "구간이 이상합니다." };
  }
  // 클라이언트가 보낸 값이라 형태를 다시 확인한다.
  const checklist = parseChecklist(input.checklist);
  if (checklist === null || checklist.length !== 8) return { ok: false, error: "체크리스트가 8줄이 아닙니다." };
  const note = typeof input.note === "string" && input.note.trim() !== "" ? input.note.trim() : null;

  const { supabase, user } = await requireUser();
  const { data: trade, error: tradeError } = await supabase
    .from("trades")
    .select("*")
    .eq("id", tradeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (tradeError) return { ok: false, error: tradeError.message };
  if (!trade) return { ok: false, error: "거래를 찾을 수 없습니다." };
  if (!isOpenTrade(trade as Trade)) return { ok: false, error: "청산된 거래에는 다리를 기록할 수 없습니다." };

  const { data: last, error: lastError } = await supabase
    .from("trade_legs")
    .select("leg_no")
    .eq("trade_id", tradeId)
    .order("leg_no", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) return { ok: false, error: lastError.message };
  const legNo = (last?.leg_no ?? 0) + 1;

  let signals: LegSignals | null = null;
  try {
    signals = toLegSignals(await collectThreshold(trade.symbol), trade.side as Trade["side"]);
  } catch {
    // 시장 지표는 없어도 추가 기록 자체는 남긴다
    signals = null;
  }

  const { error } = await supabase.from("trade_legs").insert({
    user_id: user.id,
    trade_id: tradeId,
    leg_no: legNo,
    at: new Date().toISOString(),
    price: input.price,
    qty: input.qty,
    zone_r: input.zoneR,
    common_stop: input.commonStop,
    signals: signals as Json | null,
    checklist: checklist as unknown as Json,
    note,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/kelly");
  revalidatePath(`/trades/${tradeId}`);
  return { ok: true, legNo };
}
