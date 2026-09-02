"use server";

import { revalidatePath } from "next/cache";

import { readOrderStatus } from "@/app/(app)/order/status";
import {
  isAnnotationColor,
  isAnnotationKind,
  isAnnotationLineStyle,
  normalizePoints,
  parsePoints,
} from "@/lib/annotations";
import {
  isPositionKind,
  type AnnotationColor,
  type AnnotationKind,
  type AnnotationLineStyle,
  type ChartPoint,
  type Side,
} from "@/lib/domain";
import {
  attachedTarget,
  gateOpen,
  marginNeeded,
  planGate,
  sizeOrder,
} from "@/lib/manual-order";
import { toInstId } from "@/lib/okx";
import { baseSymbol } from "@/lib/okx/map";
import { deployGuard, instrument, lastPrice, manualClient, type OkxTradeClient } from "@/lib/okx-live";
import { positionProblemOf } from "@/lib/position-tool";
import { getActiveBook, nextSeq, requireUser } from "@/lib/queries";

/**
 * 근거 게이트 주문 — 근거·손절·목표가 전부 있어야 주 매매계정에 시장가 주문을 낸다.
 *
 * 화면의 게이트를 믿지 않고 여기서 같은 규칙(`planGate`)을 다시 돈다. 서버 액션은 폼을
 * 거치지 않고도 불릴 수 있다. 주문이 나간 뒤의 실패는 접수 번호를 반드시 같이 돌려준다 —
 * "실패"라는 말만 남으면 사람은 다시 누르고, 그러면 포지션이 둘이 된다.
 */

export interface ManualOrderState {
  error?: string;
  /** 주문은 나갔는데 기록에서 실패한 경우의 접수 번호 — 화면이 이걸 크게 보여 준다 */
  ordId?: string;
  ok?: { tradeId: string; ordId: string; detail: string };
}

function parseNumber(value: FormDataEntryValue | null): number | null {
  const raw = String(value ?? "")
    .trim()
    .replace(/,/g, "");
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseText(value: FormDataEntryValue | null): string {
  return String(value ?? "").trim();
}

interface ParsedAnnotation {
  kind: AnnotationKind;
  points: ChartPoint[];
  text: string | null;
  color: AnnotationColor;
  line_width: number | null;
  line_style: AnnotationLineStyle | null;
}

/**
 * 화면이 실어 보낸 차트 메모 — 저장 액션(`createAnnotation`)과 같은 검증을 한 건씩 한다.
 *
 * 한 건이라도 깨졌으면 전부 거절한다. 주문은 이미 나갔는데 근거 그림 절반만 남는 것보다
 * 주문 전에 멈추는 편이 낫다.
 */
function parseAnnotations(raw: FormDataEntryValue | null): ParsedAnnotation[] | { error: string } {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "차트 메모를 읽지 못했습니다 — 다시 그려 주세요." };
  }
  if (!Array.isArray(parsed)) return { error: "차트 메모 형식이 올바르지 않습니다." };

  const out: ParsedAnnotation[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) return { error: "차트 메모 형식이 올바르지 않습니다." };
    const a = item as Record<string, unknown>;
    if (!isAnnotationKind(a.kind)) return { error: "알 수 없는 메모 종류가 있습니다." };
    const points = parsePoints(a.points, a.kind);
    if (points === null) return { error: "차트 메모 좌표를 읽지 못했습니다." };
    if (!isAnnotationColor(a.color)) return { error: "알 수 없는 메모 색이 있습니다." };
    const label = typeof a.text === "string" && a.text.trim() !== "" ? a.text.trim() : null;
    if (a.kind === "text" && label === null) return { error: "내용이 빈 텍스트 메모가 있습니다." };
    if (isPositionKind(a.kind)) {
      const problem = positionProblemOf(a.kind, points);
      if (problem !== null) return { error: `손익 툴: ${problem}` };
    }
    const width =
      typeof a.line_width === "number" && Number.isInteger(a.line_width) && a.line_width >= 1 && a.line_width <= 4
        ? a.line_width
        : null;
    const style = isAnnotationLineStyle(a.line_style) ? a.line_style : null;
    out.push({
      kind: a.kind,
      points: normalizePoints(a.kind, points),
      text: label,
      color: a.color,
      line_width: width,
      line_style: style,
    });
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 시장가는 보통 즉시 체결이지만 조회가 한 박자 늦을 수 있다 — 짧게 몇 번 되묻는다. */
async function waitFill(client: OkxTradeClient, instId: string, ordId: string) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const d = await client.orderDetails(instId, ordId);
    if (d && (d.state === "filled" || d.accFillSz > 0)) return d;
    await sleep(400);
  }
  return client.orderDetails(instId, ordId);
}

export async function placeManualOrder(
  _prev: ManualOrderState,
  formData: FormData,
): Promise<ManualOrderState> {
  const { supabase, user } = await requireUser(); // 로그인한 사용자의 명시적 클릭만 이 경로에 닿는다.

  // 2단계 확인 — 체크박스 없이 온 요청은 실행하지 않는다.
  if (formData.get("ack") !== "on") return { error: "실제 주문 확인에 체크해 주세요." };
  const blocked = deployGuard();
  if (blocked) return { error: blocked };

  const sideRaw = String(formData.get("side") ?? "");
  if (sideRaw !== "long" && sideRaw !== "short") return { error: "방향을 선택해 주세요." };
  const side: Side = sideRaw;
  const symbolRaw = parseText(formData.get("symbol")).toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(symbolRaw)) return { error: "종목명을 확인해 주세요 (예: BTC)." };

  const stop = parseNumber(formData.get("stop_price"));
  const targets = [
    parseNumber(formData.get("tp1_price")),
    parseNumber(formData.get("tp2_price")),
    parseNumber(formData.get("tp3_price")),
  ];
  const notionalUsd = parseNumber(formData.get("notional_usd"));
  const leverage = parseNumber(formData.get("leverage"));
  const setup = parseText(formData.get("setup"));
  const rationale = parseText(formData.get("rationale"));
  const emotion = parseText(formData.get("emotion"));

  const annotations = parseAnnotations(formData.get("annotations"));
  if ("error" in annotations) return { error: annotations.error };

  const book = await getActiveBook();
  if (!book) return { error: "북을 먼저 만들어 주세요." };

  // 계좌 불변식 — 화면이 보여 준 그 판정을 여기서 다시 한다.
  const status = await readOrderStatus(book);
  if (!status.hasKeys) return { error: "주문 키(OKX_MANUAL_*)가 설정돼 있지 않습니다." };
  if (status.errors.length > 0) return { error: status.errors.join(" / ") };
  if (!status.order || status.match !== true) return { error: "주문 계좌를 확인하지 못했습니다." };

  const client = manualClient();
  const instId = toInstId(symbolRaw);

  try {
    const [inst, px] = await Promise.all([instrument(instId), lastPrice(instId)]);
    const eq = status.order.equity;
    // NaN 은 부등호를 전부 통과한다(fail-open) — 숫자가 아니면 주문 자체를 거절한다.
    if (![eq, px, inst.minSz, inst.ctVal, inst.lotSz, inst.tickSz].every(Number.isFinite)) {
      return { error: "계좌·시세 응답이 온전하지 않습니다 — 잠시 후 다시 시도해 주세요." };
    }

    const minNotional = inst.minSz * inst.ctVal * px;
    const gate = planGate(
      { side, price: px, stop, targets, notionalUsd, leverage, setup, rationale },
      { minNotional },
    );
    if (!gateOpen(gate)) {
      const failed = gate.filter((g) => !g.ok).map((g) => `${g.label}: ${g.detail}`);
      return { error: `근거 게이트가 닫혀 있습니다 — ${failed.join(" · ")}` };
    }
    // 게이트를 지났으면 아래 값들은 있다.
    const lev = leverage as number;
    const sizing = sizeOrder({
      notionalUsd: notionalUsd as number,
      price: px,
      ctVal: inst.ctVal,
      lotSz: inst.lotSz,
      szDecimals: inst.szDecimals,
    });
    if (sizing.contracts < inst.minSz) {
      return { error: `계약 수가 최소(${inst.minSz})에 못 미칩니다 — 최소 명목가 ≈ ${minNotional.toFixed(2)} USDT.` };
    }
    const { need } = marginNeeded(sizing.notional, lev);
    if (eq < need) {
      return { error: `잔고 $${eq.toFixed(2)} — 이 주문에는 최소 $${need.toFixed(2)} 필요 (증거금 + 여유).` };
    }

    const target = attachedTarget(targets);
    const algoClOrdId = `qm${Date.now()}`; // 근거 게이트 주문 표식 — 배선 검증(qb)·봇(qa)과 구분

    await client.setLeverage(instId, lev, side);
    const ordId = await client.openWithBracket({
      instId,
      posSide: side,
      sz: sizing.sz,
      stop: stop as number,
      target,
      algoClOrdId,
      tickSz: inst.tickSz,
      pxDecimals: inst.pxDecimals,
    });

    /* ---- 여기서부터는 돈이 움직였다. 어떤 실패도 접수 번호와 함께 돌려준다. ---- */
    try {
      const detail = await waitFill(client, instId, ordId);
      const mine = (await client.positions(instId)).find((p) => p.posSide === side) ?? null;
      const entryPrice = detail?.avgPx ?? mine?.avgPx ?? px;
      const filledSz = detail && detail.accFillSz > 0 ? detail.accFillSz : sizing.contracts;
      const entryAt = new Date(detail?.fillTime ?? Date.now()).toISOString();
      const roundPx = (v: number) => Number((Math.round(v / inst.tickSz) * inst.tickSz).toFixed(inst.pxDecimals));
      const seq = await nextSeq(book.id);

      const { data: trade, error: tradeError } = await supabase
        .from("trades")
        .insert({
          book_id: book.id,
          user_id: user.id,
          seq,
          side,
          symbol: baseSymbol(instId),
          entry_at: entryAt,
          result: "open",
          equity_before: eq,
          notional: filledSz * inst.ctVal * entryPrice,
          leverage: lev,
          entry_price: entryPrice,
          fee: detail?.fee ?? null,
          margin_mode: "isolated",
          stop_price: stop,
          tp1_price: targets[0],
          tp2_price: targets[1],
          tp3_price: targets[2],
          setup,
          rationale,
          emotion: emotion === "" ? null : emotion,
          // 동기화가 이 번호로 같은 행을 찾아 갱신·청산한다 — 없으면 같은 포지션이 두 행이 된다.
          okx_pos_id: mine?.posId || null,
          okx_stop_price: roundPx(stop as number),
          okx_tp_price: target === undefined ? null : roundPx(target),
          okx_sl_source: "attached",
        })
        .select("id")
        .single();
      if (tradeError) throw new Error(tradeError.message);

      if (annotations.length > 0) {
        const { error: annError } = await supabase.from("trade_annotations").insert(
          annotations.map((a) => ({
            trade_id: trade.id,
            user_id: user.id,
            kind: a.kind,
            // jsonb 칸은 인덱스 시그니처가 있는 타입만 받는다 — 이름 붙은 인터페이스는 못 넣는다.
            points: a.points.map((p) => ({ t: p.t, p: p.p })),
            text: a.text,
            color: a.color,
            line_width: a.line_width,
            line_style: a.line_style,
          })),
        );
        if (annError) throw new Error(`차트 메모 저장 실패: ${annError.message}`);
      }

      revalidatePath("/dashboard");
      revalidatePath("/trades");
      revalidatePath("/order");

      const bracket =
        target === undefined
          ? `손절 ${roundPx(stop as number)} 부착 (TP 여러 단 — 익절은 거래소에서 직접)`
          : `손절 ${roundPx(stop as number)} · 목표 ${roundPx(target)} 브래킷 부착`;
      return {
        ok: {
          tradeId: trade.id,
          ordId,
          detail: `주문 접수 (ordId ${ordId}) — ${filledSz}계약 ≈ $${(filledSz * inst.ctVal * entryPrice).toFixed(2)}, 체결가 ${entryPrice}, ${bracket}. 거래 #${seq} 로 기록됨.`,
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "알 수 없는 오류";
      return {
        ordId,
        error: `주문은 접수됐습니다 (ordId ${ordId}) — 그러나 일지 기록에 실패했습니다: ${msg}. 다시 누르지 마세요. OKX 동기화를 누르면 이 포지션이 거래로 들어오니 그 거래에 근거를 옮겨 적어 주세요.`,
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "알 수 없는 오류";
    return { error: `주문 실패: ${msg}` };
  }
}
