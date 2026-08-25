/**
 * D3 부품 탈락 · D4 체결 스트레스.
 *
 * D3 — 기여 큰 부품이 죽으면 남는가. 창 확장에서 살아남은 묶음이 베이시스 2부품뿐이라
 *      이 질문이 특히 날카롭다: bzc 하나가 죽으면 시스템이 통째로 없어지는가.
 * D4 — 비용 가정이 낙관이었는가. 슬리피지를 3배로 올리고 사다리로 훑는다.
 */
import { performance } from "node:perf_hooks";
import { saveOut, loadOut } from "../lib/data.mjs";
import { METHODS } from "../compound/lib/sizing.mjs";
import { PARTS } from "../compound/lib/components.mjs";
import { SLOW_SETS, buildSlowParts } from "./lib/slowdata.mjs";
import { buyHold, evalCell } from "./lib/evalcell.mjs";

const t0 = performance.now();
const win = loadOut("stress-window.json");
const { from, to } = win.window;
const bench = win.bench;
const label = (k) => PARTS.find((p) => p.key === k)?.label ?? k;

const base = buildSlowParts({ fee: 0.1, slip: 0.02 });
const evalOn = (parts, keys, cfg, mc = 3) => evalCell({
  trades: keys.flatMap((k) => parts[k] ?? []),
  methodKey: cfg.method, levCap: cfg.levCap, riskPct: cfg.riskPct, maxConcurrent: mc,
  from, to, benchMonthlyGeo: bench.monthlyGeo,
}).row;

/** 권고 후보 — 창 확장에서 게이트를 통과한 복리 설정(m0 제외) 중 낙폭 허용치별 최선. */
const comp = win.rows.filter((r) => r.pass && r.method !== "m0").sort((a, b) => (b.mar ?? -9) - (a.mar ?? -9));
const pickFor = (tol) => comp.filter((r) => r.mdd >= -tol)[0] ?? null;
const RECS = [
  { tol: 25, label: "보수", row: pickFor(25) },
  { tol: 40, label: "표준", row: pickFor(40) },
].filter((x) => x.row);
console.log("권고 후보:");
for (const r of RECS) console.log(`  ${r.label} — ${r.row.set}·${r.row.method}·${r.row.levCap}배·${r.row.riskPct}% → 월 ${r.row.monthlyGeo}% · 낙폭 ${r.row.mdd}% · MAR ${r.row.mar}`);

/* ── D3 부품 탈락 ── */
const d3 = [];
for (const setKey of ["basis2", "mix7", "all10"]) {
  const set = SLOW_SETS.find((s) => s.key === setKey);
  // 그 묶음에서 게이트에 가장 가까운 복리 설정을 기준으로 삼는다(통과가 없으면 MAR 최대).
  const mine = win.rows.filter((r) => r.set === setKey && r.method !== "m0");
  const anchor = mine.filter((r) => r.pass).sort((a, b) => b.mar - a.mar)[0]
    ?? mine.sort((a, b) => (b.mar ?? -9) - (a.mar ?? -9))[0];
  const cfg = { method: anchor.method, levCap: anchor.levCap, riskPct: anchor.riskPct };
  const full = evalOn(base.parts, set.parts, cfg);

  const loo = set.parts.map((k) => {
    const rest = set.parts.filter((x) => x !== k);
    const r = rest.length ? evalOn(base.parts, rest, cfg) : null;
    return { key: k, label: label(k), mar: r?.mar ?? null, marDelta: r && full.mar !== null ? Math.round((r.mar - full.mar) * 100) / 100 : null,
      monthlyGeo: r?.monthlyGeo ?? null, mdd: r?.mdd ?? null, liquidations: r?.liquidations ?? null, pass: r?.pass ?? null };
  }).sort((a, b) => (a.marDelta ?? 0) - (b.marDelta ?? 0));

  // 사전 등록: 최대 기여 2개를 동시에 제거. 부품이 3개 미만이면 1개만 뺄 수 있다 — 그 사실을 기록한다.
  const dropCount = set.parts.length >= 3 ? 2 : 1;
  const dropped = loo.slice(0, dropCount).map((x) => x.key);
  const rest = set.parts.filter((k) => !dropped.includes(k));
  const after = rest.length ? evalOn(base.parts, rest, cfg) : null;
  d3.push({
    set: setKey, setName: set.name, parts: set.parts, cfg, anchorGates: anchor.gates,
    full: { mar: full.mar, monthlyGeo: full.monthlyGeo, mdd: full.mdd, liquidations: full.liquidations, pass: full.pass },
    loo, dropCount, dropped, droppedLabels: dropped.map(label), restN: rest.length,
    after: after ? { mar: after.mar, monthlyGeo: after.monthlyGeo, mdd: after.mdd, liquidations: after.liquidations, pass: after.pass, trades: after.trades } : null,
    // D3 기준: 월 기하 > 0 그리고 청산 0건
    d3pass: !!after && after.monthlyGeo > 0 && after.liquidations === 0,
    limited: set.parts.length < 3,
  });
}

/* ── D4 체결 스트레스 ── */
const SLIPS = [0.02, 0.04, 0.06, 0.1];
const d4 = [];
const slipParts = {};
for (const slip of SLIPS) {
  slipParts[slip] = slip === 0.02 ? base.parts : buildSlowParts({ fee: 0.1, slip }).parts;
  console.log(`  슬리피지 ${slip}% 부품 생성 완료 (${Math.round((performance.now() - t0) / 1000)}s)`);
}
for (const rec of RECS) {
  const set = SLOW_SETS.find((s) => s.key === rec.row.set);
  const cfg = { method: rec.row.method, levCap: rec.row.levCap, riskPct: rec.row.riskPct };
  const ladder = SLIPS.map((slip) => {
    const r = evalOn(slipParts[slip], set.parts, cfg);
    return {
      slip, monthlyGeo: r.monthlyGeo, cagr: r.cagr, mdd: r.mdd, mar: r.mar,
      ruin: r.ruin, liquidations: r.liquidations, gates: r.gates, pass: r.pass,
      // D4 기준: 슬리피지 0.06% 에서 청산 0 · 파산확률 ≤1% · MAR ≥1
      d4pass: r.liquidations === 0 && r.ruin !== null && r.ruin <= 1 && r.mar !== null && r.mar >= 1,
    };
  });
  d4.push({ ...rec, cfg, set: rec.row.set, setName: set.name, ladder, d4pass: ladder.find((x) => x.slip === 0.06)?.d4pass ?? false });
}

/* ── 슬리피지가 묶음 전체 판정을 어떻게 바꾸는가 ── */
const slipFunnel = SLIPS.map((slip) => {
  const parts = slipParts[slip];
  let pass = 0;
  let best = null;
  for (const s of SLOW_SETS) {
    for (const m of Object.keys(METHODS)) {
      if (m === "m0") continue;
      for (const lev of [3, 5]) {
        for (const risk of [1, 2, 3, 5, 7]) {
          const r = evalOn(parts, s.parts, { method: m, levCap: lev, riskPct: risk });
          if (r.pass) pass += 1;
          if (!best || (r.mar ?? -9) > (best.mar ?? -9)) best = { set: s.key, method: m, levCap: lev, riskPct: risk, mar: r.mar, monthlyGeo: r.monthlyGeo, mdd: r.mdd, pass: r.pass };
        }
      }
    }
  }
  return { slip, pass, best };
});

saveOut("stress-robust.json", { generatedAt: Date.now(), window: win.window, bench, recs: RECS, d3, d4, slips: SLIPS, slipFunnel });

console.log("");
console.log("D3 부품 탈락 — 기여 큰 부품을 빼면:");
for (const x of d3) {
  console.log(`\n[${x.setName}] 기준 ${x.cfg.method}·${x.cfg.levCap}배·${x.cfg.riskPct}% (게이트 ${x.anchorGates}/6) — 전체 MAR ${x.full.mar} · 월 ${x.full.monthlyGeo}%`);
  console.table(x.loo.map((l) => ({ "뺀 부품": l.key + " " + l.label, "제거 후 MAR": l.mar, "MAR 변화": l.marDelta, "제거 후 월기하%": l.monthlyGeo, "낙폭%": l.mdd, 청산: l.liquidations })));
  console.log(`  → ${x.dropCount}개 동시 제거(${x.droppedLabels.join(", ")}) 후: ` +
    (x.after ? `월 ${x.after.monthlyGeo}% · 낙폭 ${x.after.mdd}% · MAR ${x.after.mar} · 청산 ${x.after.liquidations}건 → ${x.d3pass ? "D3 통과" : "D3 실패"}` : "남는 부품 없음 → D3 실패") +
    (x.limited ? "  (부품 2개뿐이라 1개만 제거 가능)" : ""));
}

console.log("");
console.log("D4 체결 스트레스 — 슬리피지 사다리:");
for (const x of d4) {
  console.log(`\n[${x.label}] ${x.setName}·${x.cfg.method}·${x.cfg.levCap}배·${x.cfg.riskPct}%`);
  console.table(x.ladder.map((l) => ({
    "슬리피지%": l.slip, "왕복 비용%": Math.round((0.1 + l.slip) * 100) / 100,
    "월 기하%": l.monthlyGeo, "CAGR%": l.cagr, "낙폭%": l.mdd, MAR: l.mar,
    "파산%": l.ruin, 청산: l.liquidations, 게이트: l.gates + "/6",
  })));
  console.log(`  → 0.06%에서 ${x.d4pass ? "D4 통과" : "D4 실패"}`);
}

console.log("");
console.log("슬리피지별 전체 통과 수 (묶음 5 × 기법 8 × 레버 2 × 리스크 5 = 400설정):");
console.table(slipFunnel.map((f) => ({
  "슬리피지%": f.slip, "통과 설정": f.pass,
  "최선": `${f.best.set}·${f.best.method}·${f.best.levCap}배·${f.best.riskPct}%`,
  MAR: f.best.mar, "월 기하%": f.best.monthlyGeo, "낙폭%": f.best.mdd,
})));
console.log(`총 ${Math.round((performance.now() - t0) / 1000)}s`);
