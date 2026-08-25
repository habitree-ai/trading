/**
 * D2 — 워크포워드. 설정을 사후에 고르지 않고도 남는가.
 *
 * 창 확장(D1)에서 베이시스 묶음이 통과의 99/103을 가져갔다. 그런데 베이시스 부품은
 * **12회차가 바로 이 창에서 발굴한 것**이다. 그 창에서 다시 재면 순환 논리다.
 * 워크포워드는 그 순환을 끊는다 — 각 시점에서 **그때까지의 정보만으로** 고른다.
 *
 * 절차는 README §3 에 실행 전 고정했다. 여기서 바꾸지 않는다.
 */
import { performance } from "node:perf_hooks";
import { saveOut } from "../lib/data.mjs";
import { METHOD_KEYS, METHODS } from "../compound/lib/sizing.mjs";
import { SLOW_SETS, buildSlowParts } from "./lib/slowdata.mjs";
import { buyHold, evalCell } from "./lib/evalcell.mjs";

const LEV_CAPS = [3, 5, 10, 20];
const RISKS = [0.5, 1, 2, 3, 5, 7, 10, 15, 20];
const COST = { fee: 0.1, slip: 0.02 };
const FOLDS = 10;
const TRAIN_FOLDS = 3;

const t0 = performance.now();
const { parts, data } = buildSlowParts(COST);
const firstOf = (k) => (parts[k]?.length ? parts[k][0].entryAt : Infinity);
const usedKeys = [...new Set(SLOW_SETS.flatMap((s) => s.parts))];
const from = Math.max(...usedKeys.map(firstOf));
const to = Math.max(...Object.values(parts).flat().map((t) => t.exitAt));
const span = to - from;
const bounds = Array.from({ length: FOLDS + 1 }, (_, i) => from + (span * i) / FOLDS);
const tradesOf = new Map(SLOW_SETS.map((s) => [s.key, s.parts.flatMap((k) => parts[k] ?? [])]));

const CONFIGS = [];
for (const s of SLOW_SETS) for (const m of METHOD_KEYS) for (const lev of LEV_CAPS) for (const risk of RISKS) {
  CONFIGS.push({ set: s.key, method: m, levCap: lev, riskPct: risk });
}
console.log(`창 ${new Date(from).toISOString().slice(0, 10)} ~ ${new Date(to).toISOString().slice(0, 10)} · ${FOLDS}등분 · 학습 ${TRAIN_FOLDS}구간 · 평가 ${FOLDS - TRAIN_FOLDS}구간`);
console.log(`설정 ${CONFIGS.length}개 × 평가 구간 ${FOLDS - TRAIN_FOLDS}회 = 학습 평가 ${CONFIGS.length * (FOLDS - TRAIN_FOLDS)}회`);

const run = (cfg, a, b, boot = true, mc = 3) => evalCell({
  trades: tradesOf.get(cfg.set), methodKey: cfg.method, levCap: cfg.levCap, riskPct: cfg.riskPct,
  maxConcurrent: mc, from: a, to: b, boot,
});

/** 학습 자격 — 부트스트랩은 여기서 돌리지 않는다(만 번을 돌 곳이라). 청산·낙폭·MAR 만 본다. */
const trainEligible = (r) => r.liquidations === 0 && r.mdd !== null && r.mdd >= -40 && r.mar !== null && r.mar >= 1;

const RULES = [
  { key: "R1", name: "MAR 최대", why: "사전 등록한 1차 기준 그대로" },
  { key: "R2", name: "월 기하 최대", why: "수익만 보고 고르면 어떻게 되는가" },
  { key: "R3", name: "무선별(자격자 균등)", why: "고르지 않고 자격을 갖춘 전부에 균등 배분 — 선별의 값을 재는 대조군" },
];

const folds = [];
for (let k = TRAIN_FOLDS; k < FOLDS; k += 1) {
  const trainFrom = bounds[0];
  const trainTo = bounds[k];
  const testFrom = bounds[k];
  const testTo = bounds[k + 1];

  const trained = [];
  for (const cfg of CONFIGS) {
    const { row } = run(cfg, trainFrom, trainTo, false);
    if (row.trades < 20) continue;
    trained.push({ cfg, row });
  }
  const eligible = trained.filter((x) => trainEligible(x.row));
  const pool = eligible.length ? eligible : trained;
  const fellBack = eligible.length === 0;

  const picks = {
    R1: [...pool].sort((a, b) => (b.row.mar ?? -9) - (a.row.mar ?? -9))[0],
    R2: [...pool].sort((a, b) => (b.row.monthlyGeo ?? -99) - (a.row.monthlyGeo ?? -99))[0],
  };

  const fold = {
    k, from: testFrom, to: testTo, days: Math.round((testTo - testFrom) / 86_400_000),
    trainDays: Math.round((trainTo - trainFrom) / 86_400_000),
    trainedN: trained.length, eligibleN: eligible.length, fellBack,
    bench: buyHold(data["4H"], testFrom, testTo),
    rules: {},
  };

  for (const rule of ["R1", "R2"]) {
    const p = picks[rule];
    const { row } = run(p.cfg, testFrom, testTo, false);
    fold.rules[rule] = {
      cfg: p.cfg,
      trainMar: p.row.mar, trainGeo: p.row.monthlyGeo, trainMdd: p.row.mdd,
      mar: row.mar, monthlyGeo: row.monthlyGeo, mdd: row.mdd, finalEquity: row.finalEquity,
      trades: row.trades, liquidations: row.liquidations, factor: row.finalEquity / 100,
    };
  }
  // R3 — 자격자 균등. 수익 배율의 평균으로 본다(자본을 n등분해 각각 돌린 것과 같다).
  {
    const outs = pool.slice(0, 400).map((p) => run(p.cfg, testFrom, testTo, false).row);
    const factors = outs.map((r) => r.finalEquity / 100);
    const avg = factors.reduce((s, v) => s + v, 0) / Math.max(1, factors.length);
    fold.rules.R3 = {
      cfg: { set: "—", method: "—", levCap: null, riskPct: null }, n: outs.length,
      mar: null, monthlyGeo: Math.round((Math.pow(avg, 1 / (fold.days / 30.4375)) - 1) * 1e4) / 100,
      mdd: Math.round((outs.reduce((s, r) => s + (r.mdd ?? 0), 0) / Math.max(1, outs.length)) * 100) / 100,
      finalEquity: Math.round(avg * 10000) / 100, factor: avg,
      liquidations: outs.filter((r) => r.liquidations > 0).length,
    };
  }
  // 현행 라이브 — 선별 없음.
  {
    const { row } = run({ set: "quad", method: "m1", levCap: 10, riskPct: 10 }, testFrom, testTo, false, 2);
    fold.live = { mar: row.mar, monthlyGeo: row.monthlyGeo, mdd: row.mdd, finalEquity: row.finalEquity, liquidations: row.liquidations, factor: row.finalEquity / 100 };
  }
  folds.push(fold);
  console.log(`  구간 ${k + 1}/${FOLDS} (${new Date(testFrom).toISOString().slice(0, 10)}~) — 학습 자격 ${eligible.length}/${trained.length}${fellBack ? " (자격자 없음 → 최대 MAR로 대체)" : ""} · R1 ${picks.R1.cfg.set}/${picks.R1.cfg.method}/${picks.R1.cfg.levCap}배/${picks.R1.cfg.riskPct}% → OOS MAR ${fold.rules.R1.mar} (${Math.round((performance.now() - t0) / 1000)}s)`);
}

/** 후행 상한 — 전 구간을 다 보고 고른 최선을 같은 OOS 구간에 적용. 도달 불가 기준선. */
const fullRows = CONFIGS.map((cfg) => ({ cfg, row: run(cfg, from, to, false).row }))
  .filter((x) => x.row.trades >= 40);
const hindsightPick = fullRows.filter((x) => trainEligible(x.row)).sort((a, b) => (b.row.mar ?? -9) - (a.row.mar ?? -9))[0]
  ?? fullRows.sort((a, b) => (b.row.mar ?? -9) - (a.row.mar ?? -9))[0];
for (const f of folds) {
  const { row } = run(hindsightPick.cfg, f.from, f.to, false);
  f.hindsight = { mar: row.mar, monthlyGeo: row.monthlyGeo, mdd: row.mdd, finalEquity: row.finalEquity, factor: row.finalEquity / 100 };
}

/** 연쇄 — 구간 수익 배율을 곱해 워크포워드 자산을 만든다. */
const chain = (get) => {
  let eq = 100;
  const pts = [{ t: folds[0].from, equity: 100 }];
  for (const f of folds) { eq *= get(f); pts.push({ t: f.to, equity: Math.round(eq * 100) / 100 }); }
  return { final: Math.round(eq * 100) / 100, curve: pts };
};
const months = (to - bounds[TRAIN_FOLDS]) / 86_400_000 / 30.4375;
const summarize = (label, get) => {
  const c = chain(get);
  const arr = folds.map(get);
  return {
    label, finalEquity: c.final, curve: c.curve,
    monthlyGeo: c.final > 0 ? Math.round((Math.pow(c.final / 100, 1 / months) - 1) * 1e4) / 100 : null,
    foldFactors: arr.map((v) => Math.round(v * 1000) / 1000),
    positiveFolds: arr.filter((v) => v > 1).length,
  };
};

const wf = {
  R1: summarize("워크포워드 R1 (MAR 최대)", (f) => f.rules.R1.factor),
  R2: summarize("워크포워드 R2 (월 기하 최대)", (f) => f.rules.R2.factor),
  R3: summarize("워크포워드 R3 (무선별 균등)", (f) => f.rules.R3.factor),
  live: summarize("현행 라이브", (f) => f.live.factor),
  hindsight: summarize("후행 상한", (f) => f.hindsight.factor),
  bench: summarize("매수보유", (f) => 1 + f.bench.totalPct / 100),
};

/** D2 판정 — 사전 등록: OOS 7구간 중 MAR ≥ 1 이 5구간 이상(R1 기준). */
const marOk = folds.filter((f) => (f.rules.R1.mar ?? -9) >= 1).length;
const d2 = { rule: "R1", marOk, of: folds.length, need: 5, pass: marOk >= 5 };

saveOut("stress-wfa.json", {
  generatedAt: Date.now(),
  window: { from, to, folds: FOLDS, trainFolds: TRAIN_FOLDS, bounds },
  configsN: CONFIGS.length, rules: RULES, folds, wf, d2,
  hindsightPick: { ...hindsightPick.cfg, mar: hindsightPick.row.mar, monthlyGeo: hindsightPick.row.monthlyGeo, mdd: hindsightPick.row.mdd },
  pickCounts: {
    R1: folds.reduce((a, f) => { const k = `${f.rules.R1.cfg.set}|${f.rules.R1.cfg.method}`; a[k] = (a[k] ?? 0) + 1; return a; }, {}),
    R2: folds.reduce((a, f) => { const k = `${f.rules.R2.cfg.set}|${f.rules.R2.cfg.method}`; a[k] = (a[k] ?? 0) + 1; return a; }, {}),
  },
});

console.log("");
console.log("구간별 결과:");
console.table(folds.map((f) => ({
  구간: f.k + 1, 시작: new Date(f.from).toISOString().slice(0, 10), 일수: f.days,
  "학습 자격": `${f.eligibleN}/${f.trainedN}`,
  "R1 선택": `${f.rules.R1.cfg.set}·${f.rules.R1.cfg.method}·${f.rules.R1.cfg.levCap}배·${f.rules.R1.cfg.riskPct}%`,
  "학습 MAR": f.rules.R1.trainMar, "OOS MAR": f.rules.R1.mar, "OOS 월기하%": f.rules.R1.monthlyGeo,
  "OOS 낙폭%": f.rules.R1.mdd, "배율": Math.round(f.rules.R1.factor * 1000) / 1000,
  "매수보유%": f.bench.totalPct, "라이브 배율": Math.round(f.live.factor * 1000) / 1000,
})));
console.log("");
console.log("연쇄 결과 (평가 7구간, $100 시작):");
console.table(Object.values(wf).map((v) => ({
  경로: v.label, "최종 자산": v.finalEquity, "월 기하%": v.monthlyGeo,
  "플러스 구간": `${v.positiveFolds}/${folds.length}`, "구간 배율": v.foldFactors.join(" "),
})));
console.log("");
console.log(`후행 상한 설정: ${hindsightPick.cfg.set}·${hindsightPick.cfg.method}·${hindsightPick.cfg.levCap}배·${hindsightPick.cfg.riskPct}% (전 구간 MAR ${hindsightPick.row.mar})`);
console.log(`R1 선택 분포: ${JSON.stringify(wf.R1 ? Object.entries(folds.reduce((a, f) => { const k = `${f.rules.R1.cfg.set}|${f.rules.R1.cfg.method}`; a[k] = (a[k] ?? 0) + 1; return a; }, {})) : {})}`);
console.log("");
console.log(`D2 판정: OOS MAR ≥ 1 이 ${marOk}/${folds.length} 구간 (기준 5) → ${d2.pass ? "통과" : "실패"}`);
console.log(`총 ${Math.round((performance.now() - t0) / 1000)}s`);
