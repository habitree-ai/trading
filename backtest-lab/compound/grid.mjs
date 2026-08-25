/**
 * 그리드 — 기법 9 × 레버리지 4 × 리스크 9 × 묶음 6 = 1,944 설정.
 * 판정은 README §5 게이트로 한다. 여기서 기준을 새로 만들지 않는다.
 */
import { performance } from "node:perf_hooks";
import { loadOut, saveOut } from "../lib/data.mjs";
import { blockBootstrap, cagrPct, maxDrawdownPct } from "../lib/stats.mjs";
import { runBook, START } from "./lib/book.mjs";
import { METHODS, METHOD_KEYS } from "./lib/sizing.mjs";
import { PARTS, SETS } from "./lib/components.mjs";

const LEV_CAPS = [3, 5, 10, 20];
const RISKS = [0.5, 1, 2, 3, 5, 7, 10, 15, 20];
const CONCURRENTS = [2, 3, 5];
const HEAT_CAPS = [null, 6, 3];

const t0 = performance.now();
const built = loadOut("compound-parts.json");
const partsData = built.parts;
const allTrades = Object.values(partsData).flat();

/** 창 — 전 부품이 존재하는 공통 창(주 판정)과 4H 기준 전체 창(참고). */
const firstOf = (k) => (partsData[k]?.length ? partsData[k][0].entryAt : Infinity);
const lastAll = Math.max(...allTrades.map((t) => t.exitAt));
const commonFrom = Math.max(...PARTS.map((p) => firstOf(p.key)));
const fullFrom = Math.min(...PARTS.map((p) => firstOf(p.key)));
const WINDOWS = {
  common: { key: "common", name: "공통 창(전 부품 존재)", from: commonFrom, to: lastAll },
  full: { key: "full", name: "전체 창(4H 기준)", from: fullFrom, to: lastAll },
};
const days = (w) => (w.to - w.from) / 86_400_000;

/** 매수보유 벤치 — 같은 창, 무레버리지. */
const bench = {};
{
  const { loadAll } = await import("../lib/runner.mjs");
  const { data } = loadAll();
  const c4 = data["4H"];
  for (const w of Object.values(WINDOWS)) {
    const a = c4.find((b) => b.t >= w.from);
    const z = [...c4].reverse().find((b) => b.t <= w.to);
    const months = days(w) / 30.4375;
    const total = ((z.c - a.o) / a.o) * 100;
    bench[w.key] = {
      totalPct: Math.round(total * 100) / 100,
      monthlyGeo: Math.round((Math.pow(z.c / a.o, 1 / months) - 1) * 1e4) / 100,
      cagr: cagrPct(a.o, z.c, days(w)),
      mdd: maxDrawdownPct(c4.filter((b) => b.t >= w.from && b.t <= w.to).map((b) => ({ t: b.t, equity: b.c }))),
      days: Math.round(days(w)),
    };
  }
}

/** 창 3등분 각 구간의 월 기하수익 — C6 게이트. */
function thirdsGeo(curve, from, to) {
  const w = (to - from) / 3;
  const bounds = [from, from + w, from + 2 * w, to];
  const eqAt = (ts) => {
    let last = curve[0].equity;
    for (const p of curve) { if (p.t > ts) break; last = p.equity; }
    return last;
  };
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    const a = eqAt(bounds[i]);
    const b = eqAt(bounds[i + 1]);
    const m = (bounds[i + 1] - bounds[i]) / 86_400_000 / 30.4375;
    out.push(a > 0 && b > 0 && m > 0 ? Math.round((Math.pow(b / a, 1 / m) - 1) * 1e4) / 100 : null);
  }
  return out;
}

const tradesOfSet = new Map();
for (const s of SETS) tradesOfSet.set(s.key, s.parts.flatMap((k) => partsData[k] ?? []));

function evaluate(setKey, methodKey, levCap, riskPct, win, maxConcurrent = 3, heatCap = null) {
  const r = runBook(tradesOfSet.get(setKey), {
    method: METHODS[methodKey], riskPct, levCap, maxConcurrent, heatCap,
    from: win.from, to: win.to,
  });
  const boot = r.stepReturns.length >= 60
    ? blockBootstrap(r.stepReturns, { blocks: 20, runs: 1000, start: START, ruinAt: 10, seed: 20260818 })
    : null;
  const thirds = thirdsGeo(r.curve, win.from, win.to);
  const b = bench[win.key];
  const row = {
    set: setKey, method: methodKey, levCap, riskPct, window: win.key, maxConcurrent, heatCap,
    trades: r.trades, tradesPerMonth: r.tradesPerMonth,
    finalEquity: r.finalEquity, cagr: r.cagr, monthlyGeo: r.monthlyGeo,
    mdd: r.mddPessimistic, mar: r.mar, underwaterMaxDays: r.underwaterMaxDays,
    monthlyMedian: r.monthlyMedian, monthWinRate: r.monthWinRate,
    monthlyP10: r.monthlyP10, monthlyP90: r.monthlyP90,
    avgLeverage: r.avgLeverage, avgRiskPct: r.avgRiskPct,
    liquidations: r.liquidations, skipHeat: r.skipHeat, skipMargin: r.skipMargin, skipConcurrent: r.skipConcurrent,
    ruin: boot ? Math.round(boot.ruinPct * 100) / 100 : null,
    bootP05: boot ? boot.p05 : null,
    bootP50: boot ? boot.p50 : null,
    thirds,
  };
  row.c1 = r.liquidations === 0;
  row.c2 = row.ruin !== null && row.ruin <= 1;
  row.c3 = row.mdd !== null && row.mdd >= -40;
  row.c4 = row.mar !== null && row.mar >= 1.0;
  row.c5 = row.monthlyGeo !== null && row.monthlyGeo > 0 && row.monthlyGeo > b.monthlyGeo;
  row.c6 = thirds.every((x) => x !== null && x > 0);
  row.gates = ["c1", "c2", "c3", "c4", "c5", "c6"].filter((g) => row[g]).length;
  row.pass = row.gates === 6;
  return { row, curve: r.curve, monthly: r.monthly };
}

const rows = [];
const curves = {};
for (const s of SETS) {
  for (const m of METHOD_KEYS) {
    for (const lev of LEV_CAPS) {
      for (const risk of RISKS) {
        const { row, curve, monthly } = evaluate(s.key, m, lev, risk, WINDOWS.common);
        rows.push(row);
        if (row.pass || (row.gates >= 5 && row.mar !== null && row.mar >= 1)) {
          curves[`${s.key}|${m}|${lev}|${risk}`] = { curve, monthly };
        }
      }
    }
  }
  console.log(`  ${s.key} 완료 (${rows.length}설정, ${Math.round((performance.now() - t0) / 1000)}s)`);
}

/** 2차 축 — 1차에서 살아남은 설정만 동시 상한 · 히트 상한으로 다시 훑는다. */
const seeds = rows.filter((r) => r.pass).sort((a, b) => (b.mar ?? -9) - (a.mar ?? -9)).slice(0, 12);
const secondary = [];
for (const s of seeds) {
  for (const mc of CONCURRENTS) {
    for (const hc of HEAT_CAPS) {
      if (mc === 3 && hc === null) continue; // 1차와 동일 설정
      const { row } = evaluate(s.set, s.method, s.levCap, s.riskPct, WINDOWS.common, mc, hc);
      secondary.push({ ...row, seedOf: `${s.set}|${s.method}|${s.levCap}|${s.riskPct}` });
    }
  }
}

/** 전체 창 참고치 — 1H 부품이 없는 묶음만 뜻이 있다. */
const fullWindow = [];
for (const s of SETS) {
  const hasHourly = s.parts.some((k) => PARTS.find((p) => p.key === k)?.tf === "1H");
  if (hasHourly) continue;
  for (const m of METHOD_KEYS) {
    for (const lev of LEV_CAPS) {
      for (const risk of RISKS) fullWindow.push(evaluate(s.key, m, lev, risk, WINDOWS.full).row);
    }
  }
}

/** 현행 라이브 재현 — 쿼드 · 고정비율 · 리스크 10% · 상한 10배 · 동시 2. */
const live = evaluate("quad", "m1", 10, 10, WINDOWS.common, 2, null).row;

const passers = rows.filter((r) => r.pass);
const byTolerance = {};
for (const tol of [25, 40, 60]) {
  const pool = rows.filter((r) => r.c1 && r.c2 && r.mdd !== null && r.mdd >= -tol && r.monthlyGeo > 0);
  byTolerance[tol] = pool.sort((a, b) => (b.mar ?? -9) - (a.mar ?? -9)).slice(0, 5);
}

/**
 * 짝지은 기법 비교 — 같은 (묶음 × 레버리지 × 리스크) 칸에서 기법 X − 고정비율(m1).
 * 중앙값 비교는 "리스크 20%에서 무너지는가"를 재게 되어 기법이 아니라 리스크 수준을 비교한다.
 * 칸을 고정하면 남는 것은 자금 기법의 기여뿐이다 — 13회차에서 배운 방식 그대로.
 */
const cellKey = (r) => `${r.set}|${r.levCap}|${r.riskPct}`;
const m1By = new Map(rows.filter((r) => r.method === "m1").map((r) => [cellKey(r), r]));
const pairedTest = (diffs) => {
  const n = diffs.length;
  if (n < 3) return null;
  const m = diffs.reduce((s2, d) => s2 + d, 0) / n;
  const sd = Math.sqrt(diffs.reduce((s2, d) => s2 + (d - m) ** 2, 0) / (n - 1));
  const sorted = [...diffs].sort((a, b) => a - b);
  const med = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const wins = diffs.filter((d) => d > 0).length;
  return {
    n,
    mean: Math.round(m * 1000) / 1000,
    median: Math.round(med * 1000) / 1000,
    t: sd > 0 ? Math.round((m / sd) * Math.sqrt(n) * 100) / 100 : 0,
    wins,
    signZ: Math.round(((wins - n / 2) / Math.sqrt(n / 4)) * 100) / 100,
  };
};
const pairedVsM1 = {};
for (const m of METHOD_KEYS) {
  if (m === "m1") continue;
  const dMar = [];
  const dGeo = [];
  const dMdd = [];
  for (const r of rows.filter((x) => x.method === m)) {
    const b2 = m1By.get(cellKey(r));
    if (!b2) continue;
    if (r.mar !== null && b2.mar !== null) dMar.push(r.mar - b2.mar);
    if (r.monthlyGeo !== null && b2.monthlyGeo !== null) dGeo.push(r.monthlyGeo - b2.monthlyGeo);
    if (r.mdd !== null && b2.mdd !== null) dMdd.push(r.mdd - b2.mdd);
  }
  pairedVsM1[m] = { mar: pairedTest(dMar), geo: pairedTest(dGeo), mdd: pairedTest(dMdd) };
}

/** 게이트별 통과 수 — 어디서 죽는지. */
const funnel = {};
for (const g of ["c1", "c2", "c3", "c4", "c5", "c6"]) funnel[g] = rows.filter((r) => r[g]).length;

/** 기법별 요약 — 선별 없이 전 설정 풀링. 이번 회차의 주 비교다. */
const byMethod = METHOD_KEYS.map((m) => {
  const mine = rows.filter((r) => r.method === m);
  const ok = mine.filter((r) => r.pass);
  const mars = mine.map((r) => r.mar).filter((v) => v !== null);
  const geos = mine.map((r) => r.monthlyGeo).filter((v) => v !== null);
  return {
    method: m, name: METHODS[m].name, family: METHODS[m].family, why: METHODS[m].why, source: METHODS[m].source,
    n: mine.length, passers: ok.length,
    marMedian: mars.length ? Math.round(mars.sort((a, b) => a - b)[Math.floor(mars.length / 2)] * 100) / 100 : null,
    marBest: mars.length ? Math.round(Math.max(...mars) * 100) / 100 : null,
    geoMedian: geos.length ? Math.round(geos.sort((a, b) => a - b)[Math.floor(geos.length / 2)] * 100) / 100 : null,
    liqRate: Math.round((mine.filter((r) => r.liquidations > 0).length / mine.length) * 1000) / 10,
    ruinMedian: (() => {
      const v = mine.map((r) => r.ruin).filter((x) => x !== null).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    })(),
    best: ok.sort((a, b) => (b.mar ?? -9) - (a.mar ?? -9))[0] ?? mine.sort((a, b) => (b.mar ?? -9) - (a.mar ?? -9))[0] ?? null,
  };
});

/** 묶음별 요약. */
const bySet = SETS.map((s) => {
  const mine = rows.filter((r) => r.set === s.key);
  const ok = mine.filter((r) => r.pass);
  return {
    ...s, n: mine.length, passers: ok.length,
    corr: built.setCorr[s.key],
    marBest: mine.length ? Math.round(Math.max(...mine.map((r) => r.mar ?? -9)) * 100) / 100 : null,
    best: ok.sort((a, b) => (b.mar ?? -9) - (a.mar ?? -9))[0] ?? mine.sort((a, b) => (b.mar ?? -9) - (a.mar ?? -9))[0] ?? null,
  };
});

saveOut("compound-grid.json", {
  generatedAt: Date.now(),
  axes: { methods: METHOD_KEYS, levCaps: LEV_CAPS, risks: RISKS, sets: SETS.map((s) => s.key), concurrents: CONCURRENTS, heatCaps: HEAT_CAPS },
  windows: WINDOWS, windowDays: { common: Math.round(days(WINDOWS.common)), full: Math.round(days(WINDOWS.full)) },
  bench, rows, secondary, fullWindow, live, funnel, byMethod, bySet, byTolerance, curves, pairedVsM1,
  methods: METHOD_KEYS.map((k) => ({ key: k, ...METHODS[k], fn: undefined })),
  parts: built.rows, corr: built.corr, corrKeys: built.corrKeys, setCorr: built.setCorr, sets: SETS,
});

console.log("");
console.log(`창 — 공통 ${WINDOWS.common.name}: ${new Date(WINDOWS.common.from).toISOString().slice(0, 10)} ~ ${new Date(WINDOWS.common.to).toISOString().slice(0, 10)} (${Math.round(days(WINDOWS.common))}일)`);
console.log(`매수보유(공통 창): 총 ${bench.common.totalPct}% · 월 기하 ${bench.common.monthlyGeo}% · 낙폭 ${bench.common.mdd}%`);
console.log(`게이트 퍼널: ${JSON.stringify(funnel)} / 전 게이트 통과 ${passers.length}건`);
console.log("");
console.log("기법별 (전 설정 풀링, 선별 없음):");
console.table(byMethod.map((m) => ({
  기법: m.method + " " + m.name, 설정: m.n, 통과: m.passers,
  "MAR 중앙": m.marMedian, "MAR 최고": m.marBest, "월기하 중앙": m.geoMedian,
  "청산 발생률%": m.liqRate, "파산확률 중앙%": m.ruinMedian,
})));
console.log("");
console.log("짝지은 비교 — 같은 (묶음×레버리지×리스크) 칸에서 기법 − 고정비율(m1):");
console.table(Object.entries(pairedVsM1).map(([k, v]) => ({
  기법: k + " " + METHODS[k].name,
  칸: v.mar?.n,
  "MAR차 평균": v.mar?.mean, "MAR차 중앙": v.mar?.median, "MAR t": v.mar?.t,
  "이긴 칸": v.mar ? `${v.mar.wins}/${v.mar.n}` : null,
  "월기하차": v.geo?.median, "낙폭차(+가 개선)": v.mdd?.median,
})));
console.log("");
console.log("묶음별:");
console.table(bySet.map((s) => ({ 묶음: s.key + " " + s.name, 평균상관: s.corr, 설정: s.n, 통과: s.passers, "MAR 최고": s.marBest })));
console.log("");
console.log("현행 라이브 재현(쿼드·고정비율·리스크10·상한10·동시2):");
console.log(`  월 기하 ${live.monthlyGeo}% · CAGR ${live.cagr}% · 낙폭 ${live.mdd}% · MAR ${live.mar} · 청산 ${live.liquidations}건 · 파산확률 ${live.ruin}% · 게이트 ${live.gates}/6`);
console.log("");
console.log("낙폭 허용치별 최선:");
for (const tol of [25, 40, 60]) {
  const b = byTolerance[tol][0];
  console.log(`  −${tol}% 이내: ${b ? `${b.set}·${b.method}·${b.levCap}배·리스크${b.riskPct}% → 월 ${b.monthlyGeo}% · 낙폭 ${b.mdd}% · MAR ${b.mar} · 게이트 ${b.gates}/6` : "없음"}`);
}
console.log(`총 ${Math.round((performance.now() - t0) / 1000)}s`);
