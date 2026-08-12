/**
 * OKX 내역 조회 — 페이지를 거슬러 올라가며 `since` 이후를 모은다.
 *
 * 두 엔드포인트의 페이지 커서가 서로 다르다.
 *   positions-history : `after` = 시각(ms)
 *   fills-history     : `after` = billId
 */

import { okxPrivateGet, okxPublicGet, type OkxCredentials } from "@/lib/okx/private";
import {
  accountBillSchema,
  balanceSchema,
  depositSchema,
  fillSchema,
  instrumentSchema,
  openPositionSchema,
  parseList,
  positionSchema,
  withdrawalSchema,
  type OkxAccountBill,
  type OkxDeposit,
  type OkxFill,
  type OkxOpenPosition,
  type OkxPosition,
  type OkxWithdrawal,
} from "@/lib/okx/schema";

/** 한 번에 받을 수 있는 최대치. */
const PAGE = 100;
/** 3개월치를 다 훑어도 남을 만큼 — 무한 루프 방지용 상한. */
const MAX_PAGES = 30;

/**
 * 일지가 다루는 상품은 무기한 계약뿐이다(`toInstId`도 `-SWAP`을 붙인다).
 * 현물·옵션까지 넓히려면 여기와 `ctVal` 조회를 함께 늘려야 한다.
 */
const INST_TYPE = "SWAP";

/** 청산 완료된 포지션 — 일지의 거래 1건에 대응한다. */
export async function fetchPositionsHistory(
  creds: OkxCredentials,
  sinceMs: number,
): Promise<OkxPosition[]> {
  const out: OkxPosition[] = [];
  let cursor: number | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await okxPrivateGet(
      "/api/v5/account/positions-history",
      { instType: INST_TYPE, limit: PAGE, after: cursor },
      creds,
    );
    if (rows.length === 0) break;

    const parsed = parseList(positionSchema, rows);
    const fresh = parsed.filter((p) => Number(p.uTime) >= sinceMs);
    out.push(...fresh);

    // 한 페이지라도 `since` 이전으로 넘어갔으면 더 볼 이유가 없다.
    if (fresh.length < parsed.length || rows.length < PAGE) break;

    const oldest = Math.min(...parsed.map((p) => Number(p.uTime)));
    if (!Number.isFinite(oldest)) break;
    cursor = oldest;
  }

  return out;
}

/** 낱개 체결 — 차트에 실제 좌표를 찍는 데 쓴다. */
export async function fetchFillsHistory(
  creds: OkxCredentials,
  sinceMs: number,
): Promise<OkxFill[]> {
  const out: OkxFill[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await okxPrivateGet(
      "/api/v5/trade/fills-history",
      { instType: INST_TYPE, limit: PAGE, after: cursor },
      creds,
    );
    if (rows.length === 0) break;

    const parsed = parseList(fillSchema, rows);
    const fresh = parsed.filter((f) => Number(f.ts) >= sinceMs);
    out.push(...fresh);

    if (parsed.length === 0 || fresh.length < parsed.length || rows.length < PAGE) break;

    // OKX는 최신순으로 준다 — 마지막 항목이 이 페이지에서 가장 오래된 체결이다.
    cursor = parsed[parsed.length - 1].billId;
  }

  return out;
}

/**
 * `since` 이후 항목만 페이지를 거슬러 올라가며 모은다.
 *
 * 입출금 쪽 세 엔드포인트는 커서 종류만 다르고 나머지가 같아 여기 모은다.
 * `cursorOf`는 "이 페이지에서 가장 오래된 항목의 커서"를 돌려준다 —
 * OKX가 최신순으로 주므로 마지막 항목이 그것이다.
 */
async function collectSince<T>(input: {
  path: string;
  params: Record<string, string | number | undefined>;
  creds: OkxCredentials;
  schema: Parameters<typeof parseList<T>>[0];
  sinceMs: number;
  tsOf: (row: T) => number;
  cursorOf: (row: T) => string | number | undefined;
}): Promise<T[]> {
  const { path, params, creds, schema, sinceMs, tsOf, cursorOf } = input;
  const out: T[] = [];
  let cursor: string | number | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await okxPrivateGet(path, { ...params, limit: PAGE, after: cursor }, creds);
    if (rows.length === 0) break;

    const parsed = parseList(schema, rows);
    const fresh = parsed.filter((r) => tsOf(r) >= sinceMs);
    out.push(...fresh);

    // 한 페이지라도 `since` 이전으로 넘어갔으면 더 볼 이유가 없다.
    if (parsed.length === 0 || fresh.length < parsed.length || rows.length < PAGE) break;

    const next = cursorOf(parsed[parsed.length - 1]);
    if (next === undefined) break;
    cursor = next;
  }

  return out;
}

/** 거래계좌 장부에서 이체만 골라 읽는 코드 — 매매(2)는 포지션 내역으로 이미 받는다. */
const TRANSFER_BILL_TYPE = 1;

/**
 * 거래계좌 이체 — 자금 곡선을 움직이는 유일한 외부 유입이다.
 *
 * `bills-archive`는 3개월치를 준다(`bills`는 7일치뿐이라 동기화 주기가 밀리면 유실된다).
 */
export function fetchAccountTransfers(
  creds: OkxCredentials,
  sinceMs: number,
): Promise<OkxAccountBill[]> {
  return collectSince({
    path: "/api/v5/account/bills-archive",
    params: { type: TRANSFER_BILL_TYPE },
    creds,
    schema: accountBillSchema,
    sinceMs,
    tsOf: (b) => Number(b.ts),
    cursorOf: (b) => b.billId,
  });
}

/** 온체인 입금 — 자금계좌로 들어온 실제 현금. */
export function fetchDeposits(creds: OkxCredentials, sinceMs: number): Promise<OkxDeposit[]> {
  return collectSince({
    path: "/api/v5/asset/deposit-history",
    params: {},
    creds,
    schema: depositSchema,
    sinceMs,
    tsOf: (d) => Number(d.ts),
    // 이 엔드포인트의 커서는 billId가 아니라 시각(ms)이다.
    cursorOf: (d) => d.ts,
  });
}

/** 온체인 출금 — 자금계좌에서 빠져나간 실제 현금. */
export function fetchWithdrawals(
  creds: OkxCredentials,
  sinceMs: number,
): Promise<OkxWithdrawal[]> {
  return collectSince({
    path: "/api/v5/asset/withdrawal-history",
    params: {},
    creds,
    schema: withdrawalSchema,
    sinceMs,
    tsOf: (w) => Number(w.ts),
    cursorOf: (w) => w.ts,
  });
}

/**
 * 계약 1개의 기초자산 수량 — 계약 수를 금액으로 바꿀 때 필요하다.
 *
 * 인증이 필요 없는 공개 엔드포인트라 키 없이도 부를 수 있다.
 */
export async function fetchContractValues(): Promise<Map<string, number | null>> {
  const rows = await okxPublicGet("/api/v5/public/instruments", { instType: INST_TYPE });
  return new Map(parseList(instrumentSchema, rows).map((i) => [i.instId, i.ctVal]));
}

/** 계좌 전체 자산 — 동기화할 때마다 잔고 스냅샷으로 남긴다. */
export async function fetchTotalEquity(
  creds: OkxCredentials,
): Promise<{ equity: number; at: string } | null> {
  const rows = await okxPrivateGet("/api/v5/account/balance", {}, creds);
  const parsed = parseList(balanceSchema, rows);
  const first = parsed[0];
  if (!first || first.totalEq === null) return null;
  return { equity: first.totalEq, at: new Date(Number(first.uTime)).toISOString() };
}

/**
 * 아직 안 닫힌 포지션들.
 *
 * 두 군데서 쓴다. 잔고 대조는 이 포지션들이 잔고에 남긴 금액(`openPositionPnl`)을
 * 걷어내야 계산 자금과 기준이 같아지고, 거래 목록은 이걸로 "보유중" 줄을 만든다.
 * 한 번만 불러 둘에 나눠 쓴다 — 같은 엔드포인트를 두 번 칠 이유가 없다.
 */
export async function fetchOpenPositions(creds: OkxCredentials): Promise<OkxOpenPosition[]> {
  const rows = await okxPrivateGet("/api/v5/account/positions", { instType: INST_TYPE }, creds);
  return parseList(openPositionSchema, rows);
}

/**
 * 미청산 포지션이 잔고에 남긴 순손익 — 미실현 가격손익 + 이미 확정된 비용.
 *
 * 계좌 잔고에는 이 금액이 이미 들어 있지만 거래 목록에는 아직 없다. 그대로 두고 대조하면
 * 포지션을 들고 있는 내내 자금이 어긋나 보인다. 청산되는 날 이 값이 그 거래의
 * `realizedPnl`이 되어 들어오므로, 그때 자연히 상쇄된다.
 */
export function openPositionPnl(
  positions: readonly OkxOpenPosition[],
): { pnl: number; count: number } {
  return {
    pnl: positions.reduce((a, p) => a + (p.upl ?? 0) + (p.realizedPnl ?? 0), 0),
    count: positions.length,
  };
}
