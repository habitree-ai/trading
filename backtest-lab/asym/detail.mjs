/**
 * 리포트용 상세 — 곡선 · R분포 · 표본 원장 · 최고 조합.
 * 여기서 판정을 새로 하지 않는다. sweep 이 정한 것을 보기 좋게 펼칠 뿐이다.
 */
import * as ta from "../lib/indicators.mjs";
import { loadOut, saveOut } from "../lib/data.mjs";
import { FAMILIES, FILTERS } from "../lib/signals.mjs";
import { signalIndices } from "../lib/engine.mjs";
import { GATE_FEE, GATE_SLIP, WARMUP, loadAll, buildTfContext } from "../lib/runner.mjs";
import { netPctAsym, simulateAsym } from "./lib/asym-engine.mjs";
import { ALL_PLANS, CUT_BARS, ENTRIES, FILTER_KEYS, MAX_HOLD } from "./lib/plans.mjs";
import { asymStats, sampleEvenly } from "./lib/metrics.mjs";

const FOCUS = "4H";
const sweep = loadOut("asym.json");
const { data, fundingCum } = loadAll();

const candles = data[FOCUS];
const ctx = buildTfContext(data, FOCUS);
const ext = {
  atrN: ta.atr(candles, 22),
  chHigh: ta.rollingExtreme(candles.map((b) => b.h), 22, true),
  chLow: ta.rollingExtreme(candles.map((b) => b.l), 22, false),
  dcHigh: ta.rollingExtreme(candles.map((b) => b.h), 10, true),
  dcLow: ta.rollingExtreme(candles.map((b) => b.l), 10, false),
};

const sigOf = new Map();
for (const e of ENTRIES) {
  for (const side of ["long", "short"]) {
    for (const fk of FILTER_KEYS) {
      sigOf.set(`${e.key}|${side}|${fk}`, signalIndices(ctx, FAMILIES[e.key][side], FILTERS[fk].fn, side, WARMUP));
    }
  }
}

const runOne = (plan, entryKey, side, fk) => {
  const p = plan.timeCut ? { ...plan, timeCut: { ...plan.timeCut, bars: CUT_BARS[FOCUS] } } : plan;
  const all = simulateAsym(candles, ctx, ext, sigOf.get(`${entryKey}|${side}|${fk}`), side, p, MAX_HOLD[FOCUS]);
  return all
    .filter((t) => t.exitType !== "open")
    .map((t) => ({ ...t, net: Math.round(netPctAsym(t, GATE_FEE, GATE_SLIP, fundingCum) * 1e4) / 1e4 }));
};

/** R 배수 히스토그램 — 비대칭의 형태를 눈으로 보게 하는 그림. */
const R_BINS = [-Infinity, -2, -1.5, -1, -0.5, 0, 0.5, 1, 2, 3, 5, 8, Infinity];
const rHist = (trades) => {
  const counts = new Array(R_BINS.length - 1).fill(0);
  for (const t of trades) {
    const r = t.slPct > 0 ? t.net / t.slPct : 0;
    let b = R_BINS.findIndex((_, i) => i < R_BINS.length - 1 && r >= R_BINS[i] && r < R_BINS[i + 1]);
    if (b < 0) b = counts.length - 1;
    counts[b] += 1;
  }
  return counts;
};

const detail = { focus: FOCUS, rBins: R_BINS.map((v) => (Number.isFinite(v) ? v : (v > 0 ? 99 : -99))), plans: {} };

for (const plan of ALL_PLANS) {
  const pooled = [];
  for (const e of ENTRIES) {
    for (const side of ["long", "short"]) {
      for (const fk of FILTER_KEYS) pooled.push(...runOne(plan, e.key, side, fk));
    }
  }
  pooled.sort((a, b) => a.exitAt - b.exitAt);

  // 누적 곡선 — 1× 명목 기준 순손익의 단순 누적. 복리가 아니라 형태를 보는 그림이다.
  let cum = 0;
  const curveFull = pooled.map((t) => {
    cum += t.net;
    return { t: t.exitAt, cum: Math.round(cum * 100) / 100 };
  });
  const step = Math.max(1, Math.ceil(curveFull.length / 400));
  const curve = curveFull.filter((_, i) => i % step === 0 || i === curveFull.length - 1);

  // 이 기획의 4H 최고 조합 — 표본 게이트를 통과한 것 중 EV 최고. 인샘플 선별임을 리포트에 명시한다.
  const mine = sweep.rows.filter((r) => r.plan === plan.key && r.tf === FOCUS && r.g1);
  const best = mine.slice().sort((a, b) => b.ev - a.ev)[0] ?? null;
  let bestSample = null;
  let bestStats = null;
  if (best) {
    const [, entryKey, side, fk] = best.key.split(":");
    const tr = runOne(plan, entryKey, side, fk).sort((a, b) => a.entryAt - b.entryAt);
    bestStats = asymStats(tr, tr.map((t) => t.net));
    bestSample = sampleEvenly(tr, 30).map(({ v }) => ({
      entryAt: v.entryAt, exitAt: v.exitAt, side: v.side, entry: Math.round(v.entry * 100) / 100,
      exit: v.exit, exitType: v.exitType, holdBars: v.holdBars, slPct: v.slPct,
      maePct: v.maePct, mfePct: v.mfePct, net: v.net,
      r: v.slPct > 0 ? Math.round((v.net / v.slPct) * 100) / 100 : null,
      units: v.peakUnits,
    }));
  }

  detail.plans[plan.key] = {
    curve,
    curveN: curveFull.length,
    finalCum: Math.round(cum * 100) / 100,
    rHist: rHist(pooled),
    best: best
      ? {
          key: best.key, entry: best.entry, side: best.side, filter: best.filter,
          n: bestStats.n, ev: bestStats.ev, pf: bestStats.pf, t: bestStats.t, winRate: bestStats.winRate,
          payoff: bestStats.payoff, tailShare: bestStats.tailShare, evExTail: bestStats.evExTail,
          breachRate: bestStats.breachRate, breachGrossRate: bestStats.breachGrossRate,
          worstR: bestStats.worstR, bestR: bestStats.bestR, captureRate: bestStats.captureRate,
          holdMed: bestStats.holdMed, holdMax: bestStats.holdMax, totalPct: bestStats.totalPct,
          thirds: best.thirds, thirdsPos: best.thirdsPos, exitTypes: bestStats.exitTypes,
          gates: { g1: best.g1, g2: best.g2, g3: best.g3, g4: best.g4, g5: best.g5, g6: best.g6, g7: best.g7 },
        }
      : null,
    sample: bestSample,
  };
  console.log(`  ${plan.key} — 풀링 ${curveFull.length}건, 누적 ${cum.toFixed(1)}%, 최고조합 ${best?.key ?? "없음"}`);
}

// 전체 최고 조합 표 — 봉 무관, 표본 통과분 중 EV 상위. 인샘플 선별임을 명시한다.
const topRows = sweep.rows
  .filter((r) => r.g1 && r.plan !== "C0")
  .sort((a, b) => b.ev - a.ev)
  .slice(0, 15)
  .map((r) => ({
    key: r.key, tf: r.tf, entry: r.entry, side: r.side, filter: r.filter, plan: r.plan,
    n: r.n, ev: r.ev, pf: r.pf, t: r.t, winRate: r.winRate, payoff: r.payoff,
    tailShare: r.tailShare, breachRate: r.breachRate, breachGrossRate: r.breachGrossRate,
    holdMed: r.holdMed, thirdsPos: r.thirdsPos, gates: r.gates, gatesApplicable: r.gatesApplicable,
  }));

saveOut("asym-detail.json", { generatedAt: Date.now(), ...detail, topRows });
console.log(`\n저장 → out/asym-detail.json (상위 조합 ${topRows.length})`);
