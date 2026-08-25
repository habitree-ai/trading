/**
 * 스윕과 프런티어가 공유하는 실행부.
 *
 * sweep.mjs 는 4,464개의 요약만 남기고 거래는 버린다(메모리).
 * frontier.mjs 는 생존한 소수만 여기서 다시 돌려 거래를 되살린다.
 * 같은 함수를 쓰므로 두 단계의 숫자가 어긋날 수 없다.
 */
import { HTF_OF, TFS, buildFundingIndex, loadCache } from "./data.mjs";
import { EXITS, FAMILIES, FILTERS, buildContext } from "./signals.mjs";
import { netPct, signalIndices, simulate } from "./engine.mjs";

export const WARMUP = 300;
export const COST = { taker: 0.1, maker: 0.07, slippage: 0.02 };
/** 판정 기준 비용 — 테이커 + 슬리피지. 펀딩은 보유 기간에 따라 따로 붙는다. */
export const GATE_FEE = COST.taker;
export const GATE_SLIP = COST.slippage;

export const SAMPLE_MIN = { "15m": 400, "1H": 250, "4H": 150 };
export const TF_LIST = ["15m", "1H", "4H"];

export function loadAll() {
  const candles = loadCache("candles.json");
  const fundingRaw = loadCache("funding.json");
  const fundingCum = buildFundingIndex(fundingRaw.funding);
  return { data: candles.data, fetchedAt: candles.fetchedAt, funding: fundingRaw.funding, fundingCum };
}

/** 봉별 컨텍스트 — 지표 전체를 한 번만 계산한다. */
export function buildTfContext(data, tf) {
  const candles = data[tf];
  const htfName = HTF_OF[tf];
  return buildContext(candles, data[htfName], TFS[htfName].ms, data["1D"], TFS["1D"].ms, TFS[tf].dayBars);
}

/** (계열 × 방향 × 필터) → 신호 인덱스. 청산 6종이 이 배열을 공유한다. */
export function signalCache(ctx) {
  const cache = new Map();
  for (const [famKey, fam] of Object.entries(FAMILIES)) {
    for (const side of ["long", "short"]) {
      const fn = fam[side];
      for (const [fk, filt] of Object.entries(FILTERS)) {
        cache.set(`${famKey}|${side}|${fk}`, signalIndices(ctx, fn, filt.fn, side, WARMUP));
      }
    }
  }
  return cache;
}

/** 조합 하나 실행 → 거래 배열 + 순손익 배열. */
export function runCombo({ ctx, candles, tf, famKey, side, filterKey, exitKey, signalIdx, fundingCum, fee = GATE_FEE, slip = GATE_SLIP }) {
  const exit = EXITS.find((e) => e.key === exitKey);
  const idx = signalIdx ?? signalIndices(ctx, FAMILIES[famKey][side], FILTERS[filterKey].fn, side, WARMUP);
  const all = simulate(candles, ctx, idx, side, exit, TFS[tf].maxHold);
  const closed = all.filter((t) => t.exitType !== "open");
  const pnls = closed.map((t) => netPct(t, fee, slip, fundingCum));
  return { trades: closed, pnls, openCount: all.length - closed.length };
}

export const comboKey = (tf, famKey, side, filterKey, exitKey) => `${tf}:${famKey}:${side}:${filterKey}:${exitKey}`;

export function parseComboKey(key) {
  const [tf, famKey, side, filterKey, exitKey] = key.split(":");
  return { tf, famKey, side, filterKey, exitKey };
}
