/**
 * OKX v5 API 클라이언트 — 공개(캔들·계약정보) + 개인(잔고·주문·포지션).
 *
 * 모드:
 *   paper — 개인 API를 아예 부르지 않는다(키 불필요). 주문은 엔진이 가상 체결.
 *   demo  — OKX 모의거래. 개인 요청에 `x-simulated-trading: 1` 헤더가 붙는다.
 *           (OKX 웹 > 모의거래에서 발급한 데모 API 키를 써야 한다.)
 *   live  — 실거래. run.mjs 의 이중 안전장치를 통과해야만 도달한다.
 *
 * 키는 환경변수로만 읽는다: OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE.
 * 이 저장소 어디에도 키를 적지 말 것 (.env 는 .gitignore 에 있다).
 */
import { createHmac } from "node:crypto";

const BASE = "https://www.okx.com";

export class OkxClient {
  constructor(mode) {
    this.mode = mode;
    if (mode !== "paper") {
      this.key = process.env.OKX_API_KEY;
      this.secret = process.env.OKX_API_SECRET;
      this.passphrase = process.env.OKX_API_PASSPHRASE;
      if (!this.key || !this.secret || !this.passphrase) {
        throw new Error(
          `${mode} 모드에는 OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE 환경변수가 필요합니다.`,
        );
      }
    }
  }

  /* ---------- 공개 ---------- */

  async #publicGet(path) {
    const res = await fetch(BASE + path, { headers: { accept: "application/json" } });
    const json = await res.json();
    if (json.code !== "0") throw new Error(`OKX ${path}: ${json.msg || json.code}`);
    return json.data;
  }

  /** 마감 캔들만, 오래된 → 최신 순으로. */
  async candles(instId, bar, limit) {
    const data = await this.#publicGet(
      `/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`,
    );
    return data
      .filter((r) => r[8] === "1")
      .map((r) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) }))
      .sort((a, b) => a.t - b.t);
  }

  /** 계약 정보 — 계약 크기(ctVal)·주문 단위(lotSz)·최소 수량(minSz). */
  async instrument(instId) {
    const [d] = await this.#publicGet(`/api/v5/public/instruments?instType=SWAP&instId=${instId}`);
    return {
      ctVal: Number(d.ctVal),
      lotSz: Number(d.lotSz),
      minSz: Number(d.minSz),
      tickSz: Number(d.tickSz),
      // 수량·가격 문자열의 소수 자릿수 — 부동소수점 그대로 보내면 정밀도 위반으로 거절된다.
      szDecimals: (d.lotSz.split(".")[1] ?? "").length,
      pxDecimals: (d.tickSz.split(".")[1] ?? "").length,
    };
  }

  /** 최근 체결가 — 페이퍼 진입가 근사와 라이브 사이징에 쓴다. */
  async lastPrice(instId) {
    const [d] = await this.#publicGet(`/api/v5/market/ticker?instId=${instId}`);
    return Number(d.last);
  }

  /* ---------- 개인 (서명) ---------- */

  async #private(method, path, body) {
    const ts = new Date().toISOString();
    const payload = body ? JSON.stringify(body) : "";
    const sign = createHmac("sha256", this.secret)
      .update(ts + method + path + payload)
      .digest("base64");
    const headers = {
      "OK-ACCESS-KEY": this.key,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": this.passphrase,
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.mode === "demo") headers["x-simulated-trading"] = "1";
    const res = await fetch(BASE + path, { method, headers, body: payload || undefined });
    const json = await res.json();
    if (json.code !== "0") {
      const detail = json.data?.[0]?.sMsg || json.msg || json.code;
      throw new Error(`OKX ${method} ${path}: ${detail}`);
    }
    return json.data;
  }

  /** USDT 기준 계좌 순자산 — 사이징의 분모. */
  async equityUsd() {
    const [d] = await this.#private("GET", "/api/v5/account/balance?ccy=USDT");
    const usdt = d.details?.find((x) => x.ccy === "USDT");
    return Number(usdt?.eq ?? d.totalEq);
  }

  async setLeverage(instId, lever, posSide, mgnMode) {
    await this.#private("POST", "/api/v5/account/set-leverage", {
      instId,
      lever: String(lever),
      mgnMode,
      posSide,
    });
  }

  /**
   * 시장가 진입 + 손절·목표 동시 부착 — 주문과 보호가 한 몸이어야 한다.
   * side: 롱 진입 buy / 숏 진입 sell. posSide: long/short (롱숏 분리 모드 기준).
   * algoClOrdId 로 이 기준의 브래킷을 식별한다 — 같은 방향 병행 포지션이
   * 거래소에서 합산되어도 기준별 손절·목표는 따로 산다.
   */
  async openWithBracket({ instId, side, posSide, sz, stop, target, mgnMode, algoClOrdId, tickSz, pxDecimals }) {
    // 트리거가는 그 종목의 틱 단위로 — 0.1 하드코딩은 instId 를 바꾸는 순간 어긋난다.
    const px = (v) => (Math.round(v / tickSz) * tickSz).toFixed(pxDecimals);
    const [d] = await this.#private("POST", "/api/v5/trade/order", {
      instId,
      tdMode: mgnMode,
      side,
      posSide,
      ordType: "market",
      sz: String(sz),
      attachAlgoOrds: [
        {
          attachAlgoClOrdId: algoClOrdId,
          tpTriggerPx: px(target),
          tpOrdPx: "-1", // 트리거 시 시장가
          tpTriggerPxType: "last",
          slTriggerPx: px(stop),
          slOrdPx: "-1",
          slTriggerPxType: "last",
        },
      ],
    });
    return d.ordId;
  }

  /**
   * 브래킷 상세 — algoClOrdId 로 단건 조회. 상태(state)가 답을 준다:
   * live/pause = 대기 중, effective = 걸렸음(actualSide 가 tp/sl), canceled = 취소됨.
   * (orders-algo-history 는 algoClOrdId 필터를 지원하지 않는다 — 이 엔드포인트가 정본.)
   */
  async algoDetails(algoClOrdId) {
    try {
      const data = await this.#private("GET", `/api/v5/trade/order-algo?algoClOrdId=${algoClOrdId}`);
      return data[0] ?? null;
    } catch (e) {
      // 일시 지연인지 키·권한 문제인지 호출부가 알아야 한다 — 원인을 실어 보낸다.
      return { error: e.message };
    }
  }

  /** 계정 설정 — 포지션 모드(long_short_mode 필요) 사전 점검용. */
  async accountConfig() {
    const [d] = await this.#private("GET", "/api/v5/account/config");
    return d;
  }

  /** 브래킷 취소 — 시한 청산 전에 손절·목표부터 걷는다. */
  async cancelAlgo(instId, algoId) {
    await this.#private("POST", "/api/v5/trade/cancel-algos", [{ instId, algoId }]);
  }

  /**
   * 기준별 수량만큼만 시장가 정리 — close-position 은 그 방향 전체를 닫아 버려서
   * 같은 방향으로 병행 중인 다른 기준까지 끌고 나간다.
   */
  async closeMarket({ instId, posSide, sz, mgnMode }) {
    await this.#private("POST", "/api/v5/trade/order", {
      instId,
      tdMode: mgnMode,
      side: posSide === "long" ? "sell" : "buy",
      posSide,
      ordType: "market",
      sz: String(sz),
    });
  }

  /** 열려 있는 포지션 — 청산 여부 대조(리컨실)용. */
  async positions(instId) {
    const data = await this.#private("GET", `/api/v5/account/positions?instId=${instId}`);
    return data.filter((p) => Number(p.pos) !== 0);
  }
}
