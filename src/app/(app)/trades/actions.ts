"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { Side, TradeResult } from "@/lib/domain";
import { fromLocalInput } from "@/lib/format";
import { loadOkxCredentials } from "@/lib/okx/credentials";
import { syncOkx } from "@/lib/okx/sync";
import { resolveSyncTarget } from "@/lib/okx/sync-target";
import { getActiveBook, nextSeq, requireUser } from "@/lib/queries";

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

/**
 * 손익 부호로 승패를 정한다 — 시트의 `승`/`패` 체크를 자동화.
 *
 * 기준은 수수료·펀딩비를 뺀 실현손익이다. 100배 레버리지에서 수수료는 손익에
 * 육박할 때가 있어, 총액으로 재면 계좌가 줄어든 거래가 '승'으로 적힌다.
 */
function inferResult(
  explicit: string,
  realized: number | null,
  exitAt: string | null,
): TradeResult {
  if (explicit === "win" || explicit === "loss" || explicit === "be" || explicit === "open") {
    return explicit;
  }
  if (exitAt === null || realized === null) return "open";
  if (realized > 0) return "win";
  if (realized < 0) return "loss";
  return "be";
}

function readForm(formData: FormData) {
  const exitAt = parseDateTime(formData.get("exit_at"));
  const pnl = parseNumber(formData.get("pnl"));
  const fee = parseNumber(formData.get("fee"));
  const fundingFee = parseNumber(formData.get("funding_fee"));
  const side = String(formData.get("side") ?? "long");
  const realized = pnl === null ? null : pnl + (fee ?? 0) + (fundingFee ?? 0);

  return {
    side: (side === "short" ? "short" : "long") satisfies Side as Side,
    symbol: String(formData.get("symbol") ?? "").trim().toUpperCase(),
    entry_at: parseDateTime(formData.get("entry_at")),
    exit_at: exitAt,
    result: inferResult(String(formData.get("result") ?? "auto"), realized, exitAt),
    margin_mode: parseMarginMode(formData.get("margin_mode")),
    funding_fee: fundingFee,
    equity_before: parseNumber(formData.get("equity_before")),
    equity_after: parseNumber(formData.get("equity_after")),
    withdrawal: parseNumber(formData.get("withdrawal")),
    notional: parseNumber(formData.get("notional")),
    leverage: parseNumber(formData.get("leverage")),
    pnl,
    entry_price: parseNumber(formData.get("entry_price")),
    exit_price: parseNumber(formData.get("exit_price")),
    fee,
    stop_price: parseNumber(formData.get("stop_price")),
    tp1_price: parseNumber(formData.get("tp1_price")),
    tp2_price: parseNumber(formData.get("tp2_price")),
    tp3_price: parseNumber(formData.get("tp3_price")),
    tp1_pct: parseNumber(formData.get("tp1_pct")),
    tp2_pct: parseNumber(formData.get("tp2_pct")),
    tp3_pct: parseNumber(formData.get("tp3_pct")),
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
  // 비중은 범위만 거른다 — 합이 100 이 아닌 것은 폼이 경고할 뿐, 계획은 고쳐 가며 적는다.
  for (const [n, pct] of [values.tp1_pct, values.tp2_pct, values.tp3_pct].entries()) {
    if (pct !== null && (pct <= 0 || pct > 100)) {
      return `TP${n + 1} 비율은 0 초과 100 이하여야 합니다.`;
    }
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

export interface SyncState {
  message?: string;
  error?: string;
}

/**
 * OKX에서 거래를 긁어 온다.
 *
 * 받는 대상은 **화면에 띄운 북**이다 — 대시보드·거래 목록이 그리는 북과 같아야, 버튼을
 * 누른 자리에서 숫자가 채워진다. 고르는 규칙은 `resolveSyncTarget`에 있다.
 *
 * 실패를 던지지 않고 문자열로 돌려준다 — 키가 없거나 거래소가 흔들리는 건
 * 화면에서 알려 주면 될 일이지 페이지를 깨뜨릴 일이 아니다.
 */
export async function runOkxSync(): Promise<SyncState> {
  const { supabase, user } = await requireUser();

  const resolved = resolveSyncTarget(await getActiveBook());
  if ("error" in resolved) return { error: resolved.error };
  const { bookId, startDate, exchangeAccountId } = resolved.target;

  try {
    const result = await syncOkx({
      supabase,
      userId: user.id,
      bookId,
      startDate,
      exchangeAccountId,
      creds: await loadOkxCredentials(exchangeAccountId),
    });
    revalidatePath("/", "layout");
    // 청산으로 덮어쓴 건과 보유 중인 건은 '받은 건수'와 뜻이 달라 따로 적는다.
    const closed = result.tradesClosed > 0 ? ` · 청산 반영 ${result.tradesClosed}건` : "";
    const holding = result.openCount > 0 ? ` · 보유 ${result.openCount}건` : "";
    return {
      message: `거래 ${result.tradesAdded}건 · 체결 ${result.fillsAdded}건 · 입출금 ${result.flowsAdded}건을 받았습니다${closed}${holding}.`,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function deleteTrade(id: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("trades").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
}
