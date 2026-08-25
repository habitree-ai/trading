/**
 * 비대칭 회차 리포트 — 재계산하지 않는다. out/*.json 의 수치를 그대로 옮긴다.
 * 리포트가 숫자를 만들기 시작하면 어느 것이 진짜인지 알 수 없게 된다.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OUT_DIR, loadOut } from "../lib/data.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const sweep = loadOut("asym.json");
const ctrl = loadOut("asym-controls.json");
const detail = loadOut("asym-detail.json");
const thirds = loadOut("asym-thirds.json");

const PLAN_ORDER = ["P6", "P4", "P1", "P5", "P2", "P3"];
const nameOf = Object.fromEntries(sweep.allPlans.map((p) => [p.key, p.name]));

const payload = {
  generatedAt: Date.now(),
  fetchedAt: sweep.fetchedAt,
  config: sweep.config,
  plans: sweep.allPlans.map((p) => ({
    key: p.key, name: p.name, family: p.family, why: p.why, source: p.source,
    initSl: p.initSl, tp: p.tp, trail: p.trail, trailArmR: p.trailArmR,
    beArmR: p.beArmR, partial: p.partial, timeCut: p.timeCut, pyramid: p.pyramid, capRisk: p.capRisk ?? false,
  })),
  entries: sweep.entries,
  buyHold: sweep.buyHold,
  byTf: sweep.byTf,
  pairedByTf: sweep.pairedByTf,
  planPaired: sweep.planPaired,
  planSummary: sweep.planSummary.map((p) => ({ key: p.key, name: p.name, pooled: p.pooled, random: p.random, combos: p.combos })),
  gateFunnel: sweep.gateFunnel,
  multiple: sweep.multiple,
  rowCount: sweep.rows.length,
  thirds: { bounds: thirds.bounds, byPlan: thirds.byPlan, pairedThirds: thirds.pairedThirds },
  windowControl: ctrl.windowControl,
  winDefs: ctrl.winDefs,
  riskBand: ctrl.riskBand,
  slBand: ctrl.slBand,
  detail: { rBins: detail.rBins, plans: detail.plans, topRows: detail.topRows, focus: detail.focus },
  planOrder: PLAN_ORDER,
  nameOf,
  // 6/7 게이트 통과 조합 — 전 게이트 통과는 0건이므로 "가장 멀리 간 것"을 보여준다.
  nearMiss: sweep.rows
    .filter((r) => r.plan !== "C0" && r.gates >= 6)
    .sort((a, b) => b.ev - a.ev)
    .map((r) => ({ key: r.key, tf: r.tf, entry: r.entry, side: r.side, filter: r.filter, plan: r.plan, n: r.n, ev: r.ev, pf: r.pf, t: r.t, payoff: r.payoff, breachGrossRate: r.breachGrossRate, gates: r.gates })),
};

const tpl = readFileSync(join(HERE, "report-template.html"), "utf8");
mkdirSync(OUT_DIR, { recursive: true });
const out = join(OUT_DIR, "asym-report.html");
writeFileSync(out, tpl.replace("__DATA_JSON__", JSON.stringify(payload)));
console.log(`저장 → out/asym-report.html (${Math.round(readFileSync(out).length / 1024)}KB)`);
