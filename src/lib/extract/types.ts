import type { Side } from "@/lib/domain";

/** 캡쳐에서 뽑아낸 값들 — 전부 선택적이다. 한 장으로 거래가 완성되지 않는 경우가 많다. */
export interface ExtractedFields {
  symbol?: string;
  side?: Side;
  leverage?: number;
  notional?: number;
  entry_price?: number;
  exit_price?: number;
  stop_price?: number;
  pnl?: number;
  fee?: number;
  entry_at?: string;
  exit_at?: string;
  equity_after?: number;
  /** 거래소가 표시한 손익률 — 저장하지 않고 교차검증에만 쓴다. */
  pnl_pct?: number;
  /** 주문 화면이 '진입'인지 '청산'인지 — 무엇이 빠졌는지 안내하는 데 쓴다. */
  orderRole?: "open" | "close";
}

export interface ExtractResult {
  fields: ExtractedFields;
  /** 어댑터가 스스로 매긴 신뢰도 0~1. 낮으면 AI 폴백으로 넘긴다. */
  confidence: number;
  /** 값이 있어도 사람이 확인해야 하는 필드 이름들. */
  suspect: string[];
  /** 이 캡쳐만으로는 채울 수 없는 필드에 대한 안내 문구. */
  notes: string[];
  adapter: string;
  engine: "ocr" | "ai";
}

export interface ExchangeAdapter {
  id: string;
  label: string;
  /** 이 텍스트가 자기 화면인지 0~1로 점수를 낸다. */
  detect(text: string): number;
  parse(text: string): Omit<ExtractResult, "engine">;
}
