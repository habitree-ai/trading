/**
 * OKX 실계좌 클라이언트 — 서버 전용.
 *
 * system-trading/bot/okx.mjs 의 검증된 주문 경로를 앱에서 쓰기 위한 이식이다.
 * 앱 버튼(수동 실주문)과 이후의 라이브 봇 제어가 이 한 벌을 같이 쓴다 —
 * 주문·브래킷·정리의 배선이 두 벌이면 한쪽만 고쳐지는 사고가 난다.
 *
 * 키는 환경변수(OKX_LIVE_API_KEY/SECRET/PASSPHRASE)로만 읽는다. Next.js 가 .env.local 을
 * 서버에서만 로드하므로 브라우저로는 흘러가지 않는다 — 이 파일을 클라이언트에서
 * import 하면 node:crypto 때문에 빌드가 깨진다(의도된 방어).
 *
 * 이름이 `OKX_API_*` 가 아니라 `OKX_LIVE_*` 인 것은 2026-08-19 사고에서 나왔다.
 * 봇(system-trading/bot)도 `OKX_API_*` 를 읽는데, 봇은 로컬 PC 에서 돌고 이 코드는
 * 배포 서버에서 돈다 — 이름이 같으니 코드는 옳은 채로 **실행 위치가 계좌를 정했다**.
 * 배포된 실주문 버튼이 봇 서브계정이 아니라 주 매매계정을 향하고 있었고, 아무 신호도
 * 없었다. 이름을 갈라 두면 두 경로가 우연히 같은 값을 물려받는 일이 없다.
 *
 * 폴백을 두지 않는 것도 의도다. `OKX_LIVE_*` 가 없을 때 `OKX_API_*` 로 흘러가면
 * 정확히 그 사고가 조용히 되살아난다. 없으면 키가 없는 것으로 치고 화면이 닫힌다.
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
  const key = process.env.OKX_LIVE_API_KEY;
  const secret = process.env.OKX_LIVE_API_SECRET;
  const passphrase = process.env.OKX_LIVE_API_PASSPHRASE;
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
  if (!k) throw new Error("OKX 실주문 키가 없습니다 — OKX_LIVE_API_KEY/SECRET/PASSPHRASE 를 확인하세요.");
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

/** 이 키가 실제로 붙는 계좌 — 화면이 "어디로 주문이 나가는지"를 숫자로 말할 수 있게. */
export interface OkxAccountId {
  uid: string;
  /** 서브계정이면 상위 계정의 uid. 같으면 본인이 메인이다. */
  mainUid: string | null;
}

export async function accountId(): Promise<OkxAccountId> {
  const d = await accountConfig();
  return { uid: d.uid ?? "", mainUid: d.mainUid ?? null };
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

/**
 * 배포 환경 불변식 — 허용목록 없이 실주문 경로를 열지 않는다.
 *
 * allowlist 는 미설정 시 로컬 편의로 전체 허용(fail-open)이라, 키가 있는 배포에서
 * 이 변수를 빠뜨리면 구글 로그인만으로 누구나 주문·킬스위치에 닿는다.
 * 실주문 버튼과 라이브 킬스위치가 같은 문턱을 쓴다 — 한쪽만 열려 있으면 뜻이 없다.
 */
export function deployGuard(): string | null {
  if (process.env.NODE_ENV === "production" && !(process.env.ALLOWED_EMAILS ?? "").trim()) {
    return "배포 환경에서는 ALLOWED_EMAILS 설정 없이 실주문을 열 수 없습니다.";
  }
  return null;
}
