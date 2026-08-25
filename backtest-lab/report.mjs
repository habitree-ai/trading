/**
 * P6 — HTML 리포트.
 *
 * 재계산하지 않는다. out/*.json 에 있는 수치를 그대로 옮긴다.
 * 리포트에서 숫자를 다시 만들면 어느 쪽이 정본인지 알 수 없게 된다.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LAB, OUT_DIR, loadCache, loadOut } from "./lib/data.mjs";
import { EXITS, FAMILIES, FILTERS } from "./lib/signals.mjs";

const sweep = loadOut("sweep.json");
const diag = loadOut("diagnose.json");
const front = loadOut("frontier.json");
const fetchRep = loadCache("fetch-report.json");

const rows = sweep.rows.filter((r) => r.n > 0);

/* t 분포 히스토그램 — 0.5 폭. */
const BIN = 0.5;
const tMin = Math.floor(Math.min(...rows.map((r) => r.t)) / BIN) * BIN;
const tMax = Math.ceil(Math.max(...rows.map((r) => r.t)) / BIN) * BIN;
const hist = [];
for (let b = tMin; b < tMax; b += BIN) hist.push({ x: +(b + BIN / 2).toFixed(2), lo: +b.toFixed(2), count: 0 });
for (const r of rows) {
  const k = Math.min(hist.length - 1, Math.max(0, Math.floor((r.t - tMin) / BIN)));
  hist[k].count += 1;
}

const groupBy = (keyOf, labelOf) => {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()].map(([k, v]) => {
    const sortedEv = v.map((x) => x.ev).sort((a, b) => a - b);
    return {
      key: k,
      label: labelOf ? labelOf(k) : k,
      combos: v.length,
      evPos: v.filter((x) => x.ev > 0).length,
      evPosPct: +((v.filter((x) => x.ev > 0).length / v.length) * 100).toFixed(1),
      maxT: +Math.max(...v.map((x) => x.t)).toFixed(2),
      medEv: +sortedEv[sortedEv.length >> 1].toFixed(3),
      medN: v.map((x) => x.n).sort((a, b) => a - b)[v.length >> 1],
    };
  });
};

const compactRow = (r) => ({
  tf: r.tf, famKey: r.famKey, famName: FAMILIES[r.famKey].name, family: r.family, novel: r.novel === true,
  side: r.side, filterKey: r.filterKey, filterName: FILTERS[r.filterKey].name,
  exitKey: r.exitKey, exitName: EXITS.find((e) => e.key === r.exitKey).name,
  n: r.n, ev: r.ev, pf: r.pf, t: r.t, p: r.p, winRate: r.winRate, avgHold: r.avgHold,
  thirds: r.thirds, thirdsPositive: r.thirdsPositive, tradesPerMonth: r.tradesPerMonth,
  gates: r.gates, isN: r.is?.n ?? 0, isEv: r.is?.ev ?? null, isT: r.is?.t ?? null,
  oosN: r.oos?.n ?? 0, oosEv: r.oos?.ev ?? null, oosPf: r.oos?.pf ?? null, oosT: r.oos?.t ?? null,
});

const compactGrid = (g) => ({
  basket: g.basket, overlay: g.overlay, levCap: g.levCap, riskPct: g.riskPct,
  finalEquity: g.finalEquity, cagr: g.cagr, mdd: g.mddPessimistic, mar: g.mar,
  monthlyMedian: g.monthlyMedian, hit10: g.hitRate10, hit5: g.hitRate5, hit3: g.hitRate3,
  tradesPerMonth: g.tradesPerMonth, liq: g.liquidations, avgLev: g.avgLeverage,
  ruin: g.gates.boot?.ruinPct ?? null, gates: { c1: g.gates.c1, c2: g.gates.c2, c3: g.gates.c3, c4: g.gates.c4, c5: g.gates.c5, passed: g.gates.passed },
});

/** 헤드라인 설정 — 월 중앙값이 가장 높은 인샘플 설정. "가장 잘 봐준" 경우다. */
const headA = [...front.gridA].sort((a, b) => (b.monthlyMedian ?? -99) - (a.monthlyMedian ?? -99))[0];
const headB = [...front.gridB].sort((a, b) => (b.monthlyMedian ?? -99) - (a.monthlyMedian ?? -99))[0];

const payload = {
  generatedAt: Date.now(),
  round: {
    key: "lab-month10",
    name: "월 10% 복리 도달 가능성",
    question: "BTC를 4H·1H·15m 기술적 지표만으로 매매해 월 10% 이상을 복리로 가져갈 수 있는가",
    verdict: "기각",
    target: { monthlyPct: 10, impliedCagrPct: 213.84 },
  },
  data: {
    tfs: fetchRep.tfs.map((t) => {
      const m = sweep.tfMeta[t.tf];
      return { ...t, from: m?.from ?? null, to: m?.to ?? null, isCut: m?.isCut ?? null, maxHold: m?.maxHold ?? null, sampleMin: m?.sampleMin ?? null };
    }),
    funding: fetchRep.funding,
    cost: sweep.config.cost,
  },
  sweep: {
    total: sweep.rows.length,
    tested: sweep.multipleTesting.tested,
    empty: sweep.emptyCombos.length,
    survivors: sweep.survivorKeys.length,
    gateCounts: sweep.gateCounts,
    multipleTesting: sweep.multipleTesting,
    fdrQ: sweep.config.fdrQ,
    pfMin: sweep.config.pfMin,
    hist,
    byTf: groupBy((r) => r.tf),
    byExit: groupBy((r) => r.exitKey, (k) => EXITS.find((e) => e.key === k).name),
    byFilter: groupBy((r) => r.filterKey, (k) => FILTERS[k].name),
    byFamily: groupBy((r) => r.family),
    bySide: groupBy((r) => r.side, (k) => (k === "long" ? "롱" : "숏")),
    top: [...rows].sort((a, b) => b.t - a.t).slice(0, 20).map(compactRow),
    worst: [...rows].sort((a, b) => a.t - b.t).slice(0, 5).map(compactRow),
  },
  diagnose: diag.tfs,
  frontier: {
    config: front.config,
    windows: front.windows,
    poolSizes: front.poolSizes,
    basketA: front.basketA,
    basketB: front.basketB,
    gridA: front.gridA.map(compactGrid),
    gridB: front.gridB.map(compactGrid),
    headA: { ...compactGrid(headA), monthly: headA.monthly, curve: headA.curve },
    headB: { ...compactGrid(headB), monthly: headB.monthly, curve: headB.curve },
    requirements: front.requirements,
  },
  families: Object.entries(FAMILIES).map(([k, v]) => ({ key: k, name: v.name, family: v.family, rule: v.rule, novel: v.novel === true })),
  exits: EXITS.map((e) => ({ key: e.key, name: e.name, sl: e.sl, tp: e.tp, trail: e.trail })),
  filters: Object.entries(FILTERS).map(([k, v]) => ({ key: k, name: v.name, desc: v.desc })),
};

const tpl = readFileSync(join(LAB, "report-template.html"), "utf8");
const html = tpl.replace("__DATA_JSON__", JSON.stringify(payload));
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "report.html"), html);
console.log(`저장 → out/report.html (${(html.length / 1024).toFixed(0)} KB)`);
