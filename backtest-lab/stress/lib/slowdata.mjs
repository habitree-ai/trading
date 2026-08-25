/**
 * 15회차 재료 — 창을 늘리기 위한 데이터와 묶음.
 *
 * 14회차의 공통 창은 3.1년이었다. 1H 부품이 2023-05부터라 거기서 잘렸고,
 * 그래서 **2022 하락장이 통째로 빠져 있었다**. 낙폭 게이트(C3)가 하락장에서
 * 시험된 적이 없다는 뜻이고, 그것이 14회차의 가장 큰 구멍이었다.
 *
 * 여기서는 1H 부품을 버리고 4H·1D 부품만 남겨 창을 4.8년으로 늘린다.
 * 부품 수가 줄어 분산이 약해지는 것은 이 실험이 치르는 값이다 — 대신
 * 매수보유가 −77% 빠지는 구간이 들어온다.
 *
 * 1D 캔들은 랩 캐시(2021-09~) 대신 긴 것(2020-01~)을 쓴다. 랩 캐시로는
 * 1D 부품의 워밍업 220봉이 2022-04까지 먹어 창을 다시 잘라먹기 때문이다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAB } from "../../lib/data.mjs";
import { loadAll } from "../../lib/runner.mjs";
import { PARTS, buildPartContext, runPart } from "../../compound/lib/components.mjs";

const TEN_PATH = join(LAB, "..", "scripts", "backtest", ".cache", "ten-candles.json");

/** 4H·1D 부품만 — 1H 를 버리는 대신 창을 4.8년으로 늘린다. */
export const SLOW_KEYS = PARTS.filter((p) => p.tf === "4H" || p.tf === "1D").map((p) => p.key);

export const SLOW_SETS = [
  { key: "quad", name: "쿼드 (현행 라이브)", parts: ["gc", "ob", "fade", "dc"], why: "지금 돌고 있는 구성 — 대조군" },
  { key: "lineage6", name: "검증 계보 6", parts: ["gc", "ob", "fade", "dc", "dch", "mcv"], why: "4H·1D 검증 계보 전부" },
  { key: "basis2", name: "베이시스 2", parts: ["bzc", "bzf"], why: "가격 밖 신호만 — 상관 최저" },
  { key: "mix7", name: "혼합 7", parts: ["gc", "ob", "fade", "dch", "bzc", "bzf", "r5"], why: "14회차 권고 구성에서 1H 부품 2개를 뺀 것" },
  { key: "all10", name: "전체 10", parts: SLOW_KEYS, why: "선별 없음 — 상한 아닌 기준선" },
];

/** 긴 1D 로 갈아끼운 데이터. 4H·15m·1H 는 랩 캐시 그대로. */
export function loadSlow() {
  const base = loadAll();
  const ten = JSON.parse(readFileSync(TEN_PATH, "utf8"));
  const longD1 = ten.data?.["1D"];
  if (!longD1?.length) throw new Error("긴 1D 캔들 없음: " + TEN_PATH);
  const data = { ...base.data, "1D": longD1 };
  return { ...base, data, longDailyFrom: longD1[0].t };
}

/** 부품 스트림 — 비용을 인자로 받는다(체결 스트레스가 여기로 들어온다). */
export function buildSlowParts(cost) {
  const { data, fundingCum, fetchedAt } = loadSlow();
  const ctx = buildPartContext(data);
  const parts = {};
  for (const p of PARTS) {
    if (p.tf !== "4H" && p.tf !== "1D") continue;
    parts[p.key] = runPart(p, ctx, fundingCum, cost);
  }
  return { parts, ctx, data, fetchedAt };
}
