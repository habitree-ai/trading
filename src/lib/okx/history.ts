/**
 * OKX 내역 조회 — 페이지를 거슬러 올라가며 `since` 이후를 모은다.
 *
 * 두 엔드포인트의 페이지 커서가 서로 다르다.
 *   positions-history : `after` = 시각(ms)
 *   fills-history     : `after` = billId
 */

import { okxPrivateGet, okxPublicGet, type OkxCredentials } from "@/lib/okx/private";
import {
  balanceSchema,
  fillSchema,
  instrumentSchema,
  parseList,
  positionSchema,
  type OkxFill,
  type OkxPosition,
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
