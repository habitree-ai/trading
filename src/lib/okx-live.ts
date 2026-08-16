/**
 * OKX 실계좌 클라이언트 — 서버 전용.
 *
 * system-trading/bot/okx.mjs 의 검증된 주문 경로를 앱에서 쓰기 위한 이식이다.
 * 앱 버튼(수동 실주문)과 이후의 라이브 봇 제어가 이 한 벌을 같이 쓴다 —
 * 주문·브래킷·정리의 배선이 두 벌이면 한쪽만 고쳐지는 사고가 난다.
 *
 * 키는 환경변수(OKX_API_KEY/SECRET/PASSPHRASE)로만 읽는다. Next.js 가 .env.local 을
 * 서버에서만 로드하므로 브라우저로는 흘러가지 않는다 — 이 파일을 클라이언트에서
 * import 하면 node:crypto 때문에 빌드가 깨진다(의도된 방어).
 */
import { createHmac } from "node:crypto";

const BASE = "https://www.okx.com";

/** 실주문 테스트의 공용 상수 — 화면 게이트와 액션이 같은 값을 봐야 한다. */
export const LIVE_TEST_LEV = 10;
export const LIVE_TEST_TP_PCT = 0.15;
export const LIVE_TEST_SL_PCT = 0.1;

export interface OkxInstrument {
  ctVal: number;
  lotSz: number;
  minSz: number;
  tickSz: number;
  szDecimals: number;
  pxDecimals: number;
}

interface OkxRow {
  [key: string]: string | undefined;
}

function keys() {
  const key = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!key || !secret || !passphrase) return null;
  return { key, secret, passphrase };
}

export function hasLiveKeys(): boolean {
  return keys() !== null;
}

async function publicGet(path: string): Promise<OkxRow[]> {
  const res = await fetch(BASE + path, { headers: { accept: "application/json" } });
  const json = (await res.json()) as { code: string; msg?: string; data: OkxRow[] };
  if (json.code !== "0") throw new Error(`OKX ${path}: ${json.msg || json.code}`);
  return json.data;
}

async function privateCall(method: "GET" | "POST", path: string, body?: unknown): Promise<OkxRow[]> {
  const k = keys();
  if (!k) throw new Error("OKX 키가 없습니다 (.env.local 확인)");
  const ts = new Date().toISOString();
  const payload = body ? JSON.stringify(body) : "";
  const sign = createHmac("sha256", k.secret).update(ts + method + path + payload).digest("base64");
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "OK-ACCESS-KEY": k.key,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": k.passphrase,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: payload || undefined,
  });
  const json = (await res.json()) as {
    code: string;
    msg?: string;
    data?: (OkxRow & { sMsg?: string })[];
  };
  if (json.code !== "0") {
    throw new Error(`OKX ${method} ${path}: ${json.data?.[0]?.sMsg || json.msg || json.code}`);
  }
  return json.data ?? [];
}

export async function instrument(instId: string): Promise<OkxInstrument> {
  const [d] = await publicGet(`/api/v5/public/instruments?instType=SWAP&instId=${instId}`);
  return {
    ctVal: Number(d.ctVal),
    lotSz: Number(d.lotSz),
    minSz: Number(d.minSz),
    tickSz: Number(d.tickSz),
    szDecimals: (d.lotSz?.split(".")[1] ?? "").length,
    pxDecimals: (d.tickSz?.split(".")[1] ?? "").length,
  };
}

export async function lastPrice(instId: string): Promise<number> {
  const [d] = await publicGet(`/api/v5/market/ticker?instId=${instId}`);
  return Number(d.last);
}

export async function equityUsd(): Promise<number> {
  const [d] = await privateCall("GET", "/api/v5/account/balance?ccy=USDT");
  const details = d.details as unknown as { ccy: string; eq: string }[] | undefined;
  const usdt = details?.find((x) => x.ccy === "USDT");
  return Number(usdt?.eq ?? d.totalEq);
}

export async function accountConfig(): Promise<OkxRow> {
  const [d] = await privateCall("GET", "/api/v5/account/config");
  return d;
}

export async function setLeverage(instId: string, lever: number, posSide: "long" | "short"): Promise<void> {
  await privateCall("POST", "/api/v5/account/set-leverage", {
    instId,
    lever: String(lever),
    mgnMode: "isolated",
    posSide,
  });
}

/** 시장가 진입 + 손절·목표 동시 부착 — 봇과 같은 원자적 브래킷. */
export async function openWithBracket(args: {
  instId: string;
  posSide: "long" | "short";
  sz: string;
  stop: number;
  target: number;
  algoClOrdId: string;
  tickSz: number;
  pxDecimals: number;
}): Promise<string> {
  const px = (v: number) => (Math.round(v / args.tickSz) * args.tickSz).toFixed(args.pxDecimals);
  const [d] = await privateCall("POST", "/api/v5/trade/order", {
    instId: args.instId,
    tdMode: "isolated",
    side: args.posSide === "long" ? "buy" : "sell",
    posSide: args.posSide,
    ordType: "market",
    sz: args.sz,
    attachAlgoOrds: [
      {
        attachAlgoClOrdId: args.algoClOrdId,
        tpTriggerPx: px(args.target),
        tpOrdPx: "-1",
        tpTriggerPxType: "last",
        slTriggerPx: px(args.stop),
        slOrdPx: "-1",
        slTriggerPxType: "last",
      },
    ],
  });
  return String(d.ordId);
}

export async function algoDetails(
  algoClOrdId: string,
): Promise<OkxRow | { error: string } | null> {
  try {
    const data = await privateCall(
      "GET",
      `/api/v5/trade/order-algo?algoClOrdId=${encodeURIComponent(algoClOrdId)}`,
    );
    return data[0] ?? null;
  } catch (e) {
    // 조회 실패와 "없음"은 다르다 — 호출부가 가드를 건너뛴 이유를 알아야 한다.
    return { error: e instanceof Error ? e.message : "조회 실패" };
  }
}

export async function cancelAlgo(instId: string, algoId: string): Promise<void> {
  await privateCall("POST", "/api/v5/trade/cancel-algos", [{ instId, algoId }]);
}

export async function closeMarket(instId: string, posSide: "long" | "short", sz: string): Promise<void> {
  await privateCall("POST", "/api/v5/trade/order", {
    instId,
    tdMode: "isolated",
    side: posSide === "long" ? "sell" : "buy",
    posSide,
    ordType: "market",
    sz,
  });
}

export interface OkxPosition {
  posSide: "long" | "short";
  pos: number;
  avgPx: number;
  upl: number;
}

export async function positions(instId: string): Promise<OkxPosition[]> {
  const data = await privateCall("GET", `/api/v5/account/positions?instId=${instId}`);
  return data
    .filter((p) => Number(p.pos) !== 0)
    .map((p) => ({
      posSide: p.posSide as "long" | "short",
      pos: Number(p.pos),
      avgPx: Number(p.avgPx),
      upl: Number(p.upl),
    }));
}
