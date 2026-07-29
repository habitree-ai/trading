/**
 * OKX 응답 스키마.
 *
 * OKX는 모든 수치를 문자열로 준다. 비어 있는 항목은 `""`로 오므로 숫자와 '값 없음'을
 * 여기서 한 번에 갈라 둔다 — 아래 계층은 number | null만 보면 되게.
 *
 * 응답에 새 필드가 붙어도 깨지지 않도록 쓰는 필드만 좁게 읽는다.
 */

import { z } from "zod";

/** `"29786.6"` → 29786.6, `""`/`"NaN"` → null */
const numeric = z.string().transform((raw) => {
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
});

/** 시각은 항상 있어야 하는 값이라 없으면 그 레코드를 버린다. */
const epochMs = z.string().refine((raw) => Number.isFinite(Number(raw)) && raw !== "", {
  message: "시각이 비어 있음",
});

/** `GET /api/v5/account/positions-history` — 청산 완료된 포지션 1건. */
export const positionSchema = z.object({
  posId: z.string(),
  instId: z.string(),
  mgnMode: z.string(),
  /** `long` | `short` — 넷 모드에서는 `net`으로 올 수 있다. */
  direction: z.string(),
  lever: numeric,
  openAvgPx: numeric,
  closeAvgPx: numeric,
  /** 비용 이전 손익 — 화면의 `Closed PnL`. */
  pnl: numeric,
  /** 수수료·펀딩비까지 반영된 실현손익. 계좌가 실제로 움직인 값. */
  realizedPnl: numeric,
  fee: numeric,
  fundingFee: numeric,
  /** 청산한 총 계약 수 — 명목가 환산에 쓴다. */
  closeTotalPos: numeric,
  /** 포지션을 연 시각 */
  cTime: epochMs,
  /** 포지션이 닫힌 시각 */
  uTime: epochMs,
});

export type OkxPosition = z.infer<typeof positionSchema>;

/** `GET /api/v5/trade/fills-history` — 체결 1건. */
export const fillSchema = z.object({
  billId: z.string(),
  ordId: z.string(),
  instId: z.string(),
  fillPx: numeric,
  /** 체결 계약 수 */
  fillSz: numeric,
  /** `buy` | `sell` */
  side: z.string(),
  fee: numeric,
  ts: epochMs,
});

export type OkxFill = z.infer<typeof fillSchema>;

/** `GET /api/v5/public/instruments` — 계약 1개가 기초자산 몇 개인지(`ctVal`). */
export const instrumentSchema = z.object({
  instId: z.string(),
  ctVal: numeric,
});

/** `GET /api/v5/account/balance` — 계좌 전체 자산. */
export const balanceSchema = z.object({
  totalEq: numeric,
  uTime: epochMs,
});

/**
 * 배열을 항목별로 검증하고, 형태가 깨진 항목만 버린다.
 *
 * 한 건이 이상하다고 동기화 전체를 멈추면 그날 거래가 통째로 안 들어온다.
 */
export function parseList<T>(schema: z.ZodType<T>, rows: unknown[]): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
