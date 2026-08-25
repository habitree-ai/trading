/**
 * 비대칭 스윕 — 576조합 + 랜덤 진입 대조 + 매수보유.
 * 판정은 asym/README.md §1 게이트로 한다. 여기서 기준을 새로 만들지 않는다.
 */
import { performance } from "node:perf_hooks";
import * as ta from "../lib/indicators.mjs";
import { saveOut } from "../lib/data.mjs";
import { FAMILIES, FILTERS } from "../lib/signals.mjs";
import { signalIndices } from "../lib/engine.mjs";
import { GATE_FEE, GATE_SLIP, WARMUP, loadAll, buildTfContext } from "../lib/runner.mjs";
import { benjaminiHochberg, nullMaxT, splitThirds } from "../lib/stats.mjs";
import { netPctAsym, simulateAsym } from "./lib/asym-engine.mjs";
import { ALL_PLANS, CUT_BARS, ENTRIES, FILTER_KEYS, MAX_HOLD, PLANS } from "./lib/plans.mjs";
import { asymStats, lcg, sampleEvenly } from "./lib/metrics.mjs";

const TF_LIST = ["15m", "1H", "4H"];
const SAMPLE_MIN = { "15m": 250, "1H": 150, "4H": 100 };
const RANDOM_SETS = 30;

const t0 = performance.now();
const { data, fundingCum, fetchedAt } = loadAll();

/** 추적손절이 참조하는 배열 — 전부 "현재 봉 제외" 극값이라 미래 참조가 없다. */
const buildExt = (candles) => ({
  atrN: ta.atr(candles, 22),
  chHigh: ta.rollingExtreme(candles.map((b) => b.h), 22, true),
  chLow: ta.rollingExtreme(candles.map((b) => b.l), 22, false),
  dcHigh: ta.rollingExtreme(candles.map((b) => b.h), 10, true),
  dcLow: ta.rollingExtreme(candles.map((b) => b.l), 10, false),
});

const rows = [];
const samples = {};
// 손익만 모으면 하방고정·보유기간·청산유형을 잴 수 없다. 거래 쪽 필드도 같은 순서로 모은다.
const slim = (t) => ({ slPct: t.slPct, mfePct: t.mfePct, grossPct: t.grossPct, holdBars: t.holdBars, peakUnits: t.peakUnits, exitType: t.exitType });
const pooled = {};
const pooledT = {};
const randomPool = {};
const randomPoolT = {};
for (const p of ALL_PLANS) {
  pooled[p.key] = [];
  pooledT[p.key] = [];
  randomPool[p.key] = [];
  randomPoolT[p.key] = [];
}
const tfPool = {};
const tfPoolT = {};

const buyHold = {};

for (const tf of TF_LIST) {
  const candles = data[tf];
  const ctx = buildTfContext(data, tf);
  const ext = buildExt(candles);
  const maxHold = MAX_HOLD[tf];
  const cutBars = CUT_BARS[tf];
  const tStart = candles[WARMUP].t;
  const tEnd = candles[candles.length - 1].t;

  const first = candles[WARMUP].o;
  const lastC = candles[candles.length - 1].c;
  buyHold[tf] = {
    from: tStart,
    to: tEnd,
    totalPct: Math.round(((lastC - first) / first) * 1e4) / 100,
    days: Math.round(((tEnd - tStart) / 86400000) * 10) / 10,
  };

  const sigCache = new Map();
  for (const e of ENTRIES) {
    for (const side of ["long", "short"]) {
      for (const fk of FILTER_KEYS) {
        sigCache.set(`${e.key}|${side}|${fk}`, signalIndices(ctx, FAMILIES[e.key][side], FILTERS[fk].fn, side, WARMUP));
      }
    }
  }

  for (const plan of ALL_PLANS) {
    const p = plan.timeCut ? { ...plan, timeCut: { ...plan.timeCut, bars: cutBars } } : plan;
    for (const e of ENTRIES) {
      for (const side of ["long", "short"]) {
        for (const fk of FILTER_KEYS) {
          const idx = sigCache.get(`${e.key}|${side}|${fk}`);
          const all = simulateAsym(candles, ctx, ext, idx, side, p, maxHold);
          const closed = all.filter((t) => t.exitType !== "open");
          const openCount = all.length - closed.length;
          const pnls = closed.map((t) => netPctAsym(t, GATE_FEE, GATE_SLIP, fundingCum));
          const st = asymStats(closed, pnls);
          if (!st.n) continue;
          pooled[plan.key].push(...pnls);
          pooledT[plan.key].push(...closed.map(slim));
          const tk = `${tf}|${plan.key}`;
          (tfPool[tk] ??= []).push(...pnls);
          (tfPoolT[tk] ??= []).push(...closed.map(slim));
          const thirds = splitThirds(closed, pnls, tStart, tEnd);
          const key = `${tf}:${e.key}:${side}:${fk}:${plan.key}`;
          rows.push({
            key,
            tf,
            entry: e.key,
            side,
            filter: fk,
            plan: plan.key,
            openCount,
            thirds: thirds.sums,
            thirdsPos: thirds.positive,
            ...st,
          });
          if (st.n >= SAMPLE_MIN[tf] && st.ev > 0) {
            samples[key] = sampleEvenly(closed, 300).map(({ v, i }) => ({ ...v, net: Math.round(pnls[i] * 1e4) / 1e4 }));
          }
        }
      }
    }
  }

  // 랜덤 진입 대조 — 신호 수만 맞춘 무작위 진입. 성과가 청산 설계만으로 나오는지 본다.
  const counts = [...sigCache.values()].map((v) => v.length).sort((a, b) => a - b);
  const medSignals = counts[Math.floor(counts.length / 2)];
  const rnd = lcg(20260818 + tf.length);
  for (let s = 0; s < RANDOM_SETS; s += 1) {
    const idx = [];
    for (let q = 0; q < medSignals; q += 1) idx.push(WARMUP + Math.floor(rnd() * (candles.length - WARMUP - 2)));
    idx.sort((a, b) => a - b);
    for (const plan of ALL_PLANS) {
      const p = plan.timeCut ? { ...plan, timeCut: { ...plan.timeCut, bars: cutBars } } : plan;
      for (const side of ["long", "short"]) {
        const all = simulateAsym(candles, ctx, ext, idx, side, p, maxHold);
        const closed = all.filter((t) => t.exitType !== "open");
        randomPool[plan.key].push(...closed.map((t) => netPctAsym(t, GATE_FEE, GATE_SLIP, fundingCum)));
        randomPoolT[plan.key].push(...closed.map(slim));
      }
    }
  }
  console.log(`  ${tf} 완료 — 조합 ${rows.filter((r) => r.tf === tf).length}, 랜덤 ${RANDOM_SETS}세트 (${Math.round((performance.now() - t0) / 1000)}s)`);
}

// 다중검정 — 표본 게이트를 통과한 것만 대상. 통과 못한 것을 넣으면 FDR이 희석된다.
const eligible = rows.filter((r) => r.n >= SAMPLE_MIN[r.tf]);
const bh = benjaminiHochberg(eligible.map((r) => ({ key: r.key, p: r.p })), 0.1);
const rejected = new Set(bh.rejected ?? []);
const nullT = nullMaxT(eligible.length);

const c0Of = new Map();
for (const r of rows) if (r.plan === "C0") c0Of.set(`${r.tf}:${r.entry}:${r.side}:${r.filter}`, r);

for (const r of rows) {
  const c0 = c0Of.get(`${r.tf}:${r.entry}:${r.side}:${r.filter}`);
  r.g1 = r.n >= SAMPLE_MIN[r.tf];
  r.g2 = r.ev > 0;
  r.g3 = r.payoff !== null && r.payoff >= 2.0;
  r.g4 = r.breachRate <= 5;
  r.g5 = r.t >= 2.0 && rejected.has(r.key);
  r.g6 = r.thirdsPos >= 2;
  r.g7 = r.plan !== "C0" && c0 ? r.ev > c0.ev && (r.payoff ?? 0) > (c0.payoff ?? 0) : null;
  r.gates = ["g1", "g2", "g3", "g4", "g5", "g6", "g7"].filter((g) => r[g] === true).length;
  r.gatesApplicable = r.plan === "C0" ? 6 : 7;
  r.c0ev = c0 ? c0.ev : null;
  r.c0payoff = c0 ? c0.payoff : null;
}

// 기획 수준 비교 — 선별 없이 전 조합을 풀링한다. 최고 조합끼리 비교하면 그것이 곧 선별 편향이다.
const planSummary = ALL_PLANS.map((p) => {
  const mine = rows.filter((r) => r.plan === p.key);
  const pl = pooled[p.key];
  const st = asymStats(pooledT[p.key], pl);
  const rp = randomPool[p.key];
  const rst = rp.length ? asymStats(randomPoolT[p.key], rp) : null;
  const passers = mine.filter((r) => r.gates === r.gatesApplicable);
  const best = mine.filter((r) => r.g1).sort((a, b) => b.ev - a.ev)[0] ?? null;
  return {
    key: p.key,
    name: p.name,
    family: p.family,
    why: p.why,
    source: p.source,
    spec: { initSl: p.initSl, tp: p.tp, trail: p.trail, trailArmR: p.trailArmR, beArmR: p.beArmR, partial: p.partial, timeCut: p.timeCut, pyramid: p.pyramid },
    combos: mine.length,
    pooled: {
      n: st.n, ev: st.ev, pf: st.pf, t: st.t, winRate: st.winRate, payoff: st.payoff,
      tailShare: st.tailShare, evExTail: st.evExTail, tailDependent: st.tailDependent,
      breachRate: st.breachRate, breachGrossRate: st.breachGrossRate, costOverR: st.costOverR,
      worstR: st.worstR, bestR: st.bestR, skew: st.skew,
      captureRate: st.captureRate, holdMed: st.holdMed, holdMax: st.holdMax, avgUnits: st.avgUnits,
      exitTypes: st.exitTypes,
    },
    random: rst ? { n: rst.n, ev: rst.ev, pf: rst.pf, winRate: rst.winRate, payoff: rst.payoff, breachRate: rst.breachRate, t: rst.t } : null,
    passers: passers.length,
    gateHist: [1, 2, 3, 4, 5, 6, 7].map((k) => mine.filter((r) => r.gates === k).length),
    bestKey: best?.key ?? null,
  };
});

/**
 * 짝지은 비교 — 같은 (봉 × 진입 × 방향 × 필터)에서 기획 EV − 대조군 EV.
 * 풀링 t는 거래 간 이질성에 오염된다. 짝을 지으면 진입의 좋고 나쁨이 상쇄되고
 * 남는 것은 청산 설계의 기여뿐이다. 이것이 이 회차가 실제로 묻는 값이다.
 */
const pairedTest = (diffs) => {
  const n = diffs.length;
  if (n < 3) return null;
  const m = diffs.reduce((s2, d) => s2 + d, 0) / n;
  const v = diffs.reduce((s2, d) => s2 + (d - m) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(v);
  const t = sd > 0 ? (m / sd) * Math.sqrt(n) : 0;
  const sorted = [...diffs].sort((a, b) => a - b);
  const med = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const wins = diffs.filter((d) => d > 0).length;
  // 부호검정 — 평균 개선이 소수의 큰 차이에서 오는지, 폭넓게 오는지 가른다.
  const signZ = n > 0 ? (wins - n / 2) / Math.sqrt(n / 4) : 0;
  return {
    n,
    mean: Math.round(m * 1e4) / 1e4,
    median: Math.round(med * 1e4) / 1e4,
    sd: Math.round(sd * 1e4) / 1e4,
    t: Math.round(t * 100) / 100,
    wins,
    signZ: Math.round(signZ * 100) / 100,
  };
};
const pairedIn = (planKey, tfFilter) => {
  const diffsEv = [];
  const diffsPayoff = [];
  const diffsHold = [];
  for (const r of rows.filter((x) => x.plan === planKey && (!tfFilter || x.tf === tfFilter))) {
    const c0 = c0Of.get(`${r.tf}:${r.entry}:${r.side}:${r.filter}`);
    if (!c0 || !r.g1 || !c0.g1) continue;
    diffsEv.push(r.ev - c0.ev);
    if (r.payoff !== null && c0.payoff !== null) diffsPayoff.push(r.payoff - c0.payoff);
    if (r.holdMed !== null && c0.holdMed !== null) diffsHold.push(r.holdMed - c0.holdMed);
  }
  return { ev: pairedTest(diffsEv), payoff: pairedTest(diffsPayoff), hold: pairedTest(diffsHold) };
};

const pairedByTf = {};
for (const tf of TF_LIST) {
  pairedByTf[tf] = {};
  for (const p of ALL_PLANS) {
    if (p.key === "C0") continue;
    pairedByTf[tf][p.key] = pairedIn(p.key, tf);
  }
}

const planPaired = {};
for (const p of ALL_PLANS) {
  if (p.key === "C0") continue;
  const diffsEv = [];
  const diffsPayoff = [];
  const diffsHold = [];
  for (const r of rows.filter((x) => x.plan === p.key)) {
    const c0 = c0Of.get(`${r.tf}:${r.entry}:${r.side}:${r.filter}`);
    if (!c0 || !r.g1 || !c0.g1) continue;
    diffsEv.push(r.ev - c0.ev);
    if (r.payoff !== null && c0.payoff !== null) diffsPayoff.push(r.payoff - c0.payoff);
    if (r.holdMed !== null && c0.holdMed !== null) diffsHold.push(r.holdMed - c0.holdMed);
  }
  planPaired[p.key] = { ev: pairedTest(diffsEv), payoff: pairedTest(diffsPayoff), hold: pairedTest(diffsHold) };
}

// 봉별 풀링 — 비용이 1R을 잡아먹는 곳이 어디인지 봉 단위로 드러낸다.
const byTf = {};
for (const tf of TF_LIST) {
  byTf[tf] = {};
  for (const p of ALL_PLANS) {
    const k = `${tf}|${p.key}`;
    const st = tfPool[k] ? asymStats(tfPoolT[k], tfPool[k]) : null;
    byTf[tf][p.key] = st && st.n
      ? { n: st.n, ev: st.ev, pf: st.pf, t: st.t, winRate: st.winRate, payoff: st.payoff, breachRate: st.breachRate, breachGrossRate: st.breachGrossRate, costOverR: st.costOverR, holdMed: st.holdMed, holdMax: st.holdMax, tailShare: st.tailShare, evExTail: st.evExTail, tailDependent: st.tailDependent, skew: st.skew, captureRate: st.captureRate, avgUnits: st.avgUnits, exitTypes: st.exitTypes }
      : null;
  }
}

const gateFunnel = {};
for (const g of ["g1", "g2", "g3", "g4", "g5", "g6", "g7"]) gateFunnel[g] = rows.filter((r) => r[g] === true).length;

const survivors = rows.filter((r) => r.gates === r.gatesApplicable && r.plan !== "C0");

saveOut("asym.json", {
  generatedAt: Date.now(),
  fetchedAt,
  config: { sampleMin: SAMPLE_MIN, maxHold: MAX_HOLD, cutBars: CUT_BARS, cost: { fee: GATE_FEE, slip: GATE_SLIP }, randomSets: RANDOM_SETS, warmup: WARMUP },
  plans: PLANS,
  allPlans: ALL_PLANS,
  entries: ENTRIES,
  buyHold,
  rows,
  planSummary,
  planPaired,
  pairedByTf,
  byTf,
  gateFunnel,
  survivors: survivors.map((r) => r.key),
  multiple: { eligible: eligible.length, rejected: rejected.size, nullMaxT: Math.round(nullT * 100) / 100, maxT: Math.max(...eligible.map((r) => r.t)) },
  samples,
});

console.log(`\n조합 ${rows.length} / 표본통과 ${eligible.length} / FDR기각 ${rejected.size} / 최대t ${Math.max(...eligible.map((r) => r.t)).toFixed(2)} (귀무기대 ${nullT.toFixed(2)})`);
console.log(`전 게이트 통과: ${survivors.length}건`);
console.log(`게이트 퍼널: ${JSON.stringify(gateFunnel)}`);
console.log("");
console.log("짝지은 비교(기획 − 대조군 C0, 같은 진입·방향·필터):");
console.table(Object.entries(planPaired).map(([k, v]) => ({
  기획: k,
  짝: v.ev?.n,
  "EV차(%p)": v.ev?.mean,
  "EV t": v.ev?.t,
  "이긴 짝": v.ev ? `${v.ev.wins}/${v.ev.n}` : null,
  "중앙차": v.ev?.median,
  부호z: v.ev?.signZ,
  "페이오프차": v.payoff?.mean,
  "보유차(봉)": v.hold?.mean,
})));
console.table(planSummary.map((p) => ({
  기획: `${p.key} ${p.name}`,
  거래: p.pooled.n,
  EV: p.pooled.ev,
  PF: p.pooled.pf,
  t: p.pooled.t,
  승률: p.pooled.winRate,
  페이오프: p.pooled.payoff,
  꼬리비중: p.pooled.tailShare,
  "하방초과%": p.pooled.breachRate,
  "갭·증량초과%": p.pooled.breachGrossRate,
  "비용/1R%": p.pooled.costOverR,
  최악R: p.pooled.worstR,
  보유중앙: p.pooled.holdMed,
  랜덤EV: p.random?.ev,
})));
for (const tf of TF_LIST) {
  console.log("");
  console.log(`짝지은 비교 — ${tf} 한정:`);
  console.table(Object.entries(pairedByTf[tf]).map(([k, v]) => ({
    기획: k, 짝: v.ev?.n, "EV차(%p)": v.ev?.mean, "중앙차": v.ev?.median, "EV t": v.ev?.t,
    "이긴 짝": v.ev ? `${v.ev.wins}/${v.ev.n}` : null, 부호z: v.ev?.signZ, 페이오프차: v.payoff?.mean,
  })));
}
console.log(`총 ${Math.round((performance.now() - t0) / 1000)}s`);
