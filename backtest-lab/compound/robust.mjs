/**
 * 견고성 — 그리드 결과를 보고 추가한 검사 셋(README §7 에 사후 추가로 기록).
 *
 * (A) 부품 제거 검사(leave-one-out) — 상위 구성에서 부품을 하나씩 빼 본다.
 *     bzc 하나가 전부를 만들고 있다면 그것은 "복리 시스템"이 아니라 "부품 하나"다.
 * (B) 묶음별 기법 효과 — 변동성 타깃의 우위가 특정 묶음에서만 나는 것인지.
 * (C) 상위 통과 설정의 구간 3등분 — C6 은 통과했지만 얼마나 여유가 있는지.
 */
import { loadOut, saveOut } from "../lib/data.mjs";
import { blockBootstrap, cagrPct, maxDrawdownPct } from "../lib/stats.mjs";
import { runBook, START } from "./lib/book.mjs";
import { METHODS, METHOD_KEYS } from "./lib/sizing.mjs";
import { PARTS, SETS } from "./lib/components.mjs";

const built = loadOut("compound-parts.json");
const grid = loadOut("compound-grid.json");
const partsData = built.parts;
const WIN = grid.windows.common;
const bench = grid.bench.common;

function thirdsGeo(curve, from, to) {
  const w = (to - from) / 3;
  const bounds = [from, from + w, from + 2 * w, to];
  const eqAt = (ts) => { let last = curve[0].equity; for (const p of curve) { if (p.t > ts) break; last = p.equity; } return last; };
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    const a = eqAt(bounds[i]);
    const b = eqAt(bounds[i + 1]);
    const m = (bounds[i + 1] - bounds[i]) / 86_400_000 / 30.4375;
    out.push(a > 0 && b > 0 && m > 0 ? Math.round((Math.pow(b / a, 1 / m) - 1) * 1e4) / 100 : null);
  }
  return out;
}

function run(partKeys, methodKey, levCap, riskPct, maxConcurrent = 3, heatCap = null) {
  const trades = partKeys.flatMap((k) => partsData[k] ?? []);
  const r = runBook(trades, { method: METHODS[methodKey], riskPct, levCap, maxConcurrent, heatCap, from: WIN.from, to: WIN.to });
  const boot = r.stepReturns.length >= 60 ? blockBootstrap(r.stepReturns, { blocks: 20, runs: 1000, start: START, ruinAt: 10, seed: 20260818 }) : null;
  const thirds = thirdsGeo(r.curve, WIN.from, WIN.to);
  return {
    trades: r.trades, monthlyGeo: r.monthlyGeo, cagr: r.cagr, mdd: r.mddPessimistic, mar: r.mar,
    liquidations: r.liquidations, ruin: boot ? boot.ruinPct : null, thirds,
    underwaterMaxDays: r.underwaterMaxDays, monthWinRate: r.monthWinRate, finalEquity: r.finalEquity,
    curve: r.curve, monthly: r.monthly,
    pass: r.liquidations === 0 && boot && boot.ruinPct <= 1 && r.mddPessimistic >= -40 &&
      r.mar !== null && r.mar >= 1 && r.monthlyGeo > bench.monthlyGeo && thirds.every((x) => x !== null && x > 0),
  };
}

/* ── (A) 부품 제거 검사 ── */
const passers = grid.rows.filter((r) => r.pass).sort((a, b) => (b.mar ?? -9) - (a.mar ?? -9));
const top = passers[0];
const topSet = SETS.find((s) => s.key === top.set);
const baseRun = run(topSet.parts, top.method, top.levCap, top.riskPct);
const loo = topSet.parts.map((k) => {
  const rest = topSet.parts.filter((x) => x !== k);
  const r = run(rest, top.method, top.levCap, top.riskPct);
  const solo = run([k], top.method, top.levCap, top.riskPct);
  return {
    removed: k, label: PARTS.find((p) => p.key === k)?.label ?? k,
    mar: r.mar, marDelta: r.mar !== null && baseRun.mar !== null ? Math.round((r.mar - baseRun.mar) * 100) / 100 : null,
    monthlyGeo: r.monthlyGeo, geoDelta: Math.round((r.monthlyGeo - baseRun.monthlyGeo) * 100) / 100,
    mdd: r.mdd, pass: r.pass,
    soloMar: solo.mar, soloGeo: solo.monthlyGeo, soloMdd: solo.mdd, soloPass: solo.pass,
  };
}).sort((a, b) => (a.marDelta ?? 0) - (b.marDelta ?? 0));

/* ── (B) 묶음별 기법 효과 — 변동성 타깃 우위가 어디서 오는가 ── */
const cellKey = (r) => `${r.set}|${r.levCap}|${r.riskPct}`;
const m1By = new Map(grid.rows.filter((r) => r.method === "m1").map((r) => [cellKey(r), r]));
const bySetMethod = {};
for (const s of SETS) {
  bySetMethod[s.key] = {};
  for (const m of METHOD_KEYS) {
    if (m === "m1") continue;
    const d = [];
    for (const r of grid.rows.filter((x) => x.method === m && x.set === s.key)) {
      const b = m1By.get(cellKey(r));
      if (b && r.mar !== null && b.mar !== null) d.push(r.mar - b.mar);
    }
    if (d.length < 3) { bySetMethod[s.key][m] = null; continue; }
    const mu = d.reduce((a, b) => a + b, 0) / d.length;
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - mu) ** 2, 0) / (d.length - 1));
    bySetMethod[s.key][m] = {
      mean: Math.round(mu * 1000) / 1000,
      t: sd > 0 ? Math.round((mu / sd) * Math.sqrt(d.length) * 100) / 100 : 0,
      wins: d.filter((x) => x > 0).length, n: d.length,
    };
  }
}

/* ── (C) 상위 통과 설정 상세 ── */
const detail = passers.slice(0, 8).map((r) => {
  const set = SETS.find((s) => s.key === r.set);
  const full = run(set.parts, r.method, r.levCap, r.riskPct);
  return {
    key: `${r.set}|${r.method}|${r.levCap}|${r.riskPct}`,
    set: r.set, setName: set.name, parts: set.parts, method: r.method, methodName: METHODS[r.method].name,
    levCap: r.levCap, riskPct: r.riskPct,
    trades: r.trades, tradesPerMonth: r.tradesPerMonth, monthlyGeo: r.monthlyGeo, cagr: r.cagr,
    mdd: r.mdd, mar: r.mar, ruin: r.ruin, liquidations: r.liquidations,
    underwaterMaxDays: r.underwaterMaxDays, monthWinRate: r.monthWinRate, monthlyP10: r.monthlyP10,
    avgLeverage: r.avgLeverage, avgRiskPct: r.avgRiskPct, finalEquity: r.finalEquity, thirds: r.thirds,
    bootP05: r.bootP05, bootP50: r.bootP50,
    curve: full.curve, monthly: full.monthly,
  };
});

/* ── 현행 라이브 대비 개선 경로 — 무엇을 하나씩 바꾸면 어떻게 되는가 ── */
const liveBase = { set: "quad", method: "m1", levCap: 10, riskPct: 10, maxConcurrent: 2 };
const quadParts = SETS.find((s) => s.key === "quad").parts;
const path = [
  { name: "현행 라이브 (쿼드·고정비율·10배·리스크10%·동시2)", parts: quadParts, m: "m1", lev: 10, risk: 10, mc: 2 },
  { name: "리스크만 10% → 2%", parts: quadParts, m: "m1", lev: 10, risk: 2, mc: 2 },
  { name: "＋ 변동성 타깃으로 교체", parts: quadParts, m: "m4", lev: 10, risk: 2, mc: 2 },
  { name: "＋ 레버리지 상한 10배 → 5배", parts: quadParts, m: "m4", lev: 5, risk: 2, mc: 2 },
  { name: "＋ 부품을 혼합 9로 확대", parts: SETS.find((s) => s.key === "mix9").parts, m: "m4", lev: 5, risk: 2, mc: 3 },
  { name: "＋ 리스크 2% → 5%", parts: SETS.find((s) => s.key === "mix9").parts, m: "m4", lev: 5, risk: 5, mc: 3 },
].map((step) => {
  const r = run(step.parts, step.m, step.lev, step.risk, step.mc);
  return { ...step, parts: step.parts.length, monthlyGeo: r.monthlyGeo, cagr: r.cagr, mdd: r.mdd, mar: r.mar, ruin: r.ruin, liquidations: r.liquidations, thirds: r.thirds, pass: r.pass, curve: r.curve };
});

saveOut("compound-robust.json", {
  generatedAt: Date.now(),
  top: { ...top, setName: topSet.name, parts: topSet.parts },
  baseRun: { mar: baseRun.mar, monthlyGeo: baseRun.monthlyGeo, mdd: baseRun.mdd, ruin: baseRun.ruin, thirds: baseRun.thirds },
  loo, bySetMethod, detail, path, liveBase,
});

console.log(`상위 통과 설정: ${top.set} · ${top.method} · ${top.levCap}배 · 리스크 ${top.riskPct}% → MAR ${top.mar} · 월 ${top.monthlyGeo}% · 낙폭 ${top.mdd}%`);
console.log("");
console.log("(A) 부품 제거 검사 — 뺐을 때 MAR 이 가장 많이 떨어지는 순:");
console.table(loo.map((x) => ({
  "뺀 부품": x.removed + " " + x.label,
  "MAR(제거후)": x.mar, "MAR 변화": x.marDelta, "월기하(제거후)": x.monthlyGeo, "월기하 변화": x.geoDelta,
  낙폭: x.mdd, "게이트 통과": x.pass ? "O" : "X",
  "단독 MAR": x.soloMar, "단독 월기하": x.soloGeo, "단독 통과": x.soloPass ? "O" : "X",
})));
console.log("");
console.log("(B) 묶음별 변동성 타깃(m4) 효과 — m1 대비 MAR 차:");
console.table(SETS.map((s) => ({
  묶음: s.key, "m4 평균": bySetMethod[s.key].m4?.mean, "m4 t": bySetMethod[s.key].m4?.t,
  "m4 이긴 칸": bySetMethod[s.key].m4 ? `${bySetMethod[s.key].m4.wins}/${bySetMethod[s.key].m4.n}` : null,
  "m0 평균": bySetMethod[s.key].m0?.mean, "m5 평균": bySetMethod[s.key].m5?.mean, "m8 평균": bySetMethod[s.key].m8?.mean,
})));
console.log("");
console.log("(D) 현행 라이브에서 한 걸음씩:");
console.table(path.map((p) => ({
  단계: p.name, 부품: p.parts, "월 기하%": p.monthlyGeo, "CAGR%": p.cagr, "낙폭%": p.mdd, MAR: p.mar,
  "파산확률%": p.ruin, "청산": p.liquidations, "구간 3": p.thirds.join(" / "), "게이트": p.pass ? "6/6" : "미통과",
})));
