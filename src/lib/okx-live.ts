/**
 * OKX 실계좌 클라이언트 — 서버 전용.
 *
 * system-trading/bot/okx.mjs 의 검증된 주문 경로를 앱에서 쓰기 위한 이식이다.
 * 앱 버튼(수동 실주문)과 이후의 라이브 봇 제어가 이 한 벌을 같이 쓴다 —
 * 주문·브래킷·정리의 배선이 두 벌이면 한쪽만 고쳐지는 사고가 난다.
 *
 * 키는 환경변수로만 읽는다. Next.js 가 .env.local 을 서버에서만 로드하므로 브라우저로는
 * 흘러가지 않는다 — 이 파일을 클라이언트에서 import 하면 node:crypto 때문에 빌드가
 * 깨진다(의도된 방어).
 *
 * 키 묶음이 둘이다. 같은 배선을 서로 다른 계좌로 태우기 때문에 이름이 계좌를 말해야 한다:
 *
 * - `OKX_LIVE_*`   — 봇 서브계정. 배선 검증(/system/test)과 라이브 봇 제어.
 * - `OKX_MANUAL_*` — 주 매매계정. 근거를 적은 뒤 사람이 내는 주문(/order).
 *
 * 이름이 `OKX_API_*` 가 아닌 것은 2026-08-19 사고에서 나왔다. 봇(system-trading/bot)도
 * `OKX_API_*` 를 읽는데, 봇은 로컬 PC 에서 돌고 이 코드는 배포 서버에서 돈다 — 이름이 같으니
 * 코드는 옳은 채로 **실행 위치가 계좌를 정했다**. 배포된 실주문 버튼이 봇 서브계정이 아니라
 * 주 매매계정을 향하고 있었고, 아무 신호도 없었다. 묶음마다 이름을 갈라 두면 두 경로가
 * 우연히 같은 값을 물려받는 일이 없다.
 *
 * 폴백을 두지 않는 것도 의도다. 한 묶음이 비었을 때 다른 묶음으로 흘러가면 정확히 그 사고가
 * 조용히 되살아난다. 없으면 키가 없는 것으로 치고 화면이 닫힌다.
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

/** 환경변수 접두사 — 어느 계좌 묶음인지가 이름에 있다. */
export type OkxKeyPrefix = "OKX_LIVE" | "OKX_MANUAL";

interface Keys {
  key: string;
  secret: string;
  passphrase: string;
}

function readKeys(prefix: OkxKeyPrefix): Keys | null {
  const key = process.env[`${prefix}_API_KEY`];
  const secret = process.env[`${prefix}_API_SECRET`];
  const passphrase = process.env[`${prefix}_API_PASSPHRASE`];
  if (!key || !secret || !passphrase) return null;
  return { key, secret, passphrase };
}

async function publicGet(path: string): Promise<OkxRow[]> {
  const res = await fetch(BASE + path, { headers: { accept: "application/json" } });
  const json = (await res.json()) as { code: string; msg?: string; data: OkxRow[] };
  if (json.code !== "0") throw new Error(`OKX ${path}: ${json.msg || json.code}`);
  return json.data;
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

/** 이 키가 실제로 붙는 계좌 — 화면이 "어디로 주문이 나가는지"를 숫자로 말할 수 있게. */
export interface OkxAccountId {
  uid: string;
  /** 서브계정이면 상위 계정의 uid. 같으면 본인이 메인이다. */
  mainUid: string | null;
}

export interface OkxPosition {
  posSide: "long" | "short";
  pos: number;
  avgPx: number;
  upl: number;
  /** 포지션 슬롯 번호 — 일지의 `okx_pos_id` 와 같은 값. 동기화가 이 번호로 행을 찾는다 */
  posId: string;
}

/** 주문 1건의 체결 상태 — 시장가가 실제로 얼마에 몇 계약 잡혔는지. */
export interface OkxOrderDetail {
  state: string;
  /** 평균 체결가. 아직 체결 전이면 null */
  avgPx: number | null;
  /** 누적 체결 수량(계약) */
  accFillSz: number;
  /** 마지막 체결 시각(ms). 체결 전이면 null */
  fillTime: number | null;
  /** 지금까지 낸 수수료 — 부호 포함(보통 음수) */
  fee: number | null;
}

/**
 * 한 키 묶음에 매인 주문 클라이언트.
 *
 * 메서드는 전부 같은 `privateCall` 을 지나므로 서명·오류 처리·엔드포인트가 한 벌이다.
 * 계좌만 다르다 — 그래서 "어느 계좌인가"는 이 객체를 만든 접두사가 정한다.
 */
export interface OkxTradeClient {
  readonly prefix: OkxKeyPrefix;
  hasKeys(): boolean;
  equityUsd(): Promise<number>;
  accountConfig(): Promise<OkxRow>;
  accountId(): Promise<OkxAccountId>;
  setLeverage(instId: string, lever: number, posSide: "long" | "short"): Promise<void>;
  openWithBracket(args: {
    instId: string;
    posSide: "long" | "short";
    sz: string;
    stop: number;
    /** 없으면 손절만 부착한다 — 분할 익절 계획을 전량 청산으로 덮어쓰지 않기 위해 */
    target?: number;
    algoClOrdId: string;
    tickSz: number;
    pxDecimals: number;
  }): Promise<string>;
  orderDetails(instId: string, ordId: string): Promise<OkxOrderDetail | null>;
  algoDetails(algoClOrdId: string): Promise<OkxRow | { error: string } | null>;
  cancelAlgo(instId: string, algoId: string): Promise<void>;
  closeMarket(instId: string, posSide: "long" | "short", sz: string): Promise<void>;
  positions(instId: string): Promise<OkxPosition[]>;
}

export function createTradeClient(prefix: OkxKeyPrefix): OkxTradeClient {
  // 부를 때마다 읽는다 — 모듈 로드 시점에 고정하면 테스트·환경 전환에서 옛 값을 문다.
  const keys = () => readKeys(prefix);

  async function privateCall(method: "GET" | "POST", path: string, body?: unknown): Promise<OkxRow[]> {
    const k = keys();
    if (!k) {
      throw new Error(
        `OKX 주문 키가 없습니다 — ${prefix}_API_KEY/SECRET/PASSPHRASE 를 확인하세요.`,
      );
    }
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

  const accountConfig = async (): Promise<OkxRow> => {
    const [d] = await privateCall("GET", "/api/v5/account/config");
    return d;
  };

  return {
    prefix,
    hasKeys: () => keys() !== null,

    async equityUsd() {
      const [d] = await privateCall("GET", "/api/v5/account/balance?ccy=USDT");
      const details = d.details as unknown as { ccy: string; eq: string }[] | undefined;
      const usdt = details?.find((x) => x.ccy === "USDT");
      return Number(usdt?.eq ?? d.totalEq);
    },

    accountConfig,

    async accountId() {
      const d = await accountConfig();
      return { uid: d.uid ?? "", mainUid: d.mainUid ?? null };
    },

    async setLeverage(instId, lever, posSide) {
      await privateCall("POST", "/api/v5/account/set-leverage", {
        instId,
        lever: String(lever),
        mgnMode: "isolated",
        posSide,
      });
    },

    /** 시장가 진입 + 손절(·목표) 동시 부착 — 봇과 같은 원자적 브래킷. */
    async openWithBracket(args) {
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
            ...(args.target === undefined
              ? {}
              : { tpTriggerPx: px(args.target), tpOrdPx: "-1", tpTriggerPxType: "last" }),
            slTriggerPx: px(args.stop),
            slOrdPx: "-1",
            slTriggerPxType: "last",
          },
        ],
      });
      return String(d.ordId);
    },

    async orderDetails(instId, ordId) {
      const data = await privateCall(
        "GET",
        `/api/v5/trade/order?instId=${encodeURIComponent(instId)}&ordId=${encodeURIComponent(ordId)}`,
      );
      const d = data[0];
      if (!d) return null;
      const num = (v: string | undefined) => {
        if (v === undefined || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      return {
        state: d.state ?? "",
        avgPx: num(d.avgPx),
        accFillSz: num(d.accFillSz) ?? 0,
        fillTime: num(d.fillTime),
        fee: num(d.fee),
      };
    },

    async algoDetails(algoClOrdId) {
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
    },

    async cancelAlgo(instId, algoId) {
      await privateCall("POST", "/api/v5/trade/cancel-algos", [{ instId, algoId }]);
    },

    async closeMarket(instId, posSide, sz) {
      await privateCall("POST", "/api/v5/trade/order", {
        instId,
        tdMode: "isolated",
        side: posSide === "long" ? "sell" : "buy",
        posSide,
        ordType: "market",
        sz,
      });
    },

    async positions(instId) {
      const data = await privateCall("GET", `/api/v5/account/positions?instId=${instId}`);
      return data
        .filter((p) => Number(p.pos) !== 0)
        .map((p) => ({
          posSide: p.posSide as "long" | "short",
          pos: Number(p.pos),
          avgPx: Number(p.avgPx),
          upl: Number(p.upl),
          posId: String(p.posId ?? ""),
        }));
    },
  };
}

/* ============ 봇 서브계정(`OKX_LIVE_*`) — 기존 호출부가 쓰는 이름 그대로 ============ */

const live = createTradeClient("OKX_LIVE");

export function hasLiveKeys(): boolean {
  return live.hasKeys();
}
export const equityUsd: OkxTradeClient["equityUsd"] = () => live.equityUsd();
export const accountConfig: OkxTradeClient["accountConfig"] = () => live.accountConfig();
export const accountId: OkxTradeClient["accountId"] = () => live.accountId();
export const setLeverage: OkxTradeClient["setLeverage"] = (...a) => live.setLeverage(...a);
export const openWithBracket: OkxTradeClient["openWithBracket"] = (a) => live.openWithBracket(a);
export const algoDetails: OkxTradeClient["algoDetails"] = (a) => live.algoDetails(a);
export const cancelAlgo: OkxTradeClient["cancelAlgo"] = (...a) => live.cancelAlgo(...a);
export const closeMarket: OkxTradeClient["closeMarket"] = (...a) => live.closeMarket(...a);
export const positions: OkxTradeClient["positions"] = (a) => live.positions(a);

/**
 * 주 매매계정(`OKX_MANUAL_*`) — 근거를 적은 뒤 사람이 내는 주문의 통로.
 *
 * 매번 새로 만들지만 키는 부를 때 읽으므로 비용은 없다. 이 클라이언트가 향하는 계좌는
 * 호출부가 반드시 `accountId()` 로 확인하고 화면에 적는다 — 주문 화면의 불변식이다.
 */
export function manualClient(): OkxTradeClient {
  return createTradeClient("OKX_MANUAL");
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
