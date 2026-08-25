/**
 * 15회차 리포트 — 재계산하지 않는다. out/*.json 의 수치를 그대로 옮긴다.
 * 14회차 결과(compound-grid.json)를 나란히 놓는 것이 이 회차 리포트의 본체다.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OUT_DIR, loadOut } from "../lib/data.mjs";
import { METHODS, METHOD_KEYS } from "../compound/lib/sizing.mjs";
import { PARTS } from "../compound/lib/components.mjs";
import { SLOW_SETS } from "./lib/slowdata.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const win = loadOut("stress-window.json");
const wfa = loadOut("stress-wfa.json");
const rob = loadOut("stress-robust.json");
const prev = loadOut("compound-grid.json"); // 14회차

const comp = win.rows.filter((r) => r.pass && r.method !== "m0").sort((a, b) => (b.mar ?? -9) - (a.mar ?? -9));
const pickFor = (tol) => comp.filter((r) => r.mdd >= -tol)[0] ?? null;

const payload = {
  generatedAt: Date.now(),
  window: win.window, bench: win.bench, cost: win.cost,
  prevWindow: { days: prev.windowDays.common, from: prev.windows.common.from, to: prev.windows.common.to, bench: prev.bench.common },
  parts: Object.entries(win.partStats).map(([k, v]) => ({ key: k, ...v })),
  sets: SLOW_SETS.map((s) => ({ ...s })),
  methods: METHOD_KEYS.map((k) => ({ key: k, name: METHODS[k].name, family: METHODS[k].family })),
  funnel: win.funnel, totalConfigs: win.rows.length, passCount: win.rows.filter((r) => r.pass).length,
  passDist: win.passDist, d1: win.d1, levRiskGrid: win.levRiskGrid,
  pairedNow: win.pairedVsM1, pairedPrev: prev.pairedVsM1,
  live: win.live, prevLive: prev.live,
  compounderTop: win.compounderTop,
  recommend: [
    { tol: 25, label: "보수 — 낙폭 25% 이내", row: pickFor(25) },
    { tol: 40, label: "표준 — 낙폭 40% 이내", row: pickFor(40) },
  ],
  wfa: {
    window: wfa.window, folds: wfa.folds, wf: wfa.wf, d2: wfa.d2,
    configsN: wfa.configsN, rules: wfa.rules, hindsightPick: wfa.hindsightPick, pickCounts: wfa.pickCounts,
  },
  d3: rob.d3, d4: rob.d4, slipFunnel: rob.slipFunnel, slips: rob.slips,
  partLabel: Object.fromEntries(PARTS.map((p) => [p.key, p.label])),
  // 14회차 §8 의 부품 제거 결과 — 뒤집힘을 나란히 보이려고 가져온다.
  prevLoo: loadOut("compound-robust.json").loo.map((x) => ({ key: x.removed, label: x.label, marDelta: x.marDelta, soloMar: x.soloMar })),
  prevTopSet: loadOut("compound-robust.json").top,
};

const tpl = readFileSync(join(HERE, "report-template.html"), "utf8");
mkdirSync(OUT_DIR, { recursive: true });
const out = join(OUT_DIR, "stress-report.html");
writeFileSync(out, tpl.replace("__DATA_JSON__", JSON.stringify(payload)));
console.log(`저장 → out/stress-report.html (${Math.round(readFileSync(out).length / 1024)}KB)`);
