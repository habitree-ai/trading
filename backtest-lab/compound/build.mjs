/**
 * 1단계 — 부품 거래 스트림 생성 + 기존 회차와의 대조.
 * 거래 수가 기존 회차와 크게 어긋나면 부품이 재현되지 않은 것이므로 여기서 멈춘다.
 */
import { performance } from "node:perf_hooks";
import { saveOut } from "../lib/data.mjs";
import { loadAll } from "../lib/runner.mjs";
import { tradeStats } from "../lib/stats.mjs";
import { PARTS, SETS, buildPartContext, runPart } from "./lib/components.mjs";

/**
 * 기존 회차가 보고한 거래 수 — 재현 검사의 기준선. 러너 2종은 이번 회차가 처음이라 없음.
 * dc(1D)만 창이 다르다: 앙상블 회차는 1D 캔들 2,399봉(2020-01~)을 썼고 이 랩의 캐시는
 * 1,799봉(2021-09~)이다. 600봉 = 약 1.6년치가 없으므로 거래 수가 적은 것이 정상이다.
 * 어차피 복리 창은 1H 부품이 시작되는 2023년 이후이므로 그 이전 구간은 쓰이지 않는다.
 */
const EXPECTED = { gc: 117, ob: 151, fade: 125, dc: 68, dch: 164, mcv: 124, ibq: 215, ib4: 304, mp1: 200, rf1: 103, bzc: 112 };
const WINDOW_NOTE = { dc: "1D 캔들 600봉 짧음(랩 캐시 2021-09~ vs 앙상블 2020-01~)" };

const t0 = performance.now();
const { data, fundingCum, fetchedAt } = loadAll();
const ctx = buildPartContext(data);
console.log(`베이시스 커버리지 ${(ctx.basisCoverage * 100).toFixed(1)}% (현물 캔들 정렬)`);

const parts = {};
const rows = [];
for (const p of PARTS) {
  const trades = runPart(p, ctx, fundingCum);
  const st = tradeStats(trades.map((t) => t.net));
  parts[p.key] = trades;
  const exp = EXPECTED[p.key] ?? null;
  const drift = exp ? ((st.n - exp) / exp) * 100 : null;
  rows.push({
    key: p.key, label: p.label, tf: p.tf, side: p.side, origin: p.origin, lens: p.lens,
    n: st.n, expected: exp, driftPct: drift === null ? null : Math.round(drift * 10) / 10,
    winRate: st.winRate, ev: st.ev, pf: st.pf, t: st.t, sd: st.sd, totalPct: st.totalPct,
    from: trades.length ? trades[0].entryAt : null, to: trades.length ? trades[trades.length - 1].exitAt : null,
    avgSl: Math.round((trades.reduce((s, x) => s + x.slPct, 0) / Math.max(1, trades.length)) * 100) / 100,
    payoff: (() => {
      const w = trades.filter((x) => x.net > 0).map((x) => x.net);
      const l = trades.filter((x) => x.net <= 0).map((x) => x.net);
      if (!w.length || !l.length) return null;
      const aw = w.reduce((s, x) => s + x, 0) / w.length;
      const al = l.reduce((s, x) => s + x, 0) / l.length;
      return Math.round((aw / Math.abs(al)) * 100) / 100;
    })(),
  });
}

/** 부품 간 상관 — 월별 손익 벡터 기준. 분산 효과가 실재하는지 여기서 정해진다. */
const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7);
const months = [...new Set(Object.values(parts).flat().map((t) => monthKey(t.exitAt)))].sort();
const monthly = {};
for (const [k, tr] of Object.entries(parts)) {
  const m = new Map(months.map((x) => [x, 0]));
  for (const t of tr) m.set(monthKey(t.exitAt), (m.get(monthKey(t.exitAt)) ?? 0) + t.net);
  monthly[k] = months.map((x) => m.get(x));
}
const keys = PARTS.map((p) => p.key);
const corr = keys.map((a) => keys.map((b) => {
  const x = monthly[a], y = monthly[b];
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i += 1) { num += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  return dx > 0 && dy > 0 ? Math.round((num / Math.sqrt(dx * dy)) * 100) / 100 : 0;
}));

/** 묶음별 평균 상관 — 낮을수록 병행의 값이 크다. */
const setCorr = {};
for (const s of SETS) {
  const idx = s.parts.map((k) => keys.indexOf(k));
  let sum = 0, cnt = 0;
  for (let a = 0; a < idx.length; a += 1) for (let b = a + 1; b < idx.length; b += 1) { sum += corr[idx[a]][idx[b]]; cnt += 1; }
  setCorr[s.key] = cnt ? Math.round((sum / cnt) * 1000) / 1000 : null;
}

const bad = rows.filter((r) => r.driftPct !== null && Math.abs(r.driftPct) > 5 && !WINDOW_NOTE[r.key]);
saveOut("compound-parts.json", {
  generatedAt: Date.now(), fetchedAt, windowNote: WINDOW_NOTE,
  basisCoverage: Math.round(ctx.basisCoverage * 1000) / 1000,
  rows, corrKeys: keys, corr, setCorr, months, monthly,
  sets: SETS, parts,
});

console.table(rows.map((r) => ({
  부품: r.key + " " + r.label, 봉: r.tf, 방향: r.side === "long" ? "롱" : "숏",
  거래: r.n, 기존: r.expected ?? "—", "편차%": r.driftPct ?? "—",
  승률: r.winRate, 기대값: r.ev, PF: r.pf, t: r.t, 페이오프: r.payoff, "평균 1R%": r.avgSl,
})));
console.log("");
console.log("묶음별 평균 상관:", JSON.stringify(setCorr));
for (const [k, why] of Object.entries(WINDOW_NOTE)) {
  const r = rows.find((x) => x.key === k);
  if (r) console.log(`창 차이 고지 — ${k}: ${r.n}건 vs 기존 ${r.expected}건 · ${why}`);
}
if (bad.length) {
  console.log("");
  console.log("재현 편차 5% 초과 — 확인 필요:");
  for (const x of bad) console.log(`  ${x.key}: ${x.n}건 vs 기존 ${x.expected}건 (${x.driftPct}%)`);
} else {
  console.log("");
  console.log("재현 검사 통과 — 창이 같은 전 부품에서 기존 회차 대비 ±5% 이내");
}
console.log(`총 ${Math.round((performance.now() - t0) / 1000)}s`);
