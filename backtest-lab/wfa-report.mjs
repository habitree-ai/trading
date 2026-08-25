/**
 * P7 리포트 — "달성 가능한 최대 월 복리와 그 지표".
 *
 * report.mjs 와 같은 원칙: 재계산하지 않는다. out/wfa.json 의 수치를 그대로 옮긴다.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LAB, OUT_DIR, loadOut } from "./lib/data.mjs";

const w = loadOut("wfa.json");
const sweep = loadOut("sweep.json");

const months = w.window.days / 30.4375;
const bh4 = w.buyHold["4H"];
const bhCagr = (Math.pow(1 + bh4.monthlyGeo / 100, 12) - 1) * 100;

/** 규칙별로 낙폭 상한 50% 이내 최선을 뽑는다 — 없으면 40/30/20 순으로 내려간다. */
const bestOf = (rule) => rule.best["50"] ?? rule.best["40"] ?? rule.best["30"] ?? rule.best["20"] ?? null;

// 월 복리가 같으면 위험조정(MAR)이 나은 쪽을 상한으로 삼는다 — 같은 수익이면 낙폭이 작은 쪽이 낫다.
const hindsightBest = w.hindsight.reduce((a, b) => {
  if (!b.best) return a;
  if (!a?.best) return b;
  const dm = (b.best.monthlyGeo ?? -99) - (a.best.monthlyGeo ?? -99);
  if (Math.abs(dm) > 0.005) return dm > 0 ? b : a;
  return (b.best.mar ?? -99) > (a.best.mar ?? -99) ? b : a;
}, null);

const payload = {
  generatedAt: Date.now(),
  window: w.window,
  config: w.config,
  tfStart: w.tfStart,
  sweepTotal: sweep.rows.length,
  rules: w.rules.map((r) => ({
    rule: r.rule, name: r.name, why: r.why,
    n: r.raw.n, ev: r.raw.ev, pf: r.raw.pf, t: r.raw.t, winRate: r.raw.winRate,
    best: Object.fromEntries(Object.entries(r.best).map(([k, v]) => [k, v ? {
      ceiling: Number(k), overlay: v.overlay, riskPct: v.riskPct, monthlyGeo: v.monthlyGeo,
      cagr: v.cagr, mdd: v.mddPessimistic, mar: v.mar, finalEquity: v.finalEquity,
      tradesPerMonth: v.tradesPerMonth, ruin: v.ruin, bootP20: v.bootP20,
    } : null])),
    top: bestOf(r) ? {
      overlay: bestOf(r).overlay, riskPct: bestOf(r).riskPct, monthlyGeo: bestOf(r).monthlyGeo,
      cagr: bestOf(r).cagr, mdd: bestOf(r).mddPessimistic, finalEquity: bestOf(r).finalEquity,
    } : null,
  })),
  families: w.familyRanking,
  hindsight: w.hindsight.map((h) => ({
    topK: h.topK, families: h.families, n: h.raw.n, ev: h.raw.ev, t: h.raw.t,
    best: h.best ? {
      overlay: h.best.overlay, riskPct: h.best.riskPct, monthlyGeo: h.best.monthlyGeo,
      cagr: h.best.cagr, mdd: h.best.mddPessimistic, mar: h.best.mar,
      finalEquity: h.best.finalEquity, tradesPerMonth: h.best.tradesPerMonth,
      ruin: h.best.ruin, bootP20: h.best.bootP20,
    } : null,
  })),
  hindsightBest: hindsightBest ? { topK: hindsightBest.topK, families: hindsightBest.families, ...hindsightBest.best } : null,
  // 곡선은 상한으로 고른 그 topK 것을 쓴다 — 라벨과 곡선이 같은 구성을 가리켜야 한다.
  hindsightCurve: hindsightBest ? w.hindsightCurves?.[hindsightBest.topK]?.curve ?? null : null,
  hindsightMonthly: hindsightBest ? w.hindsightCurves?.[hindsightBest.topK]?.monthly ?? null : null,
  curves: w.curves,
  buyHold: { ...w.buyHold, curve: w.buyHoldCurve, mdd: w.buyHoldMdd, cagr: Math.round(bhCagr * 100) / 100, months: Math.round(months * 10) / 10 },
};

const tpl = readFileSync(join(LAB, "wfa-report-template.html"), "utf8");
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "wfa-report.html"), tpl.replace("__DATA_JSON__", JSON.stringify(payload)));
console.log(`저장 → out/wfa-report.html`);
