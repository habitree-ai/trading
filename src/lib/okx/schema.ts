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
  /**
   * 어떻게 닫혔는지 — `1` 부분청산, `2` 전량청산, `3` 강제청산, `4` 부분 강제청산, `5` ADL.
   *
   * 부분청산은 포지션이 남아 있는데도 이 이력에 행이 하나 생긴다. 그걸 거래 하나로
   * 세면 같은 손익이 두 번 잡힌다 — 남은 포지션이 최종 청산될 때 그 행의
   * `realizedPnl`이 부분청산분까지 합쳐 다시 오기 때문이다.
   *
   * 응답에 없으면 비워 둔다 — 값을 못 읽었다고 거래를 통째로 버리는 편이 더 나쁘다.
   */
  type: z.string().optional(),
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

/**
 * `GET /api/v5/account/bills-archive` — 거래계좌 장부 1줄.
 *
 * `type=1`(이체)만 읽는다. 매매로 생긴 줄(type=2)은 이미 포지션 내역으로 받고 있어
 * 여기서 또 세면 손익이 두 번 잡힌다.
 */
export const accountBillSchema = z.object({
  billId: z.string(),
  ccy: z.string(),
  /** 부호 포함 잔고 변화 — 거래계좌로 들어오면 +, 나가면 − */
  balChg: numeric,
  /** `From: Funding` / `To: Funding` — 어느 쪽으로 옮겼는지 */
  notes: z.string(),
  ts: epochMs,
});

export type OkxAccountBill = z.infer<typeof accountBillSchema>;

/** `GET /api/v5/asset/deposit-history` — 온체인 입금 1건. */
export const depositSchema = z.object({
  depId: z.string(),
  ccy: z.string(),
  amt: numeric,
  chain: z.string(),
  /** `2` = 입금 완료. 그 전 단계는 아직 잔고가 아니다 */
  state: z.string(),
  ts: epochMs,
});

export type OkxDeposit = z.infer<typeof depositSchema>;

/** `GET /api/v5/asset/withdrawal-history` — 온체인 출금 1건. */
export const withdrawalSchema = z.object({
  wdId: z.string(),
  ccy: z.string(),
  amt: numeric,
  fee: numeric,
  chain: z.string(),
  /** `2` = 출금 성공. 취소·실패 건을 빼야 한다 */
  state: z.string(),
  ts: epochMs,
});

export type OkxWithdrawal = z.infer<typeof withdrawalSchema>;

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
 * `GET /api/v5/account/positions` — 아직 안 닫힌 포지션 1건.
 *
 * 두 가지로 쓴다. 하나는 잔고 대조 — `upl`(미실현 가격손익)에 `realizedPnl`(이 포지션이
 * 지금까지 확정한 수수료·펀딩비·부분청산 손익)을 더하면 잔고에는 있고 거래 목록에는
 * 없는 금액이 나온다. 다른 하나는 목록에 올릴 미청산 거래 행이다 — 들고 있는 동안에도
 * 진입 근거를 적어 둘 자리가 있어야 한다.
 *
 * 닫히는 날 `positions-history`가 같은 `posId`로 돌아오고, 그 행을 덮어써서 닫는다.
 */
export const openPositionSchema = z.object({
  posId: z.string(),
  instId: z.string(),
  mgnMode: z.string(),
  /** `long` | `short` — 넷 모드에서는 `net`으로 온다 */
  posSide: z.string(),
  /** 보유 계약 수. 넷 모드에서는 부호가 방향이다 */
  pos: numeric,
  /** 평균 진입가 */
  avgPx: numeric,
  lever: numeric,
  upl: numeric,
  realizedPnl: numeric,
  /** 포지션을 연 시각 */
  cTime: epochMs,
});

export type OkxOpenPosition = z.infer<typeof openPositionSchema>;

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
