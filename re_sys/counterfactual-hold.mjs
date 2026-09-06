/**
 * REQ-0040 후속 질문 — "레버리지를 낮추고 손절을 넓히면 더 오래 보유할 수 있지 않나?"
 *
 * 명제 그대로 돌린다: 손절 없음, 낮은 레버(강제청산만), 진입 후 H 시간 뒤 종가 청산.
 * 같은 규칙을 대조군(진입 +24h 이동 · 방향 반전)에도 적용.
 * 그리고 "4시간 이상 보유 = 이익"이 선택 효과인지 본다 — 4시간 시점의 미실현 손익이 이미 플러스였나.
 */
import { loadData } from "./lib/data.mjs";
import { getWindow, loadChunkStore, TF_LADDER } from "./lib/windows.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LOCAL_SYMS = new Set(["BTC", "DOGE"]);
const MMR = (instId) => (instId.startsWith("BTC-") ? 0.004 : instId.startsWith("ETH-") ? 0.005 : 0.01);
const FUNDING_PER_8H = 0.0001;
const r2 = (x) => Math.round(x * 100) / 100;

const review = loadData("manual-review.json");
const chunkStore = loadChunkStore();
const localCache = new Map();
const loadLocal = (sym, bar) => {
  const k = `${sym}|${bar}`;
  if (!localCache.has(k)) {
    const s = loadData(`candles-${sym}-${bar}.json`);
    localCache.set(k, s ? s.candles : null);
  }
  return localCache.get(k);
};
const lowerBound = (arr, ts) => {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};
function mechPath(p, horizonMs) {
  const endTs = p.entryTs + horizonMs;
  if (LOCAL_SYMS.has(p.sym)) {
    const m15 = loadLocal(p.sym, "15m");
    const useM15 = m15 && m15.length && m15[0].t <= p.entryTs;
    const arr = useM15 ? m15 : loadLocal(p.sym, "1H");
    const tfMs = useM15 ? 15 * 60_000 : HOUR;
    if (!arr) return null;
    const from = Math.floor(p.entryTs / tfMs) * tfMs;
    const bars = arr.slice(lowerBound(arr, from), lowerBound(arr, endTs + 1));
    return bars.length ? { bars, tfMs } : null;
  }
  const tf = TF_LADDER.find((x) => x.bar === "15m");
  const from = Math.floor(p.entryTs / tf.ms) * tf.ms;
  const bars = getWindow(chunkStore, p.instId, tf, from, endTs);
  return bars ? { bars, tfMs: tf.ms } : null;
}

const trades = review.trades.filter((t) => t.path && t.tf).map((t) => {
  const dir = t.side === "long" ? 1 : -1;
  const move = (t.exitPx - t.entryPx) / t.entryPx * dir;
  let notional = null;
  if (t.pnlRatioPct && t.lever) notional = (t.pnlUsd / (t.pnlRatioPct / 100)) * t.lever;
  else if (Math.abs(move) > 1e-6 && t.pnlGrossUsd != null) notional = t.pnlGrossUsd / move;
  if (!(notional > 0)) return null;
  return { id: t.id, instId: t.instId, sym: t.instId.split("-")[0], side: t.side, dir, lever: t.lever, entryTs: t.entryTs, exitTs: t.exitTs, entryPx: t.entryPx, exitPx: t.exitPx, pnlUsd: t.pnlUsd ?? 0, notional, feeRate: t.feeUsd ? Math.abs(t.feeUsd) / notional : 0.001, mmr: MMR(t.instId), holdMin: t.holdMin, year: new Date(t.entryTs).getUTCFullYear(), liq: !!t.liq, maePct: t.path.maePct, intentGroup: t.intentGroup };
}).filter(Boolean);

const variantOf = (p, v) => {
  if (v === "user") return p;
  if (v === "mirror") return { ...p, dir: -p.dir, side: p.side === "long" ? "short" : "long" };
  const entryTs = p.entryTs + DAY;
  const path = mechPath({ ...p, entryTs }, 0);
  const first = path?.bars.find((b) => b.t + path.tfMs > entryTs) ?? path?.bars.at(-1);
  return first ? { ...p, entryTs, entryPx: first.o } : null;
};

/** 손절 없음 · 레버 L′ 강제청산만 · H 뒤 종가. */
function holdOnly(p, path, lever, horizonMs) {
  const liqFrac = lever ? Math.max(1 / lever - p.mmr, 1e-6) : null;
  const liqPx = liqFrac !== null ? p.entryPx * (1 - p.dir * liqFrac) : null;
  const untilTs = p.entryTs + horizonMs;
  let last = null;
  for (const b of path.bars) {
    if (b.t > untilTs) break;
    last = b;
    if (liqPx !== null && (p.dir === 1 ? b.l <= liqPx : b.h >= liqPx)) return { reason: "liq", holdMs: Math.max(0, b.t - p.entryTs), exitPx: liqPx };
  }
  if (!last) return null;
  return { reason: "time", holdMs: Math.max(0, last.t - p.entryTs), exitPx: last.c };
}
function pnl(p, res, lever) {
  const N = p.notional;
  const fund = N * FUNDING_PER_8H * (res.holdMs / (8 * HOUR));
  if (res.reason === "liq") return -N / lever - fund;
  return N * ((res.exitPx - p.entryPx) / p.entryPx) * p.dir - N * p.feeRate - fund;
}

const LEVERS = [10, 5, 3];
const HS = [{ key: "4h", ms: 4 * HOUR }, { key: "24h", ms: DAY }, { key: "72h", ms: 3 * DAY }, { key: "7d", ms: 7 * DAY }];
const out = {};
for (const variant of ["user", "shift24h", "mirror"]) {
  const vt = trades.map((p) => variantOf(p, variant)).filter(Boolean);
  const paths = new Map();
  for (const p of vt) {
    const path = mechPath(p, HS.at(-1).ms);
    if (path) paths.set(p.id, path);
  }
  for (const L of LEVERS) for (const H of HS) {
    const rows = [];
    for (const p of vt) {
      const path = paths.get(p.id);
      if (!path) continue;
      const res = holdOnly(p, path, L, H.ms);
      if (!res) continue;
      rows.push({ p, pnl: pnl(p, res, L), reason: res.reason });
    }
    const n = rows.length;
    const net = rows.reduce((s, r) => s + r.pnl, 0);
    const actual = rows.reduce((s, r) => s + r.p.pnlUsd, 0);
    const ret = (rows.reduce((s, r) => s + r.pnl / r.p.notional, 0) / n) * 100;
    const actualRet = (rows.reduce((s, r) => s + r.p.pnlUsd / r.p.notional, 0) / n) * 100;
    const liq = rows.filter((r) => r.reason === "liq").length;
    const wins = rows.filter((r) => r.pnl > 0).length;
    const byYear = {};
    for (const r of rows) {
      const y = byYear[r.p.year] ??= { n: 0, ret: 0 };
      y.n += 1;
      y.ret += r.pnl / r.p.notional;
    }
    for (const y of Object.values(byYear)) y.ret = r2((y.ret / y.n) * 100);
    const byGroup = {};
    for (const r of rows) {
      const g = byGroup[r.p.intentGroup] ??= { n: 0, ret: 0, net: 0 };
      g.n += 1;
      g.ret += r.pnl / r.p.notional;
      g.net += r.pnl;
    }
    for (const g of Object.values(byGroup)) {
      g.ret = r2((g.ret / g.n) * 100);
      g.net = r2(g.net);
    }
    out[`${variant}|L=${L}|H=${H.key}`] = { variant, L, H: H.key, n, net: r2(net), actual: r2(actual), retPct: r2(ret), actualRetPct: r2(actualRet), liq, winRate: r2((wins / n) * 100), byYear, byGroup };
  }
}

/* ---------- 선택 효과 — 4시간 시점의 미실현 손익 ---------- */
const sel = { long: { n: 0, aheadAt4h: 0, finalWin: 0, net: 0 }, short: { n: 0, aheadAt4h: 0, finalWin: 0, net: 0 } };
const survive = { long: { n: 0, beyondLiq: 0, topUpNet: 0 }, short: { n: 0, beyondLiq: 0 } };
for (const p of trades) {
  const key = p.holdMin >= 240 ? "long" : "short";
  const path = mechPath(p, 4 * HOUR);
  if (key === "long" && path) {
    const bars = path.bars.filter((b) => b.t <= p.entryTs + 4 * HOUR);
    const last = bars.at(-1);
    if (last) {
      sel.long.n += 1;
      const unreal = (last.c - p.entryPx) / p.entryPx * p.dir;
      if (unreal > 0) sel.long.aheadAt4h += 1;
      if (p.pnlUsd > 0) sel.long.finalWin += 1;
      sel.long.net += p.pnlUsd;
    }
  }
  if (p.lever) {
    survive[key].n += 1;
    const liqFrac = Math.max(1 / p.lever - p.mmr, 1e-6);
    if (p.maePct / 100 > liqFrac && !p.liq) {
      survive[key].beyondLiq += 1;
      if (key === "long") survive.long.topUpNet += p.pnlUsd;
    }
  }
}
// 4시간 이상 보유 거래의 레버 분포
const levLong = {};
for (const p of trades.filter((x) => x.holdMin >= 240 && x.lever)) levLong[p.lever] = (levLong[p.lever] || 0) + 1;
const levShort = {};
for (const p of trades.filter((x) => x.holdMin < 240 && x.lever)) levShort[p.lever] = (levShort[p.lever] || 0) + 1;

console.log("=== 손절 없음 · 낮은 레버 · H 뒤 종가 청산 — 거래당 수익률(%) 사용자 | +24h | 반전 ===");
for (const L of LEVERS) {
  console.log(`L′=${L}배  ` + HS.map((H) => { const u = out[`user|L=${L}|H=${H.key}`]; const s = out[`shift24h|L=${L}|H=${H.key}`]; const m = out[`mirror|L=${L}|H=${H.key}`]; return `${H.key}: ${u.retPct}|${s.retPct}|${m.retPct} (liq ${u.liq})`; }).join("   "));
}
console.log("실제 거래당", out["user|L=10|H=4h"].actualRetPct, "실제 순손익", out["user|L=10|H=4h"].actual);
console.log("=== 동일 명목 순손익 $ (사용자) ===");
for (const L of LEVERS) console.log(`L′=${L}배  ` + HS.map((H) => { const u = out[`user|L=${L}|H=${H.key}`]; return `${H.key}: ${Math.round(u.net)} (승률 ${u.winRate})`; }).join("   "));
console.log("=== 연도별 거래당 (L′=5, H=72h) 사용자|+24h|반전 ===", ["2024", "2025", "2026"].map((y) => `${y}: ${out["user|L=5|H=72h"].byYear[y]?.ret}|${out["shift24h|L=5|H=72h"].byYear[y]?.ret}|${out["mirror|L=5|H=72h"].byYear[y]?.ret}`).join("  "));
console.log("=== 의도별 거래당 (L′=5, H=72h) ===", JSON.stringify(out["user|L=5|H=72h"].byGroup));
console.log("=== 선택 효과 ===");
console.log(`4시간 이상 보유 ${sel.long.n}건: 4시간 시점에 이미 이익이던 거래 ${sel.long.aheadAt4h}건(${r2((sel.long.aheadAt4h / sel.long.n) * 100)}%) · 최종 이익 ${sel.long.finalWin}건 · 순손익 ${Math.round(sel.long.net)}`);
console.log(`명목 레버 기준 청산 거리를 넘고도 살아남은(증거금 추가 추정) 거래 — 4시간 이상: ${survive.long.beyondLiq}/${survive.long.n} (순손익 ${Math.round(survive.long.topUpNet)}) · 4시간 미만: ${survive.short.beyondLiq}/${survive.short.n}`);
console.log("4시간 이상 보유 레버 분포", JSON.stringify(levLong), "/ 4시간 미만", JSON.stringify(levShort));
loadData; // keep import used
import("./lib/data.mjs").then(({ saveData }) => { saveData("counterfactual-hold.json", { generatedAt: Date.now(), out, sel, survive, levLong, levShort }); console.log("저장 → re_sys/data/counterfactual-hold.json"); });
