/**
 * 통제 실험 둘. 본 스윕 결과를 보고 추가한 것이므로 README §6 에 사후 추가로 기록한다.
 *
 * (A) 창 통제 — 4H 우위가 "봉" 때문인지 "창" 때문인지 가른다.
 *     4H 창은 1,750일이고 15m 창은 727일이다. 창이 길어 좋아 보이는 것일 수 있다.
 *     세 봉을 같은 달력 창으로 잘라 다시 비교한다.
 *
 * (B) 리스크 밴드 — 손실 상한(1R)을 어디에 둘 것인가.
 *     비용이 1R의 28.5%(15m)를 먹는다면 1R을 넓히는 것이 답일 수 있다.
 *     initSl 을 1~4 ATR로 훑어 비용 대비 R의 적정선을 찾는다. 선별 없이 전부 풀링한다.
 */
import { performance } from "node:perf_hooks";
import * as ta from "../lib/indicators.mjs";
import { saveOut } from "../lib/data.mjs";
import { FAMILIES, FILTERS } from "../lib/signals.mjs";
import { signalIndices } from "../lib/engine.mjs";
import { GATE_FEE, GATE_SLIP, WARMUP, loadAll, buildTfContext } from "../lib/runner.mjs";
import { netPctAsym, simulateAsym } from "./lib/asym-engine.mjs";
import { ALL_PLANS, CUT_BARS, ENTRIES, FILTER_KEYS, MAX_HOLD } from "./lib/plans.mjs";
import { asymStats } from "./lib/metrics.mjs";

const TF_LIST = ["15m", "1H", "4H"];
const SL_BAND = [1, 1.5, 2, 3, 4];

const t0 = performance.now();
const { data, fundingCum } = loadAll();

const buildExt = (candles) => ({
  atrN: ta.atr(candles, 22),
  chHigh: ta.rollingExtreme(candles.map((b) => b.h), 22, true),
  chLow: ta.rollingExtreme(candles.map((b) => b.l), 22, false),
  dcHigh: ta.rollingExtreme(candles.map((b) => b.h), 10, true),
  dcLow: ta.rollingExtreme(candles.map((b) => b.l), 10, false),
});

// 공통 창 정의 — 가장 짧은 봉(15m)의 창이 가장 좁다. 그것을 기준선으로 삼는다.
const WINDOWS = {};
for (const tf of TF_LIST) WINDOWS[tf] = data[tf][WARMUP].t;
const WIN_DEFS = [
  { key: "W15", name: "15m 창 (짧음)", from: WINDOWS["15m"] },
  { key: "W1H", name: "1H 창 (중간)", from: WINDOWS["1H"] },
  { key: "W4H", name: "4H 창 (전체)", from: WINDOWS["4H"] },
];

const ctxCache = {};
for (const tf of TF_LIST) {
  ctxCache[tf] = { candles: data[tf], ctx: buildTfContext(data, tf), ext: buildExt(data[tf]) };
}

/** (봉 × 기획 × 손절폭) → 거래 전량. 진입·방향·필터는 전부 풀링한다(선별 없음). */
function runPooled(tf, plan, initSl) {
  const { candles, ctx, ext } = ctxCache[tf];
  const p = { ...plan, initSl, timeCut: plan.timeCut ? { ...plan.timeCut, bars: CUT_BARS[tf] } : null };
  const out = [];
  for (const e of ENTRIES) {
    for (const side of ["long", "short"]) {
      for (const fk of FILTER_KEYS) {
        const idx = signalIndices(ctx, FAMILIES[e.key][side], FILTERS[fk].fn, side, WARMUP);
        const all = simulateAsym(candles, ctx, ext, idx, side, p, MAX_HOLD[tf]);
        for (const t of all) {
          if (t.exitType === "open") continue;
          out.push({ ...t, net: netPctAsym(t, GATE_FEE, GATE_SLIP, fundingCum) });
        }
      }
    }
  }
  return out;
}

// ---------- (A) 창 통제 ----------
const windowControl = {};
for (const tf of TF_LIST) {
  windowControl[tf] = {};
  const base = {};
  for (const plan of ALL_PLANS) base[plan.key] = runPooled(tf, plan, plan.initSl);
  for (const w of WIN_DEFS) {
    if (w.from < WINDOWS[tf]) continue; // 그 봉에 없는 창은 건너뛴다
    windowControl[tf][w.key] = {};
    for (const plan of ALL_PLANS) {
      const tr = base[plan.key].filter((t) => t.entryAt >= w.from);
      if (tr.length < 60) continue;
      const st = asymStats(tr, tr.map((t) => t.net));
      windowControl[tf][w.key][plan.key] = {
        n: st.n, ev: st.ev, pf: st.pf, t: st.t, winRate: st.winRate, payoff: st.payoff,
        breachRate: st.breachRate, breachGrossRate: st.breachGrossRate, costOverR: st.costOverR,
        tailShare: st.tailShare, holdMed: st.holdMed,
      };
    }
  }
  console.log(`  창 통제 ${tf} 완료 (${Math.round((performance.now() - t0) / 1000)}s)`);
}

// ---------- (B) 리스크 밴드 ----------
const riskBand = {};
for (const tf of TF_LIST) {
  riskBand[tf] = {};
  for (const plan of ALL_PLANS) {
    riskBand[tf][plan.key] = SL_BAND.map((sl) => {
      const tr = runPooled(tf, plan, sl);
      if (!tr.length) return null;
      const st = asymStats(tr, tr.map((t) => t.net));
      return {
        initSl: sl, n: st.n, ev: st.ev, pf: st.pf, t: st.t, winRate: st.winRate, payoff: st.payoff,
        breachRate: st.breachRate, breachGrossRate: st.breachGrossRate, costOverR: st.costOverR,
        tailShare: st.tailShare, evExTail: st.evExTail, holdMed: st.holdMed, worstR: st.worstR,
      };
    }).filter(Boolean);
  }
  console.log(`  리스크 밴드 ${tf} 완료 (${Math.round((performance.now() - t0) / 1000)}s)`);
}

saveOut("asym-controls.json", { generatedAt: Date.now(), winDefs: WIN_DEFS, slBand: SL_BAND, windowControl, riskBand });

console.log("");
console.log("(A) 창 통제 — 같은 달력 창에서 봉끼리 비교 (EV, 선별 없이 전량 풀링)");
for (const w of WIN_DEFS) {
  const rowsOut = TF_LIST.filter((tf) => windowControl[tf][w.key]).map((tf) => {
    const o = { 창: w.name, 봉: tf };
    for (const k of ["P1", "P2", "P4", "C0"]) o[k] = windowControl[tf][w.key][k]?.ev ?? null;
    o["P1−C0"] = o.P1 !== null && o.C0 !== null ? Math.round((o.P1 - o.C0) * 1e4) / 1e4 : null;
    o.n = windowControl[tf][w.key].P1?.n ?? null;
    return o;
  });
  console.table(rowsOut);
}

console.log("");
console.log("(B) 리스크 밴드 — 4H·P1 기준 손절폭별 (선별 없이 전량 풀링)");
for (const tf of TF_LIST) {
  console.table(riskBand[tf].P1.map((r) => ({
    봉: tf, "손절(ATR)": r.initSl, 거래: r.n, EV: r.ev, PF: r.pf, t: r.t,
    페이오프: r.payoff, "비용/1R%": r.costOverR, "순초과%": r.breachRate, 보유중앙: r.holdMed,
  })));
}
console.log(`총 ${Math.round((performance.now() - t0) / 1000)}s`);
