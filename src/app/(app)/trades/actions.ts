"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { Side, TradeResult } from "@/lib/domain";
import { fromLocalInput } from "@/lib/format";
import { nextSeq, requireUser } from "@/lib/queries";

export interface TradeFormState {
  error?: string;
}

function parseNumber(value: FormDataEntryValue | null): number | null {
  const raw = String(value ?? "")
    .trim()
    .replace(/,/g, "");
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseText(value: FormDataEntryValue | null): string | null {
  const raw = String(value ?? "").trim();
  return raw === "" ? null : raw;
}

/** `<input type="datetime-local">`은 타임존 없는 벽시계 시각을 준다 — 표시 타임존으로 해석한다. */
function parseDateTime(value: FormDataEntryValue | null): string | null {
  const raw = String(value ?? "").trim();
  return raw === "" ? null : fromLocalInput(raw);
}

/** 손익 부호로 승패를 정한다 — 시트의 `승`/`패` 체크를 자동화. */
function inferResult(explicit: string, pnl: number | null, exitAt: string | null): TradeResult {
  if (explicit === "win" || explicit === "loss" || explicit === "be" || explicit === "open") {
    return explicit;
  }
  if (exitAt === null || pnl === null) return "open";
  if (pnl > 0) return "win";
  if (pnl < 0) return "loss";
  return "be";
}

function readForm(formData: FormData) {
  const exitAt = parseDateTime(formData.get("exit_at"));
  const pnl = parseNumber(formData.get("pnl"));
  const side = String(formData.get("side") ?? "long");

  return {
    side: (side === "short" ? "short" : "long") satisfies Side as Side,
    symbol: String(formData.get("symbol") ?? "").trim().toUpperCase(),
    entry_at: parseDateTime(formData.get("entry_at")),
    exit_at: exitAt,
    result: inferResult(String(formData.get("result") ?? "auto"), pnl, exitAt),
    margin_mode: parseMarginMode(formData.get("margin_mode")),
    funding_fee: parseNumber(formData.get("funding_fee")),
    equity_before: parseNumber(formData.get("equity_before")),
    equity_after: parseNumber(formData.get("equity_after")),
    withdrawal: parseNumber(formData.get("withdrawal")),
    notional: parseNumber(formData.get("notional")),
    leverage: parseNumber(formData.get("leverage")),
    pnl,
    entry_price: parseNumber(formData.get("entry_price")),
    exit_price: parseNumber(formData.get("exit_price")),
    fee: parseNumber(formData.get("fee")),
    stop_price: parseNumber(formData.get("stop_price")),
    tp1_price: parseNumber(formData.get("tp1_price")),
    tp2_price: parseNumber(formData.get("tp2_price")),
    tp3_price: parseNumber(formData.get("tp3_price")),
    setup: parseText(formData.get("setup")),
    rationale: parseText(formData.get("rationale")),
    review: parseText(formData.get("review")),
    emotion: parseText(formData.get("emotion")),
    note: parseText(formData.get("note")),
  };
}

interface ParsedFill {
  role: "open" | "close";
  at: string;
  price: number;
  amount: number | null;
  fee: number | null;
  orderNo: string | null;
}

/**
 * 폼이 실어 보낸 체결 JSON을 검증한다.
 *
 * 클라이언트에서 온 값이라 형태를 믿지 않고 하나씩 확인한다 — 깨진 항목은 버린다.
 */
function parseFills(raw: FormDataEntryValue | null): ParsedFill[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ParsedFill[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const f = item as Record<string, unknown>;

    const role = f.role === "open" || f.role === "close" ? f.role : null;
    const at = typeof f.at === "string" && !Number.isNaN(Date.parse(f.at)) ? f.at : null;
    const price = typeof f.price === "number" && Number.isFinite(f.price) ? f.price : null;
    if (!role || !at || price === null) continue;

    out.push({
      role,
      at,
      price,
      amount: typeof f.amount === "number" && Number.isFinite(f.amount) ? f.amount : null,
      fee: typeof f.fee === "number" && Number.isFinite(f.fee) ? f.fee : null,
      orderNo: typeof f.orderNo === "string" && /^\d{6,}$/.test(f.orderNo) ? f.orderNo : null,
    });
  }
  return out;
}

function parseMarginMode(value: FormDataEntryValue | null): "cross" | "isolated" | null {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "cross" || raw === "isolated" ? raw : null;
}

/** DB의 trades_closed_complete 제약을 UI에서 먼저 걸러 준다. */
function validate(values: ReturnType<typeof readForm>): string | null {
  if (!values.symbol) return "종목을 입력해 주세요.";
  if (!values.entry_at) return "진입 시각을 입력해 주세요.";
  if (values.result !== "open" && values.exit_at === null) {
    return "청산된 거래는 종료 시각이 필요합니다.";
  }
  if (values.result !== "open" && values.pnl === null) {
    return "청산된 거래는 손익(TP/SP)이 필요합니다.";
  }
  if (values.exit_at && values.entry_at && values.exit_at < values.entry_at) {
    return "종료 시각이 진입 시각보다 빠릅니다.";
  }
  return null;
}

export async function createTrade(
  _prev: TradeFormState,
  formData: FormData,
): Promise<TradeFormState> {
  const bookId = String(formData.get("book_id") ?? "");
  if (!bookId) return { error: "북을 먼저 만들어 주세요." };

  const values = readForm(formData);
  const invalid = validate(values);
  if (invalid) return { error: invalid };

  const { supabase, user } = await requireUser();

  // 같은 주문번호가 이미 있으면 같은 거래다. 그대로 넣으면 손익이 두 배로 잡힌다.
  // (IMG_5084 와 IMG_5087 은 폰 시계만 다른 동일 거래였다.)
  const fills = parseFills(formData.get("fills"));
  const orderNos = fills.map((f) => f.orderNo).filter((n): n is string => n !== null);

  if (orderNos.length > 0) {
    const { data: dup } = await supabase
      .from("trade_fills")
      .select("order_no, trades(seq)")
      .in("order_no", orderNos)
      .limit(1);

    if (dup && dup.length > 0) {
      const row = dup[0] as { order_no: string | null; trades: { seq: number } | null };
      const where = row.trades ? ` (#${row.trades.seq} 거래)` : "";
      return {
        error: `이미 등록된 거래입니다${where}. 주문번호 ${row.order_no}가 중복입니다.`,
      };
    }
  }

  const { data, error } = await supabase
    .from("trades")
    .insert({
      ...values,
      entry_at: values.entry_at!,
      book_id: bookId,
      user_id: user.id,
      seq: await nextSeq(bookId),
    })
    .select("id")
    .single();

  if (error) return { error: error.message };

  // 업로드 시점엔 거래가 없어 trade_id를 비워 뒀던 캡쳐들을 이제 연결한다.
  const imageIds = formData.getAll("image_ids").map(String).filter(Boolean);
  if (imageIds.length > 0) {
    await supabase.from("trade_images").update({ trade_id: data.id }).in("id", imageIds);
  }

  // 캡쳐에서 읽은 낱개 체결 — 차트가 평균가가 아닌 실제 좌표를 찍는 데 쓴다.
  if (fills.length > 0) {
    await supabase.from("trade_fills").insert(
      fills.map((f) => ({
        trade_id: data.id,
        user_id: user.id,
        role: f.role,
        filled_at: f.at,
        price: f.price,
        amount: f.amount,
        fee: f.fee,
        order_no: f.orderNo,
      })),
    );
  }

  revalidatePath("/", "layout");
  redirect("/trades");
}

export async function updateTrade(
  _prev: TradeFormState,
  formData: FormData,
): Promise<TradeFormState> {
  const id = String(formData.get("trade_id") ?? "");
  if (!id) return { error: "거래를 찾을 수 없습니다." };

  const values = readForm(formData);
  const invalid = validate(values);
  if (invalid) return { error: invalid };

  const { supabase } = await requireUser();
  const { error } = await supabase
    .from("trades")
    .update({ ...values, entry_at: values.entry_at! })
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  redirect("/trades");
}

export async function deleteTrade(id: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("trades").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
}
