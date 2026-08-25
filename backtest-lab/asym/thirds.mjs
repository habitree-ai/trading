/**
 * 4H 구간 안정성 — 누적 곡선이 "한 시기가 전부를 만들었는가"를 묻게 만들었다.
 * 창을 3등분(그리고 연도별)해 기획별 기대값과 대조군 대비 차이를 다시 잰다.
 */
import * as ta from "../lib/indicators.mjs";
import { saveOut } from "../lib/data.mjs";
import { FAMILIES, FILTERS } from "../lib/signals.mjs";
import { signalIndices } from "../lib/engine.mjs";
import { GATE_FEE, GATE_SLIP, WARMUP, loadAll, buildTfContext } from "../lib/runner.mjs";
import { netPctAsym, simulateAsym } from "./lib/asym-engine.mjs";
import { ALL_PLANS, CUT_BARS, ENTRIES, FILTER_KEYS, MAX_HOLD } from "./lib/plans.mjs";
import { asymStats } from "./lib/metrics.mjs";

const TF = "4H";
const { data, fundingCum } = loadAll();
const candles = data[TF];
const ctx = buildTfContext(data, TF);
const ext = {
  atrN: ta.atr(candles, 22),
  chHigh: ta.rollingExtreme(candles.map((b) => b.h), 22, true),
  chLow: ta.rollingExtreme(candles.map((b) => b.l), 22, false),
  dcHigh: ta.rollingExtreme(candles.map((b) => b.h), 10, true),
  dcLow: ta.rollingExtreme(candles.map((b) => b.l), 10, false),
};

const t0 = candles[WARMUP].t;
const t1 = candles[candles.length - 1].t;
const w = (t1 - t0) / 3;
const thirdOf = (ts) => Math.min(2, Math.max(0, Math.floor((ts - t0) / w)));
const yearOf = (ts) => new Date(ts).getUTCFullYear();

const byPlan = {};
for (const plan of ALL_PLANS) {
  const p = plan.timeCut ? { ...plan, timeCut: { ...plan.timeCut, bars: CUT_BARS[TF] } } : plan;
  const all = [];
  const perCombo = new Map();
  for (const e of ENTRIES) {
    for (const side of ["long", "short"]) {
      for (const fk of FILTER_KEYS) {
        const idx = signalIndices(ctx, FAMILIES[e.key][side], FILTERS[fk].fn, side, WARMUP);
        const tr = simulateAsym(candles, ctx, ext, idx, side, p, MAX_HOLD[TF])
          .filter((t) => t.exitType !== "open")
          .map((t) => ({ ...t, net: netPctAsym(t, GATE_FEE, GATE_SLIP, fundingCum) }));
        all.push(...tr);
        perCombo.set(`${e.key}|${side}|${fk}`, tr);
      }
    }
  }
  const thirds = [0, 1, 2].map((k) => {
    const tr = all.filter((t) => thirdOf(t.exitAt) === k);
    const st = tr.length ? asymStats(tr, tr.map((t) => t.net)) : null;
    return st ? { n: st.n, ev: st.ev, pf: st.pf, sum: st.totalPct, payoff: st.payoff, winRate: st.winRate, holdMed: st.holdMed, avgUnits: st.avgUnits, tailShare: st.tailShare, exitTypes: st.exitTypes } : null;
  });
  const years = {};
  for (const y of [...new Set(all.map((t) => yearOf(t.exitAt)))].sort()) {
    const tr = all.filter((t) => yearOf(t.exitAt) === y);
    const st = asymStats(tr, tr.map((t) => t.net));
    years[y] = { n: st.n, ev: st.ev, sum: st.totalPct };
  }
  byPlan[plan.key] = { thirds, years, perCombo };
}

// 구간별 짝지은 차이 — 같은 조합에서 기획 EV − C0 EV, 구간 안에서만.
const pairedThirds = {};
for (const plan of ALL_PLANS) {
  if (plan.key === "C0") continue;
  pairedThirds[plan.key] = [0, 1, 2].map((k) => {
    const diffs = [];
    for (const [ck, tr] of byPlan[plan.key].perCombo) {
      const base = byPlan.C0.perCombo.get(ck);
      const a = tr.filter((t) => thirdOf(t.exitAt) === k);
      const b = base.filter((t) => thirdOf(t.exitAt) === k);
      if (a.length < 8 || b.length < 8) continue;
      diffs.push(a.reduce((s, t) => s + t.net, 0) / a.length - b.reduce((s, t) => s + t.net, 0) / b.length);
    }
    if (diffs.length < 3) return null;
    const m = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - m) ** 2, 0) / (diffs.length - 1));
    return {
      n: diffs.length,
      mean: Math.round(m * 1e4) / 1e4,
      t: sd > 0 ? Math.round((m / sd) * Math.sqrt(diffs.length) * 100) / 100 : 0,
      wins: diffs.filter((d) => d > 0).length,
    };
  });
}

const out = {
  generatedAt: Date.now(),
  window: { from: t0, to: t1 },
  bounds: [t0, t0 + w, t0 + 2 * w, t1],
  byPlan: Object.fromEntries(Object.entries(byPlan).map(([k, v]) => [k, { thirds: v.thirds, years: v.years }])),
  pairedThirds,
};
saveOut("asym-thirds.json", out);

console.log("4H 구간 3등분 — 경계:", out.bounds.map((b) => new Date(b).toISOString().slice(0, 10)).join(" | "));
console.table(["P6", "P2", "P5", "P4", "P1", "P3", "C0"].map((k) => ({
  기획: k,
  "1구간 EV": byPlan[k].thirds[0]?.ev, "2구간 EV": byPlan[k].thirds[1]?.ev, "3구간 EV": byPlan[k].thirds[2]?.ev,
  "1구간 합": byPlan[k].thirds[0]?.sum, "2구간 합": byPlan[k].thirds[1]?.sum, "3구간 합": byPlan[k].thirds[2]?.sum,
  "보유 1/2/3": [0,1,2].map((i)=>byPlan[k].thirds[i]?.holdMed).join("/"),
  "승률 1/2/3": [0,1,2].map((i)=>byPlan[k].thirds[i]?.winRate).join("/"),
  "페이오프 1/2/3": [0,1,2].map((i)=>byPlan[k].thirds[i]?.payoff).join("/"),
})));
console.log("");
console.log("구간별 짝지은 차이(기획 − C0):");
console.table(Object.entries(pairedThirds).map(([k, v]) => ({
  기획: k,
  "1구간": v[0] ? `${v[0].mean} (t=${v[0].t}, ${v[0].wins}/${v[0].n})` : "—",
  "2구간": v[1] ? `${v[1].mean} (t=${v[1].t}, ${v[1].wins}/${v[1].n})` : "—",
  "3구간": v[2] ? `${v[2].mean} (t=${v[2].t}, ${v[2].wins}/${v[2].n})` : "—",
})));
