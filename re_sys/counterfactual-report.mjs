/**
 * REQ-0040 리포트 — counterfactual.json + manual-review.json → out/counterfactual-report.html
 * 실행: node re_sys/counterfactual-report.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadData, OUT_DIR } from "./lib/data.mjs";

const cf = loadData("counterfactual.json");
const rv = loadData("manual-review.json");
if (!cf || !rv) throw new Error("counterfactual.json / manual-review.json 필요");

const KST = 9 * 3_600_000;
const money = (x) => (x === null || x === undefined ? "–" : `${x < 0 ? "−" : ""}$${Math.abs(Math.round(x)).toLocaleString("en-US")}`);
const pct = (x, d = 2) => (x === null || x === undefined ? "–" : `${x < 0 ? "−" : x > 0 ? "+" : ""}${Math.abs(x).toFixed(d)}%`);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const signCls = (x) => (x < 0 ? "neg" : x > 0 ? "pos" : "");

/* ---------- 진단 수치 (manual-review) ---------- */
const T = rv.trades;
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const net = sum(T, (x) => x.pnlUsd || 0);
const fee = sum(T, (x) => Math.abs(x.feeUsd || 0));
const funding = sum(T, (x) => x.fundingUsd || 0);
const gross = sum(T, (x) => x.pnlGrossUsd ?? (x.pnlUsd || 0) + Math.abs(x.feeUsd || 0));
const liqTrades = T.filter((x) => x.liq);
const liqLoss = sum(liqTrades, (x) => x.pnlUsd);
const holdBuckets = [
  { key: "30분 미만", test: (x) => x.holdMin < 30 },
  { key: "30분–4시간", test: (x) => x.holdMin >= 30 && x.holdMin < 240 },
  { key: "4–24시간", test: (x) => x.holdMin >= 240 && x.holdMin < 1440 },
  { key: "24시간 이상", test: (x) => x.holdMin >= 1440 },
].map((b) => {
  const rows = T.filter(b.test);
  return { key: b.key, n: rows.length, net: sum(rows, (x) => x.pnlUsd || 0), fee: sum(rows, (x) => Math.abs(x.feeUsd || 0)), winRate: (rows.filter((x) => x.pnlUsd > 0).length / rows.length) * 100 };
});
const days = {};
for (const x of T) days[x.day] = (days[x.day] || 0) + 1;
const heavyDays = new Set(Object.entries(days).filter(([, n]) => n > 5).map(([d]) => d));
const heavy = T.filter((x) => heavyDays.has(x.day));
const light = T.filter((x) => !heavyDays.has(x.day));
const losses = T.filter((x) => x.pnlUsd < 0).sort((a, b) => a.pnlUsd - b.pnlUsd);
const lossTotal = sum(losses, (x) => x.pnlUsd);
const worst5 = losses.slice(0, Math.ceil(losses.length * 0.05));
const worst5Share = (sum(worst5, (x) => x.pnlUsd) / lossTotal) * 100;
const topUp = T.filter((x) => x.path && x.lever && !x.liq && x.path.maeMarginPct >= 100);
const topUpNet = sum(topUp, (x) => x.pnlUsd);
const wins = T.filter((x) => x.pnlUsd > 0);
const avgWin = sum(wins, (x) => x.pnlUsd) / wins.length;
const avgLoss = lossTotal / losses.length;
const first = new Date(Math.min(...T.map((x) => x.entryTs)) + KST).toISOString().slice(0, 10);
const last = new Date(Math.max(...T.map((x) => x.exitTs)) + KST).toISOString().slice(0, 10);
const leverDist = {};
for (const x of T) if (x.lever) leverDist[x.lever] = (leverDist[x.lever] || 0) + 1;
const lev50plus = T.filter((x) => x.lever >= 50).length;

/* ---------- 실험 1 표 ---------- */
const e1 = cf.exp1.frames.notional;
const e1r = cf.exp1.frames.risk;
const base = e1["L=actual|S=none"];
const LEVERS = cf.grid.LEVERS;
const STOPS1 = cf.grid.STOPS1;
const levLabel = (L) => (L === "actual" ? "실제(명목 50·100배 다수)" : `${L}배`);
const stopLabel = (s) => (s === "none" ? "없음" : s.endsWith("ATR") ? `${s.replace("ATR", "")}×ATR` : s);
const e1Cells = LEVERS.map((L) => STOPS1.map((s) => {
  const o = e1[`L=${L}|S=${s}`];
  return o ? { net: o.net, delta: o.net - base.actual, liq: o.reasons.liq || 0, stop: o.reasons.stop || 0, ret: o.retPct } : null;
}));
const e1Worst = Math.min(...e1Cells.flat().filter(Boolean).map((c) => c.delta));
const stopDiag = STOPS1.filter((s) => s !== "none").map((s) => ({ s, ...cf.exp1.stopDiag[`L=actual|S=${s}`], net: e1[`L=actual|S=${s}`]?.net }));

/* ---------- 실험 2 표 — 전 종목(2단계) 있으면 그것, 없으면 BTC·DOGE ---------- */
const hasAll = !!cf.exp2All;
const X = hasAll ? cf.exp2All : cf.exp2Local;
const XS = hasAll ? cf.exp2AllShift : cf.exp2LocalShift;
const XM = hasAll ? cf.exp2AllMirror : cf.exp2LocalMirror;
const STOPS2 = cf.grid.STOPS2.filter((s) => !s.endsWith("ATR"));
const TP_K = cf.grid.TP_K;
const HORIZONS = cf.grid.HORIZONS;
const exp2Rows = [];
for (const s of STOPS2) for (const k of TP_K) for (const h of HORIZONS) {
  const key = `S=${s}|k=${k}|H=${h}`;
  const u = X.frames.risk[key];
  const sh = XS.frames.risk[key];
  const m = XM.frames.risk[key];
  const n = X.frames.notional[key];
  if (!u) continue;
  exp2Rows.push({ key, s, k, h, user: u.retPct, shift: sh?.retPct ?? null, mirror: m?.retPct ?? null, actualRet: u.actualRetPct, netN: n?.net ?? null, trimN: n?.trim3?.net ?? null, actualN: n?.actual ?? null, trimA: n?.trim3?.actual ?? null, byYear: n?.byYear, reasons: u.reasons, winRate: u.winRate });
}
// 손절 폭별 요약(k·H 평균) — 차트용
const byStop = STOPS2.map((s) => {
  const rows = exp2Rows.filter((r) => r.s === s);
  const avg = (f) => rows.reduce((a, r) => a + (f(r) ?? 0), 0) / rows.length;
  return { s, user: avg((r) => r.user), shift: avg((r) => r.shift), mirror: avg((r) => r.mirror) };
});
const bestUser = exp2Rows.slice().sort((a, b) => b.user - a.user)[0];
const bestNet = exp2Rows.slice().sort((a, b) => b.netN - a.netN)[0];
const anyPositive = exp2Rows.filter((r) => r.user > 0).length;
const userBeatsShift = exp2Rows.filter((r) => r.shift !== null && r.user > r.shift).length;
const userBeatsMirror = exp2Rows.filter((r) => r.mirror !== null && r.user > r.mirror).length;
const grp = X.frames.notional["S=2%|k=2|H=72h"]?.byGroup ?? {};
const gate = cf.gateAll ?? cf.gate;
const riskPasses = (cf.gate.top ?? []).filter((g) => g.frame === "risk").length;

/* ---------- 실험 2 종목별 (전 종목일 때) ---------- */
const symRows = (() => {
  const o = X.frames.risk["S=2%|k=1|H=24h"]?.bySym ?? {};
  return Object.entries(o).sort((a, b) => b[1].n - a[1].n).slice(0, 8).map(([sym, v]) => ({ sym, n: v.n, ret: v.n ? null : null, net: v.net, actual: v.actual }));
})();

/* ---------- HTML ---------- */
const y = (v, lo, hi, h) => h - ((v - lo) / (hi - lo)) * h;

function holdChart() {
  const W = 640;
  const H = 220;
  const padL = 70;
  const padB = 44;
  const padT = 16;
  const plotH = H - padB - padT;
  const vals = holdBuckets.map((b) => b.net);
  const lo = Math.min(0, ...vals) * 1.15;
  const hi = Math.max(0, ...vals) * 1.15;
  const bw = (W - padL - 20) / holdBuckets.length;
  const zero = padT + y(0, lo, hi, plotH);
  const ticks = [-30000, -20000, -10000, 0, 10000];
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="보유 시간별 순손익">
  ${ticks.filter((t) => t >= lo && t <= hi).map((t) => { const yy = padT + y(t, lo, hi, plotH); return `<line x1="${padL}" x2="${W - 20}" y1="${yy}" y2="${yy}" class="grid"/><text x="${padL - 8}" y="${yy + 4}" class="tick" text-anchor="end">${t === 0 ? "0" : `${t < 0 ? "−" : "+"}$${Math.abs(t) / 1000}k`}</text>`; }).join("")}
  <line x1="${padL}" x2="${W - 20}" y1="${zero}" y2="${zero}" class="axis"/>
  ${holdBuckets.map((b, i) => {
    const x0 = padL + i * bw + bw * 0.18;
    const w = bw * 0.64;
    const yv = padT + y(b.net, lo, hi, plotH);
    const top = Math.min(yv, zero);
    const hh = Math.abs(zero - yv);
    const cls = b.net < 0 ? "bar neg" : "bar pos";
    return `<g class="hit"><title>${b.key} · ${b.n}건 · 순손익 ${money(b.net)} · 수수료 ${money(-b.fee)} · 승률 ${b.winRate.toFixed(1)}%</title><rect x="${x0}" y="${top}" width="${w}" height="${Math.max(hh, 1)}" rx="3" class="${cls}"/><text x="${x0 + w / 2}" y="${b.net < 0 ? yv + 16 : yv - 6}" class="val" text-anchor="middle">${money(b.net)}</text><text x="${x0 + w / 2}" y="${H - padB + 18}" class="cat" text-anchor="middle">${b.key}</text><text x="${x0 + w / 2}" y="${H - padB + 34}" class="tick" text-anchor="middle">${b.n}건 · 승률 ${b.winRate.toFixed(0)}%</text></g>`;
  }).join("")}
</svg>`;
}

function exp2Chart() {
  const W = 640;
  const H = 240;
  const padL = 56;
  const padB = 40;
  const padT = 16;
  const plotH = H - padB - padT;
  const all = byStop.flatMap((b) => [b.user, b.shift, b.mirror]);
  const lo = Math.min(...all, -0.05) - 0.05;
  const hi = Math.max(...all, 0.02) + 0.05;
  const step = (W - padL - 24) / (byStop.length - 1);
  const px = (i) => padL + i * step;
  const py = (v) => padT + y(v, lo, hi, plotH);
  const series = [
    { key: "user", label: "사용자 진입", cls: "s1" },
    { key: "shift", label: "대조: 진입 +24h", cls: "s2" },
    { key: "mirror", label: "대조: 방향 반전", cls: "s3" },
  ];
  const ticks = [];
  for (let t = Math.ceil(lo * 10) / 10; t <= hi; t += 0.1) ticks.push(Math.round(t * 10) / 10);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="손절 폭별 거래당 기대수익률 — 사용자 진입 vs 대조군">
  ${ticks.map((t) => `<line x1="${padL}" x2="${W - 16}" y1="${py(t)}" y2="${py(t)}" class="${t === 0 ? "axis" : "grid"}"/><text x="${padL - 8}" y="${py(t) + 4}" class="tick" text-anchor="end">${pct(t, 1)}</text>`).join("")}
  ${byStop.map((b, i) => `<text x="${px(i)}" y="${H - padB + 20}" class="cat" text-anchor="middle">손절 ${b.s}</text>`).join("")}
  ${series.map((s) => `<polyline class="line ${s.cls}" points="${byStop.map((b, i) => `${px(i)},${py(b[s.key])}`).join(" ")}"/>`).join("")}
  ${series.map((s) => byStop.map((b, i) => `<g class="hit"><title>${s.label} · 손절 ${b.s} · 거래당 ${pct(b[s.key])} (목표 k·시한 H 16조합 평균)</title><circle cx="${px(i)}" cy="${py(b[s.key])}" r="5" class="dot ${s.cls}"/></g>`).join("")).join("")}
  ${series.map((s) => { const b = byStop.at(-1); return `<text x="${px(byStop.length - 1) + 8}" y="${py(b[s.key]) + 4}" class="lbl ${s.cls}">${pct(b[s.key])}</text>`; }).join("")}
</svg>
<div class="legend">${series.map((s) => `<span><i class="sw ${s.cls}"></i>${s.label}</span>`).join("")}</div>`;
}

function e1Table() {
  const head = `<tr><th class="rowh">레버리지 L′ ＼ 손절 S</th>${STOPS1.map((s) => `<th>${stopLabel(s)}</th>`).join("")}</tr>`;
  const body = LEVERS.map((L, i) => `<tr><th class="rowh">${levLabel(L)}</th>${e1Cells[i].map((c, j) => {
    if (!c) return `<td class="na">–</td>`;
    const isBase = L === "actual" && STOPS1[j] === "none";
    const t = Math.min(1, Math.max(0, c.delta / e1Worst));
    const style = isBase ? "" : `style="--t:${t.toFixed(3)}"`;
    return `<td class="${isBase ? "base" : "heat"}" ${style} title="순손익 ${money(c.net)} · 실제 대비 ${money(c.delta)} · 합성 강제청산 ${c.liq}건 · 손절 체결 ${c.stop}건 · 거래당 ${pct(c.ret)}"><b>${money(c.net)}</b><small>${isBase ? "실제 재현" : `${c.liq ? `청산 ${c.liq}` : ""}${c.liq && c.stop ? " · " : ""}${c.stop ? `손절 ${c.stop}` : ""}` || "—"}</small></td>`;
  }).join("")}</tr>`).join("");
  return `<table class="grid-t">${head}${body}</table>`;
}

function stopDiagTable() {
  return `<table class="plain"><tr><th>손절 S</th><th>손절에 걸린 거래</th><th>죽인 승리 거래</th><th>미리 자른 손실 거래</th><th>순손익(실제 청산 시각 유지)</th><th>실제 대비</th></tr>${stopDiag.map((d) => `<tr><td>${stopLabel(d.s)}</td><td class="num">${d.killedWinners + d.savedLosers}</td><td class="num">${d.killedWinners}</td><td class="num">${d.savedLosers}</td><td class="num">${money(d.net)}</td><td class="num ${signCls(d.net - base.actual)}">${money(d.net - base.actual)}</td></tr>`).join("")}</table>`;
}

function exp2Table() {
  const top = exp2Rows.slice().sort((a, b) => b.netN - a.netN).slice(0, 6);
  return `<table class="plain"><tr><th>조합 (손절 · 목표 · 시한)</th><th>동일 명목 순손익</th><th>상위 3% 제외</th><th>거래당 수익률</th><th>대조 +24h</th><th>대조 반전</th><th>연도별(명목)</th></tr>${top.map((r) => `<tr><td>S ${r.s} · 목표 ${r.k}×S · 시한 ${r.h}</td><td class="num ${signCls(r.netN)}">${money(r.netN)}</td><td class="num ${signCls(r.trimN)}">${money(r.trimN)}</td><td class="num ${signCls(r.user)}">${pct(r.user)}</td><td class="num">${pct(r.shift)}</td><td class="num">${pct(r.mirror)}</td><td class="small">${Object.entries(r.byYear ?? {}).filter(([yy]) => yy !== "2023").map(([yy, v]) => `${yy} ${money(v.net)}`).join(" · ")}</td></tr>`).join("")}<tr class="ref"><td>실제 (같은 거래)</td><td class="num neg">${money(top[0]?.actualN)}</td><td class="num neg">${money(top[0]?.trimA)}</td><td class="num neg">${pct(top[0]?.actualRet)}</td><td>–</td><td>–</td><td class="small">${Object.entries(top[0]?.byYear ?? {}).filter(([yy]) => yy !== "2023").map(([yy, v]) => `${yy} ${money(v.actual)}`).join(" · ")}</td></tr></table>`;
}

function groupTable() {
  const label = { 역추세: "역추세(급락 매수·급등 숏)", 추세순응: "추세 순응(눌림·되돌림)", 추격: "돌파 추격", 모호: "판정 모호" };
  return `<table class="plain"><tr><th>진입 의도</th><th>건수</th><th>실제 순손익</th><th>기계적 청산(S 2% · 목표 2×S · 시한 72h, 동일 명목)</th></tr>${Object.entries(grp).sort((a, b) => a[1].actual - b[1].actual).map(([g, v]) => `<tr><td>${label[g] ?? g}</td><td class="num">${v.n}</td><td class="num ${signCls(v.actual)}">${money(v.actual)}</td><td class="num ${signCls(v.net)}">${money(v.net)}</td></tr>`).join("")}</table>`;
}

const title = "레버리지·손절 반사실 감사";
const html = `<title>${title}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{color-scheme:light;--bg:#f5f6f8;--paper:#ffffff;--ink:#171a20;--muted:#5b6370;--faint:#8a92a0;--line:#dde1e7;--line2:#eceff3;--accent:#1f5f8b;--accent-ink:#ffffff;--neg:#b8410f;--neg-bg:#fbeee6;--pos:#0e7367;--pos-bg:#e3f3f0;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--heat:31,95,139}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#14171c;--paper:#1b1f26;--ink:#e6e9ee;--muted:#a0a8b4;--faint:#6e7683;--line:#2b313b;--line2:#232830;--accent:#5aa3d8;--accent-ink:#0f1620;--neg:#f0925f;--neg-bg:#3a2418;--pos:#43bfae;--pos-bg:#12342f;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--heat:90,163,216}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#14171c;--paper:#1b1f26;--ink:#e6e9ee;--muted:#a0a8b4;--faint:#6e7683;--line:#2b313b;--line2:#232830;--accent:#5aa3d8;--accent-ink:#0f1620;--neg:#f0925f;--neg-bg:#3a2418;--pos:#43bfae;--pos-bg:#12342f;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--heat:90,163,216}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"IBM Plex Sans KR","Noto Sans KR",system-ui,-apple-system,"Segoe UI",sans-serif;font-size:15px;line-height:1.65;-webkit-font-smoothing:antialiased}
.wrap{max-width:880px;margin:0 auto;padding:40px 24px 80px}
.eyebrow{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin:0 0 10px}
h1{font-size:30px;line-height:1.25;font-weight:700;margin:0 0 8px;text-wrap:balance;letter-spacing:-.01em}
.lede{color:var(--muted);margin:0 0 28px;max-width:62ch}
h2{font-size:20px;font-weight:600;margin:48px 0 12px;padding-top:20px;border-top:1px solid var(--line);text-wrap:balance}
h3{font-size:16px;font-weight:600;margin:24px 0 8px}
p{max-width:68ch;margin:0 0 12px}
.verdict{background:var(--paper);border:1px solid var(--line);border-left:4px solid var(--accent);padding:20px 22px;margin:0 0 20px}
.verdict h2{border:0;margin:0 0 10px;padding:0;font-size:18px}
.verdict p{max-width:none}
.verdict ol{margin:8px 0 0;padding-left:20px}
.verdict li{margin:4px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0 8px}
.tile{background:var(--paper);border:1px solid var(--line);padding:12px 14px}
.tile .k{font-size:12px;color:var(--muted);letter-spacing:.02em}
.tile .v{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:22px;font-weight:500;margin-top:2px;font-variant-numeric:tabular-nums}
.tile .s{font-size:12px;color:var(--faint);margin-top:2px}
.neg{color:var(--neg)}.pos{color:var(--pos)}
.num{font-family:"IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.tblwrap{overflow-x:auto;margin:10px 0 6px;border:1px solid var(--line);background:var(--paper)}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th{font-weight:600;color:var(--muted);text-align:left;font-size:12.5px;letter-spacing:.01em}
th,td{padding:8px 10px;border-bottom:1px solid var(--line2);vertical-align:top}
tr:last-child td{border-bottom:0}
.plain th{background:var(--paper)}
.plain .ref td{background:var(--line2);font-weight:500}
.small{font-size:12px;color:var(--muted);font-family:"IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums;white-space:nowrap}
.grid-t th{text-align:center;white-space:nowrap}
.grid-t th.rowh{text-align:left}
.grid-t td{text-align:right;font-family:"IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums;white-space:nowrap;min-width:92px}
.grid-t td b{font-weight:500;display:block}
.grid-t td small{display:block;font-size:10.5px;color:var(--faint);margin-top:1px}
.grid-t td.heat{background:rgba(var(--heat),calc(var(--t)*.32))}
.grid-t td.base{outline:2px solid var(--accent);outline-offset:-2px;font-weight:600}
.grid-t td.na{color:var(--faint);text-align:center}
.note{font-size:12.5px;color:var(--muted);margin:6px 0 0;max-width:72ch}
figure{margin:14px 0 6px;background:var(--paper);border:1px solid var(--line);padding:14px 14px 10px}
figure svg{width:100%;height:auto;display:block;font-family:"IBM Plex Sans KR",system-ui,sans-serif}
figcaption{font-size:12.5px;color:var(--muted);margin-top:6px}
.grid{stroke:var(--line2);stroke-width:1}.axis{stroke:var(--line);stroke-width:1.2}
.tick{font-size:11px;fill:var(--faint);font-family:"IBM Plex Mono",ui-monospace,monospace}
.cat{font-size:12px;fill:var(--ink)}
.val{font-size:12px;fill:var(--ink);font-family:"IBM Plex Mono",ui-monospace,monospace;font-weight:500}
.bar.neg{fill:var(--neg)}.bar.pos{fill:var(--pos)}
.line{fill:none;stroke-width:2}.line.s1{stroke:var(--s1)}.line.s2{stroke:var(--s2)}.line.s3{stroke:var(--s3)}
.dot{stroke:var(--paper);stroke-width:2}.dot.s1{fill:var(--s1)}.dot.s2{fill:var(--s2)}.dot.s3{fill:var(--s3)}
.lbl{font-size:11px;font-family:"IBM Plex Mono",ui-monospace,monospace;fill:var(--ink)}
.hit:hover .dot{r:7}.hit:hover rect{opacity:.85}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--muted);margin-top:8px}
.legend .sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.sw.s1{background:var(--s1)}.sw.s2{background:var(--s2)}.sw.s3{background:var(--s3)}
.findings{counter-reset:f;list-style:none;padding:0;margin:12px 0 0}
.findings li{background:var(--paper);border:1px solid var(--line);padding:14px 16px 14px 56px;margin:0 0 10px;position:relative}
.findings li::before{counter-increment:f;content:counter(f);position:absolute;left:16px;top:12px;width:28px;height:28px;border-radius:50%;background:var(--accent);color:var(--accent-ink);font-family:"IBM Plex Mono",ui-monospace,monospace;font-weight:500;display:flex;align-items:center;justify-content:center;font-size:13px}
.findings b{display:block;margin-bottom:4px}
.findings .ev{font-size:13px;color:var(--muted)}
.findings .ev .num{text-align:left}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:8px 0;font-size:13.5px}
dt{color:var(--muted)}dd{margin:0}
.meta{font-size:12.5px;color:var(--faint);margin-top:40px;border-top:1px solid var(--line);padding-top:12px;font-family:"IBM Plex Mono",ui-monospace,monospace}
@media (prefers-reduced-motion: reduce){*{transition:none!important}}
</style>
<div class="wrap">
<p class="eyebrow">REQ-0040 · 실거래 반사실 백테스트 · ${new Date(cf.generatedAt + KST).toISOString().slice(0, 10)}</p>
<h1>레버리지를 낮추고 손절을 넓혔다면, 내 매매는 나아졌을까</h1>
<p class="lede">OKX 실거래 ${T.length.toLocaleString()}건(${first} ~ ${last}, 주계좌·봇서브계좌)의 진입 결정은 그대로 두고, 레버리지와 손절 폭만 바꿔 실제 캔들 경로로 다시 돌린 결과. 개선점을 찾기 위한 준비 작업.</p>

<div class="verdict">
<h2>답: 아니다. 레버리지·손절은 손실의 원인이 아니었다.</h2>
<p>실제 청산 시각을 유지한 채 어떤 고정 손절을 얹어도 실제보다 나빠졌고(넓을수록 덜 나쁠 뿐), 레버리지를 3배까지 낮춰도 거래당 기대값은 그대로다. 진입만 남기고 기계적으로 청산하는 실험에서는 ${exp2Rows.length}개 조합 전부 거래당 수익률이 음수였고, 같은 시장에서 진입 시각을 하루 미룬 대조군이 ${exp2Rows.length - userBeatsShift}개 조합에서, 방향을 뒤집은 대조군이 ${exp2Rows.length - userBeatsMirror}개 조합에서 사용자 진입보다 나았다.</p>
<p>손실은 세 곳에서 나왔다.</p>
<ol>
<li><b>수수료</b> — 순손실 ${money(net)} 중 ${money(-fee)}(${((fee / -net) * 100).toFixed(0)}%). 가격 손익만 보면 ${money(gross)}.</li>
<li><b>4시간 미만 보유</b> — ${money(holdBuckets[0].net + holdBuckets[1].net)}. 4시간 이상 보유한 ${holdBuckets[2].n + holdBuckets[3].n}건은 ${money(holdBuckets[2].net + holdBuckets[3].net)} 이익.</li>
<li><b>진입 타이밍·방향</b> — 무작위 시각·반대 방향보다 나쁜 진입. 역추세 진입이 가장 큰 손실.</li>
</ol>
</div>

<div class="tiles">
<div class="tile"><div class="k">순손익</div><div class="v neg">${money(net)}</div><div class="s">${T.length.toLocaleString()}건 · 승률 ${rv.totals.winRate}%</div></div>
<div class="tile"><div class="k">수수료</div><div class="v neg">${money(-fee)}</div><div class="s">손실의 ${((fee / -net) * 100).toFixed(0)}% · 펀딩 ${money(funding)}</div></div>
<div class="tile"><div class="k">강제청산</div><div class="v neg">${money(liqLoss)}</div><div class="s">${liqTrades.length}회 · 손실의 ${((liqLoss / net) * 100).toFixed(0)}%</div></div>
<div class="tile"><div class="k">명목 레버 50배 이상</div><div class="v">${((lev50plus / T.filter((x) => x.lever).length) * 100).toFixed(0)}%</div><div class="s">레버 기록 ${T.filter((x) => x.lever).length}건 중 ${lev50plus}건</div></div>
</div>

<h2>무엇을 고정하고 무엇을 바꿨나</h2>
<p>진입(종목·방향·시각·체결가·증거금)은 기록 그대로다. 증거금은 OKX의 손익률 필드에서 역산했고(${cf.withMargin.toLocaleString()}건, 검증 오차 3% 이내 전부 통과), 2024년 9월 이전 원장 재구성분 ${(cf.trades - cf.withMargin).toLocaleString()}건은 명목 금액만 복원된다. 경로는 거래별 1분~4시간 청크 캔들(보유 구간)과 BTC·DOGE 로컬 15분·1시간봉, 나머지 종목은 이번에 OKX에서 받은 15분봉을 썼다. 진입 봉과 청산 봉은 봉 전체 고저를 쓰므로 손절 체결이 실제보다 <em>많이</em> 잡히는 보수적 편향이 있다.</p>
<dl>
<dt>실험 1 · 오버레이</dt><dd>실제 청산 시각까지 보유. 그 전에 강제청산(L′) 또는 손절 S가 닿으면 거기서 청산. 레버리지 6단 × 손절 11종.</dd>
<dt>실험 2 · 기계적 청산</dt><dd>진입만 남기고 손절 S / 목표 k×S / 시한 H 중 먼저 오는 것으로 청산. 손절 5종 × 목표 4종 × 시한 4종 = 80조합. 대조군 둘: 같은 거래를 24시간 뒤에 진입, 방향 반전.</dd>
<dt>사이징 프레임</dt><dd>동일 명목(포지션 크기 유지, 레버리지는 청산에만 작용) · 동일 리스크(거래당 $100 위험, 손절이 넓을수록 포지션 축소) · 동일 증거금(참고용 — 작게 하면 덜 잃는 선형 효과라 판정에 안 씀).</dd>
<dt>비용</dt><dd>수수료는 실거래 요율을 명목 비례로. 실험 2의 보유 연장분은 8시간당 명목 0.01%를 펀딩 비용으로 항상 가산.</dd>
</dl>

<h2>실험 1 — 실제 청산 시각을 유지하고 레버리지·손절만 얹으면</h2>
<p>동일 명목 프레임의 순손익. 왼쪽 위(실제 레버·손절 없음)가 실제 재현이고, 색이 진할수록 실제보다 많이 나빠진 칸이다. 어느 칸도 실제 ${money(base.actual)}보다 낫지 않다.</p>
<div class="tblwrap">${e1Table()}</div>
<p class="note">셀 아래 작은 글씨는 합성 강제청산·손절 체결 건수. 실제 레버 행은 합성 청산을 걸지 않는다 — 명목 100배 포지션이 증거금 대비 300% 이상 역행을 견디고 살아남은 사례가 많아(보유 중 증거금 추가 투입) 명목 레버로는 실제 청산을 재현할 수 없었다. L′ 행은 "증거금 추가 없음" 가정의 순수 모델이라, 사용자가 실제로 한 '추가 투입으로 버티기'보다 청산이 잦다.</p>

<h3>손절이 누구를 죽였나</h3>
<p>손절 폭별로, 실제로는 이익으로 끝났는데 손절에 걸려 죽은 거래와 손실을 미리 자른 거래의 수. 미리 잘라도 손절 폭만큼은 잃으므로, 실제 손실이 그보다 작았던 거래가 많으면 순효과는 음수다.</p>
<div class="tblwrap">${stopDiagTable()}</div>
<p class="note">읽는 법: 실제 매매는 깊은 역행(MAE)을 견딘 뒤 작은 손실이나 이익으로 마감한 거래가 많다. 고정 손절은 그 역행을 손실로 확정한다. 8% 손절이 가장 덜 나쁜 이유는 거의 안 걸리기 때문이지, 8%가 좋아서가 아니다.</p>

<h2>실험 2 — 진입만 남기고 기계적으로 청산하면</h2>
<p>손절·목표·시한만으로 청산하는 규칙에 사용자 진입을 넣은 결과와, 같은 시장에서 하루 뒤에 진입한 대조군·방향을 뒤집은 대조군의 거래당 수익률. ${hasAll ? `전 종목 ${X.n.toLocaleString()}건(2단계 실데이터 수집 후)` : `BTC·DOGE ${X.n.toLocaleString()}건`}, 동일 리스크 프레임.</p>
<figure>${exp2Chart()}<figcaption>손절 폭별 거래당 명목 대비 순수익률(목표 4종 × 시한 4종 = 16조합 평균). 0선 아래는 손실. 수수료·펀딩 포함.</figcaption></figure>
<p>사용자 진입이 ${exp2Rows.length}개 조합 중 양수인 것은 ${anyPositive}개. 하루 뒤 진입 대조군을 이긴 조합 ${userBeatsShift}개, 방향 반전을 이긴 조합 ${userBeatsMirror}개. 가장 좋은 사용자 조합(손절 ${bestUser.s} · 목표 ${bestUser.k}×S · 시한 ${bestUser.h})도 거래당 ${pct(bestUser.user)}다.</p>

<h3>달러 합계는 왜 플러스로 보였나</h3>
<p>동일 명목 프레임에서는 순손익이 크게 플러스인 조합이 있다. 그러나 손익 절대값 상위 3% 거래를 빼면 전부 실제보다 나쁘고, 이익은 2026년의 큰 포지션 몇 건에 몰려 있다. 사전 등록한 게이트(동일 명목 달러 · 연도 2/3 유지)는 형식상 통과했지만, 사후 진단이 그 통과를 '큰 포지션의 운'으로 판정한다. 동일 리스크 프레임에서는 통과 조합이 ${riskPasses}개다.</p>
<div class="tblwrap">${exp2Table()}</div>

<h3>진입 의도별</h3>
<div class="tblwrap">${groupTable()}</div>
<p class="note">동일 명목 기준(포지션 크기에 가중). 기계적 청산은 역추세 진입의 손실을 크게 줄이고(오래 버틴 손실을 미리 자름 — 손절 5종·목표·시한을 바꿔도 방향은 같다), 돌파 추격 진입은 크게 악화시킨다(되돌림에 손절이 먼저 닿는다 — 사용자의 재량 청산이 훨씬 나았다). 같은 청산 규칙이 진입 유형에 따라 정반대로 작동한다는 것은, 문제가 손절 규칙이 아니라 <em>어떤 진입을 하느냐</em>에 있다는 뜻이다.</p>

<h2>손실은 어디서 났나</h2>
<figure>${holdChart()}<figcaption>보유 시간별 순손익(수수료 포함). 4시간 미만 보유 ${(holdBuckets[0].n + holdBuckets[1].n).toLocaleString()}건이 손실 전부를 만들고, 4시간 이상 ${holdBuckets[2].n + holdBuckets[3].n}건은 승률 ${((holdBuckets[2].winRate * holdBuckets[2].n + holdBuckets[3].winRate * holdBuckets[3].n) / (holdBuckets[2].n + holdBuckets[3].n)).toFixed(0)}%로 이익.</figcaption></figure>
<div class="tiles">
<div class="tile"><div class="k">하루 6건 이상 거래한 날</div><div class="v">${heavyDays.size}일</div><div class="s">${heavy.length.toLocaleString()}건 · ${money(sum(heavy, (x) => x.pnlUsd))} (손실의 ${((sum(heavy, (x) => x.pnlUsd) / net) * 100).toFixed(0)}%)</div></div>
<div class="tile"><div class="k">하루 5건 이하 거래한 날</div><div class="v">${Object.keys(days).length - heavyDays.size}일</div><div class="s">${light.length.toLocaleString()}건 · ${money(sum(light, (x) => x.pnlUsd))}</div></div>
<div class="tile"><div class="k">최악 5% 손실 거래</div><div class="v neg">${worst5Share.toFixed(0)}%</div><div class="s">${worst5.length}건이 총손실 ${money(lossTotal)}의 이 비중</div></div>
<div class="tile"><div class="k">평균 이익 / 평균 손실</div><div class="v">${(avgWin / -avgLoss).toFixed(2)}</div><div class="s">${money(avgWin)} / ${money(avgLoss)} · 승률 ${rv.totals.winRate}%면 기대값 ${money(avgWin * (rv.totals.winRate / 100) + avgLoss * (1 - rv.totals.winRate / 100))}</div></div>
</div>
<p class="note">증거금 추가 투입으로 청산을 넘긴 것으로 보이는 ${topUp.length}건은 ${money(topUpNet)}로 끝났다. '버티기'가 살아남으면 이익이었고, 못 버틴 ${liqTrades.length}건이 ${money(liqLoss)}다. 레버리지를 낮추면 후자는 줄지만 전자도 준다 — 그래서 실험 1에서 레버리지만 낮춘 행이 실제보다 좋아지지 않는다.</p>

<h2>개선점 후보 — 근거 순</h2>
<ul class="findings">
<li><b>거래 수를 줄인다. 손실의 ${((fee / -net) * 100).toFixed(0)}%가 수수료다.</b><span class="ev">하루 6건 이상 거래한 ${heavyDays.size}일이 손실의 ${((sum(heavy, (x) => x.pnlUsd) / net) * 100).toFixed(0)}%. 30분 미만 보유 ${holdBuckets[0].n.toLocaleString()}건은 승률 ${holdBuckets[0].winRate.toFixed(0)}%, ${money(holdBuckets[0].net)}. 하루 거래 상한(예: 3건)만으로 시뮬레이션 없이도 손실의 대부분이 사라진다는 뜻은 아니지만, 수수료 ${money(-fee)}는 확실히 준다.</span></li>
<li><b>4시간 이상 갈 자리에서만 들어간다.</b><span class="ev">4시간 이상 보유 ${holdBuckets[2].n + holdBuckets[3].n}건은 ${money(holdBuckets[2].net + holdBuckets[3].net)}, 승률 ${holdBuckets[2].winRate.toFixed(0)}%대. "손절을 러프하게"의 실체는 가격 폭이 아니라 <em>시간</em>이다 — 넓은 손절이 필요한 자리는 오래 보유할 자리이고, 그런 자리는 실제로 수익이 났다.</span></li>
<li><b>역추세 진입(급락 매수·급등 숏)은 끊거나, 하려면 시한과 손절을 미리 정한다.</b><span class="ev">진입 의도별 실제 손실 1위(${money(grp["역추세"]?.actual)}, ${grp["역추세"]?.n}건). 이 유형만은 기계적 청산(손절 2% · 목표 2×S · 시한 72h)이 ${money(grp["역추세"]?.net)}로 손실을 거의 없앤다 — 역추세는 진입이 아니라 '버티는 시간'이 문제였다. 반대로 돌파 추격은 기계적 손절이 ${money(grp["추격"]?.net)}로 망가뜨리므로, 규칙은 유형별로 달라야 한다.</span></li>
<li><b>레버리지는 꼬리만 자른다. 기대값은 안 바뀐다.</b><span class="ev">강제청산 ${liqTrades.length}회 ${money(liqLoss)}(손실의 ${((liqLoss / net) * 100).toFixed(0)}%). 20배 이하면 이 꼬리는 거의 사라지지만, 거래당 수익률은 ${pct(base.actualRetPct)} 그대로다. 명목 100배에 증거금을 추가 투입해 버티는 방식은 '손절 없는 5배'와 같다 — 레버리지를 낮추려면 증거금 추가 투입도 같이 끊어야 의미가 있다.</span></li>
<li><b>고정 손절은 지금 방식에 얹지 않는다.</b><span class="ev">실험 1에서 어떤 손절도 실제보다 나빴다(0.25%: ${money(e1["L=actual|S=0.25%"].net - base.actual)}, 8%: ${money(e1["L=actual|S=8%"].net - base.actual)}). 손절 규칙은 진입·보유 시간을 먼저 바꾼 뒤에 다시 검증한다.</span></li>
</ul>

<h2>한계와 가정</h2>
<p>① 진입 봉·청산 봉의 장중 순서를 모른다 — 봉 전체 고저로 판정해 손절 체결이 과대(보수). ② 명목 레버리지로 실제 청산을 재현할 수 없어 실제 행에는 합성 청산을 걸지 않았다. 증거금 추가 투입 이력은 원장에서 아직 복원하지 않았다. ③ 실험 2의 펀딩은 실측이 아닌 고정 요율. ④ 마지막 7일 안의 거래는 시한 경로가 잘린다(${X.truncated}건). ⑤ 2024-09 이전 원장 재구성 ${(cf.trades - cf.withMargin).toLocaleString()}건은 레버·증거금 미상. ⑥ 80조합 × 3프레임의 격자에서 최고값을 고르면 과적합이다 — 그래서 최고 조합이 아니라 조합 전체의 부호와 대조군 비교로 판정했다.</p>

<h2>게이트 판정 기록</h2>
<p>사전 등록: 동일 명목 또는 동일 리스크 프레임에서 L′ ≤ 20 · S ≥ 1%(또는 2×ATR) 조합이 같은 거래의 실제보다 낫고 2024·2025·2026 중 두 해 이상 유지되면 2단계(실데이터 수집) 진행. 1단계 결과: 실험 1 통과 0개, 실험 2 동일 명목 통과 ${cf.gate.count - riskPasses}개 · 동일 리스크 통과 ${riskPasses}개 → 형식상 통과, 2단계 실행(15분봉 청크 수집 후 전 종목 ${X.n.toLocaleString()}건). 2단계 판정(전 종목): ${gate.pass ? `통과 조합 ${gate.count}개(동일 명목 ${gate.count - (gate.top ?? []).filter((g) => g.frame === "risk").length}개 · 동일 리스크 ${(gate.top ?? []).filter((g) => g.frame === "risk").length}개)` : "미통과"}${gate.pass && gate.top?.[0] ? ` — ${gate.top[0].key.replace("S=", "손절 ").replace("|k=", " · 목표 ").replace("|H=", "×S · 시한 ")} 순손익 ${money(gate.top[0].net)} vs 실제 ${money(gate.top[0].actual)}, 거래당 ${pct(gate.top[0].retPct)} vs 실제 ${pct(gate.top[0].actualRetPct)}` : ""}. 사후 진단(상위 3% 제외)에서 통과 조합 전부 실제보다 나쁨. BTC·DOGE만 볼 때의 명목 통과 45개는 알트 ${(X.n - cf.exp2Local.n).toLocaleString()}건이 합류하자 사라졌다 — 2026년 BTC 큰 포지션 몇 건의 결과였다.</p>

<p class="meta">re_sys/counterfactual.mjs · counterfactual-report.mjs · data/counterfactual.json · 생성 ${new Date(cf.generatedAt + KST).toISOString().replace("T", " ").slice(0, 16)} KST · spike 규칙대로 미커밋</p>
</div>`;

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, "counterfactual-report.html");
writeFileSync(outPath, html, "utf8");
console.log(`저장 → ${outPath}`);
