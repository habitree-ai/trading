/**
 * D1 — 창 확장. 하락장을 포함한 4.75년 창에서 14회차 그리드를 그대로 다시 돌린다.
 * 게이트도 축도 바꾸지 않는다. 바뀌는 것은 창과 부품 수뿐이다.
 */
import { performance } from "node:perf_hooks";
import { saveOut } from "../lib/data.mjs";
import { METHOD_KEYS, METHODS } from "../compound/lib/sizing.mjs";
import { PARTS } from "../compound/lib/components.mjs";
import { SLOW_SETS, buildSlowParts } from "./lib/slowdata.mjs";
import { buyHold, evalCell } from "./lib/evalcell.mjs";

const LEV_CAPS = [3, 5, 10, 20];
const RISKS = [0.5, 1, 2, 3, 5, 7, 10, 15, 20];
const COST = { fee: 0.1, slip: 0.02 };

const t0 = performance.now();
const { parts, data, fetchedAt } = buildSlowParts(COST);

/** 창 — 전 부품이 존재하는 지점부터. 묶음마다 다르면 비교가 안 되므로 하나로 통일한다. */
const firstOf = (k) => (parts[k]?.length ? parts[k][0].entryAt : Infinity);
const usedKeys = [...new Set(SLOW_SETS.flatMap((s) => s.parts))];
const from = Math.max(...usedKeys.map(firstOf));
const to = Math.max(...Object.values(parts).flat().map((t) => t.exitAt));
const bench = buyHold(data["4H"], from, to);
console.log(`창 ${new Date(from).toISOString().slice(0, 10)} ~ ${new Date(to).toISOString().slice(0, 10)} (${bench.days}일)`);
console.log(`매수보유: 총 ${bench.totalPct}% · 월 기하 ${bench.monthlyGeo}% · 최대낙폭 ${bench.mdd}%`);

const tradesOf = new Map(SLOW_SETS.map((s) => [s.key, s.parts.flatMap((k) => parts[k] ?? [])]));

const rows = [];
const curves = {};
for (const s of SLOW_SETS) {
  for (const m of METHOD_KEYS) {
    for (const lev of LEV_CAPS) {
      for (const risk of RISKS) {
        const { row, curve, monthly } = evalCell({
          trades: tradesOf.get(s.key), methodKey: m, levCap: lev, riskPct: risk,
          from, to, benchMonthlyGeo: bench.monthlyGeo,
        });
        rows.push({ set: s.key, ...row });
        if (row.pass) curves[`${s.key}|${m}|${lev}|${risk}`] = { curve, monthly };
      }
    }
  }
  console.log(`  ${s.key} 완료 (${rows.length}설정, ${Math.round((performance.now() - t0) / 1000)}s)`);
}

/** 현행 라이브 재현 — 이 창에서는 하락장을 통과한다. */
const live = { set: "quad", ...evalCell({
  trades: tradesOf.get("quad"), methodKey: "m1", levCap: 10, riskPct: 10, maxConcurrent: 2,
  from, to, benchMonthlyGeo: bench.monthlyGeo,
}).row };

const passers = rows.filter((r) => r.pass);
const dist = (key, vals) => Object.fromEntries(vals.map((v) => [v, passers.filter((r) => r[key] === v).length]));
const passDist = {
  levCap: dist("levCap", LEV_CAPS),
  risk: dist("riskPct", RISKS),
  method: Object.fromEntries(METHOD_KEYS.map((m) => [m, passers.filter((r) => r.method === m).length])),
  set: Object.fromEntries(SLOW_SETS.map((s) => [s.key, passers.filter((r) => r.set === s.key).length])),
};

/** D1 판정 — 사전 등록: 통과가 3·5배에 몰리고 리스크 3% 이하에 몰릴 것. */
const lowLev = passDist.levCap[3] + passDist.levCap[5];
const highLev = passDist.levCap[10] + passDist.levCap[20];
const lowRisk = [0.5, 1, 2, 3].reduce((s, r) => s + passDist.risk[r], 0);
const d1 = {
  lowLev, highLev, lowRisk, total: passers.length,
  levHolds: passers.length > 0 && lowLev > highLev,
  riskHolds: passers.length > 0 && lowRisk > passers.length / 2,
};
d1.pass = d1.levHolds && d1.riskHolds;

/** 짝지은 기법 비교 — 14회차와 같은 방식으로 다시. */
const cellKey = (r) => `${r.set}|${r.levCap}|${r.riskPct}`;
const m1By = new Map(rows.filter((r) => r.method === "m1").map((r) => [cellKey(r), r]));
const pairedTest = (d) => {
  const n = d.length;
  if (n < 3) return null;
  const mu = d.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - mu) ** 2, 0) / (n - 1));
  const sorted = [...d].sort((a, b) => a - b);
  return {
    n, mean: Math.round(mu * 1000) / 1000,
    median: Math.round((n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) * 1000) / 1000,
    t: sd > 0 ? Math.round((mu / sd) * Math.sqrt(n) * 100) / 100 : 0,
    wins: d.filter((x) => x > 0).length,
  };
};
const pairedVsM1 = {};
for (const m of METHOD_KEYS) {
  if (m === "m1") continue;
  const dMar = [], dGeo = [], dMdd = [];
  for (const r of rows.filter((x) => x.method === m)) {
    const b = m1By.get(cellKey(r));
    if (!b) continue;
    if (r.mar !== null && b.mar !== null) dMar.push(r.mar - b.mar);
    if (r.monthlyGeo !== null && b.monthlyGeo !== null) dGeo.push(r.monthlyGeo - b.monthlyGeo);
    if (r.mdd !== null && b.mdd !== null) dMdd.push(r.mdd - b.mdd);
  }
  pairedVsM1[m] = { mar: pairedTest(dMar), geo: pairedTest(dGeo), mdd: pairedTest(dMdd) };
}

const funnel = {};
for (const g of ["c1", "c2", "c3", "c4", "c5", "c6"]) funnel[g] = rows.filter((r) => r[g] === true).length;

/** 레버리지 × 리스크 격자. */
const levRiskGrid = LEV_CAPS.map((lev) => ({
  levCap: lev,
  cells: RISKS.map((risk) => {
    const cell = rows.filter((r) => r.levCap === lev && r.riskPct === risk);
    return {
      risk, total: cell.length,
      pass: cell.filter((r) => r.pass).length,
      liq: cell.filter((r) => r.liquidations > 0).length,
      bestMar: cell.length ? Math.round(Math.max(...cell.map((r) => r.mar ?? -9)) * 100) / 100 : null,
    };
  }),
}));

const compounders = passers.filter((r) => r.method !== "m0").sort((a, b) => (b.mar ?? -9) - (a.mar ?? -9));

saveOut("stress-window.json", {
  generatedAt: Date.now(), fetchedAt, cost: COST,
  window: { from, to, days: bench.days }, bench,
  axes: { methods: METHOD_KEYS, levCaps: LEV_CAPS, risks: RISKS, sets: SLOW_SETS.map((s) => s.key) },
  sets: SLOW_SETS, partStats: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, {
    n: v.length, from: v[0]?.entryAt ?? null, to: v[v.length - 1]?.exitAt ?? null,
    label: PARTS.find((p) => p.key === k)?.label ?? k, tf: PARTS.find((p) => p.key === k)?.tf,
    side: PARTS.find((p) => p.key === k)?.side, origin: PARTS.find((p) => p.key === k)?.origin,
    totalPct: Math.round(v.reduce((s, t) => s + t.net, 0) * 10) / 10,
    winRate: v.length ? Math.round((v.filter((t) => t.net > 0).length / v.length) * 1e4) / 100 : null,
    ev: v.length ? Math.round((v.reduce((s, t) => s + t.net, 0) / v.length) * 1e4) / 1e4 : null,
  }])),
  rows, curves, live, passDist, d1, pairedVsM1, funnel, levRiskGrid,
  topPassers: passers.sort((a, b) => (b.mar ?? -9) - (a.mar ?? -9)).slice(0, 12),
  compounderTop: compounders.slice(0, 10),
});

console.log("");
console.log(`게이트 퍼널: ${JSON.stringify(funnel)} / 전 게이트 통과 ${passers.length}건`);
console.log(`D1 판정: 레버리지 저(3·5배) ${lowLev} vs 고(10·20배) ${highLev} → ${d1.levHolds ? "유지" : "무너짐"} · 리스크 3% 이하 ${lowRisk}/${passers.length} → ${d1.riskHolds ? "유지" : "무너짐"} · ${d1.pass ? "D1 통과" : "D1 실패"}`);
console.log("");
console.log("레버리지 분포:", JSON.stringify(passDist.levCap), "· 리스크 분포:", JSON.stringify(passDist.risk));
console.log("기법 분포:", JSON.stringify(passDist.method), "· 묶음 분포:", JSON.stringify(passDist.set));
console.log("");
console.log("현행 라이브(쿼드·고정비율·10배·10%·동시2) — 하락장 포함 창:");
console.log(`  월 기하 ${live.monthlyGeo}% · CAGR ${live.cagr}% · 낙폭 ${live.mdd}% · MAR ${live.mar} · 청산 ${live.liquidations}건 · 파산확률 ${live.ruin}% · 게이트 ${live.gates}/6`);
console.log(`  구간 3등분 ${live.thirds.join(" / ")}`);
console.log("");
console.log("복리 부문 상위 6 (m0 제외):");
console.table(compounders.slice(0, 6).map((r) => ({
  구성: r.set, 기법: r.method + " " + METHODS[r.method].name, 레버: r.levCap + "배", 리스크: r.riskPct + "%",
  "월기하%": r.monthlyGeo, "CAGR%": r.cagr, "낙폭%": r.mdd, MAR: r.mar, "파산%": r.ruin,
  "최장수중일": r.underwaterMaxDays, "구간3": r.thirds.join("/"),
})));
console.log("");
console.log("짝지은 기법 비교 (m1 대비):");
console.table(Object.entries(pairedVsM1).map(([k, v]) => ({
  기법: k + " " + METHODS[k].name, "MAR차 평균": v.mar?.mean, "MAR차 중앙": v.mar?.median,
  t: v.mar?.t, "이긴 칸": v.mar ? `${v.mar.wins}/${v.mar.n}` : null,
  "월기하차": v.geo?.median, "낙폭차": v.mdd?.median,
})));
console.log(`총 ${Math.round((performance.now() - t0) / 1000)}s`);
