/**
 * 복리 회차 리포트 — 재계산하지 않는다. out/*.json 의 수치를 그대로 옮긴다.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OUT_DIR, loadOut } from "../lib/data.mjs";
import { METHODS, METHOD_KEYS } from "./lib/sizing.mjs";
import { PARTS, SETS } from "./lib/components.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const built = loadOut("compound-parts.json");
const grid = loadOut("compound-grid.json");
const robust = loadOut("compound-robust.json");
const rr = loadOut("compound-rr.json");

const passers = grid.rows.filter((r) => r.pass).sort((a, b) => (b.mar ?? -9) - (a.mar ?? -9));
const compounders = passers.filter((r) => r.method !== "m0");

/** 권고 3종 — 낙폭 허용치별. 복리가 실제로 작동하는 기법(m0 제외)에서 고른다. */
const pickFor = (tol) =>
  compounders.filter((r) => r.mdd >= -tol).sort((a, b) => (b.mar ?? -9) - (a.mar ?? -9))[0] ?? null;
/**
 * 공격 단계는 사전 등록 게이트로는 만들 수 없다 — C3 가 낙폭을 40%로 막고 있어
 * −40 칸과 −60 칸이 같은 답을 낸다. 그래서 **C3 만 명시적으로 완화**한 풀에서 고르고,
 * 카드에 "게이트 하나를 푼 경우"임을 표시한다. 나머지 다섯 게이트는 그대로 요구한다.
 */
const relaxed = grid.rows
  .filter((r) => r.method !== "m0" && r.c1 && r.c2 && r.c4 && r.c5 && r.c6 && r.mdd >= -60)
  .sort((a, b) => (b.mar ?? -9) - (a.mar ?? -9));
const recommend = [
  { tol: 25, label: "보수 — 낙폭 25% 이내", row: pickFor(25), gates: 6 },
  { tol: 40, label: "표준 — 낙폭 40% 이내", row: pickFor(40), gates: 6 },
  { tol: 60, label: "공격 — 낙폭 60% 이내", row: relaxed[0] ?? null, gates: relaxed[0]?.pass ? 6 : 5, relaxedC3: !(relaxed[0]?.pass) },
];

const curveOf = (r) => (r ? grid.curves[`${r.set}|${r.method}|${r.levCap}|${r.riskPct}`] ?? null : null);

/** 레버리지 × 리스크 격자 — 통과 수. 어디에 살 수 있는 땅이 있는지 한 장으로 보여준다. */
const levRiskGrid = grid.axes.levCaps.map((lev) => ({
  levCap: lev,
  cells: grid.axes.risks.map((risk) => {
    const cell = grid.rows.filter((r) => r.levCap === lev && r.riskPct === risk);
    return {
      risk,
      total: cell.length,
      pass: cell.filter((r) => r.pass).length,
      liq: cell.filter((r) => r.liquidations > 0).length,
      bestMar: cell.length ? Math.max(...cell.map((r) => r.mar ?? -9)) : null,
      medMdd: (() => {
        const v = cell.map((r) => r.mdd).filter((x) => x !== null).sort((a, b) => a - b);
        return v.length ? v[Math.floor(v.length / 2)] : null;
      })(),
    };
  }),
}));

const payload = {
  generatedAt: Date.now(),
  windows: grid.windows, windowDays: grid.windowDays, bench: grid.bench,
  parts: built.rows, corr: built.corr, corrKeys: built.corrKeys, setCorr: built.setCorr,
  windowNote: built.windowNote, basisCoverage: built.basisCoverage,
  sets: SETS.map((s) => ({ key: s.key, name: s.name, parts: s.parts, why: s.why, corr: built.setCorr[s.key] })),
  methods: METHOD_KEYS.map((k) => ({ key: k, name: METHODS[k].name, family: METHODS[k].family, why: METHODS[k].why, source: METHODS[k].source })),
  byMethod: grid.byMethod.map((m) => ({ ...m, best: m.best ? { set: m.best.set, levCap: m.best.levCap, riskPct: m.best.riskPct, mar: m.best.mar, monthlyGeo: m.best.monthlyGeo, mdd: m.best.mdd } : null })),
  bySet: grid.bySet.map((s) => ({ key: s.key, name: s.name, corr: s.corr, n: s.n, passers: s.passers, marBest: s.marBest })),
  pairedVsM1: grid.pairedVsM1,
  bySetMethod: robust.bySetMethod,
  funnel: grid.funnel, totalConfigs: grid.rows.length, passCount: passers.length,
  levRiskGrid,
  topPassers: passers.slice(0, 12).map((r) => ({ set: r.set, method: r.method, levCap: r.levCap, riskPct: r.riskPct, monthlyGeo: r.monthlyGeo, cagr: r.cagr, mdd: r.mdd, mar: r.mar, ruin: r.ruin, underwaterMaxDays: r.underwaterMaxDays, monthWinRate: r.monthWinRate, tradesPerMonth: r.tradesPerMonth, finalEquity: r.finalEquity, thirds: r.thirds })),
  compounderTop: compounders.slice(0, 8).map((r) => ({ set: r.set, method: r.method, levCap: r.levCap, riskPct: r.riskPct, monthlyGeo: r.monthlyGeo, cagr: r.cagr, mdd: r.mdd, mar: r.mar, ruin: r.ruin, underwaterMaxDays: r.underwaterMaxDays, monthWinRate: r.monthWinRate, monthlyP10: r.monthlyP10, tradesPerMonth: r.tradesPerMonth, finalEquity: r.finalEquity, thirds: r.thirds, avgLeverage: r.avgLeverage, avgRiskPct: r.avgRiskPct })),
  passDist: {
    method: Object.fromEntries(METHOD_KEYS.map((m) => [m, passers.filter((r) => r.method === m).length])),
    set: Object.fromEntries(SETS.map((s) => [s.key, passers.filter((r) => r.set === s.key).length])),
    levCap: Object.fromEntries(grid.axes.levCaps.map((l) => [l, passers.filter((r) => r.levCap === l).length])),
    risk: Object.fromEntries(grid.axes.risks.map((x) => [x, passers.filter((r) => r.riskPct === x).length])),
  },
  live: grid.live,
  path: robust.path.map((p) => ({ name: p.name, parts: p.parts, monthlyGeo: p.monthlyGeo, cagr: p.cagr, mdd: p.mdd, mar: p.mar, ruin: p.ruin, liquidations: p.liquidations, thirds: p.thirds, pass: p.pass, curve: p.curve })),
  loo: robust.loo, looBase: robust.baseRun, looTop: robust.top,
  rr: { anchor: rr.anchor, ratios: rr.ratios, rows: rr.rows, curves: rr.curves, baseKeys: rr.baseKeys },
  recommend: recommend.map((x) => ({ ...x, curve: curveOf(x.row)?.curve ?? null, monthly: curveOf(x.row)?.monthly ?? null })),
  secondary: grid.secondary.map((r) => ({ seedOf: r.seedOf, maxConcurrent: r.maxConcurrent, heatCap: r.heatCap, mar: r.mar, monthlyGeo: r.monthlyGeo, mdd: r.mdd, pass: r.pass, trades: r.trades })),
};

// 매수보유 곡선 — 가격 데이터를 그대로 옮기는 것이지 새로 계산하는 판정이 아니다.
{
  const { loadAll } = await import("../lib/runner.mjs");
  const { data } = loadAll();
  const w = grid.windows.common;
  const seg = data["4H"].filter((b) => b.t >= w.from && b.t <= w.to);
  const base = seg[0].o;
  const step = Math.max(1, Math.ceil(seg.length / 400));
  payload.benchCurve = seg
    .filter((_, i) => i % step === 0 || i === seg.length - 1)
    .map((b) => ({ t: b.t, equity: Math.round((b.c / base) * 10000) / 100 }));
}

const tpl = readFileSync(join(HERE, "report-template.html"), "utf8");
mkdirSync(OUT_DIR, { recursive: true });
const out = join(OUT_DIR, "compound-report.html");
writeFileSync(out, tpl.replace("__DATA_JSON__", JSON.stringify(payload)));
console.log(`저장 → out/compound-report.html (${Math.round(readFileSync(out).length / 1024)}KB)`);
