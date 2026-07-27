import type { ExtractedFields } from "@/lib/extract/types";
import { toLocalInput } from "@/lib/format";

/** 폼 입력칸에 그대로 꽂을 수 있는 문자열 묶음. */
export type Prefill = Record<string, string>;

const str = (v: number | undefined) => (v === undefined ? undefined : String(v));

/** 추출 결과를 폼 필드 이름 → 값 문자열로 바꾼다. */
export function toPrefill(fields: ExtractedFields): Prefill {
  const out: Prefill = {};

  const put = (key: string, value: string | undefined) => {
    if (value !== undefined && value !== "") out[key] = value;
  };

  put("symbol", fields.symbol);
  put("side", fields.side);
  put("leverage", str(fields.leverage));
  put("notional", str(fields.notional));
  put("entry_price", str(fields.entry_price));
  put("exit_price", str(fields.exit_price));
  put("stop_price", str(fields.stop_price));
  put("pnl", str(fields.pnl));
  put("fee", str(fields.fee));
  put("equity_after", str(fields.equity_after));
  put("entry_at", fields.entry_at ? toLocalInput(fields.entry_at) : undefined);
  put("exit_at", fields.exit_at ? toLocalInput(fields.exit_at) : undefined);

  return out;
}

/**
 * AI 라우트가 돌려주는 평평한 응답을 도메인 필드로 되돌린다.
 * (AI에는 `price`/`filled_at` 하나로 물어보고, 여기서 진입/청산 어느 쪽인지 가른다.)
 */
export interface AiExtraction {
  symbol: string | null;
  side: "long" | "short" | null;
  orderRole: "open" | "close" | null;
  leverage: number | null;
  notional: number | null;
  price: number | null;
  pnl: number | null;
  pnl_pct: number | null;
  fee: number | null;
  filled_at: string | null;
  year_assumed: boolean;
}

export function fromAi(ai: AiExtraction): { fields: ExtractedFields; notes: string[] } {
  const notes: string[] = [];
  const fields: ExtractedFields = {};

  if (ai.symbol) fields.symbol = ai.symbol.toUpperCase();
  if (ai.side) fields.side = ai.side;
  if (ai.orderRole) fields.orderRole = ai.orderRole;
  if (ai.leverage !== null) fields.leverage = ai.leverage;
  if (ai.notional !== null) fields.notional = ai.notional;
  if (ai.pnl !== null) fields.pnl = ai.pnl;
  if (ai.pnl_pct !== null) fields.pnl_pct = ai.pnl_pct;
  if (ai.fee !== null) fields.fee = ai.fee;

  // AI에는 KST 벽시계로 달라고 했으므로 그대로 KST로 해석한다.
  const iso = ai.filled_at ? `${ai.filled_at.replace(" ", "T").slice(0, 19)}+09:00` : null;
  const at = iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString() : undefined;

  if (ai.orderRole === "close") {
    if (ai.price !== null) fields.exit_price = ai.price;
    fields.exit_at = at;
    notes.push("청산 주문 캡쳐입니다 — 진입가·진입 시각은 직접 채워 주세요.");
  } else if (ai.orderRole === "open") {
    if (ai.price !== null) fields.entry_price = ai.price;
    fields.entry_at = at;
    notes.push("진입 주문 캡쳐입니다 — 청산가·손익은 청산 후 캡쳐에서 채워집니다.");
  }

  if (ai.year_assumed) {
    notes.push("화면에 연도가 없어 AI가 추측했습니다. 날짜를 확인해 주세요.");
  }

  return { fields, notes };
}
