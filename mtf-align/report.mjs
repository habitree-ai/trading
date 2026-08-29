/**
 * MTF 정렬 HTML 리포트 — mtf-align/out/mtf-align.json → report.html
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUTDIR = join(dirname(fileURLToPath(import.meta.url)), "out");
const JSON_PATH = join(OUTDIR, "mtf-align.json");
const HTML_PATH = join(OUTDIR, "mtf-align-report.html");

const TF_LABEL = { "1m": "1분", "15m": "15분", "1H": "1시간", "4H": "4시간" };
const METRIC_LABEL = {
  rsi: "RSI", bbPb: "%b", bbWPct: "밴드폭 %ile", atrPctile: "ATR %ile",
  distE200: "EMA200 이격%", volR: "거래량비", dcPos: "채널위치%", body: "몸통%",
};

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function profileTable(profiles, dirKey) {
  const p = profiles[dirKey];
  if (!p) return "";
  const tfs = Object.keys(p);
  const metrics = Object.keys(METRIC_LABEL);
  let html = `<table><thead><tr><th>지표</th>${tfs.map((t) => `<th>${TF_LABEL[t] ?? t}</th>`).join("")}</tr></thead><tbody>`;
  for (const m of metrics) {
    html += `<tr><td>${METRIC_LABEL[m]}</td>`;
    for (const tf of tfs) {
      const v = p[tf][m];
      html += `<td>${v ? `μ${v.mean} · P50 ${v.p50}` : "—"}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  return html;
}

function condTable(rows) {
  return `<table><thead><tr><th>그룹</th><th>조건</th><th>비율</th><th>건수</th></tr></thead><tbody>${
    rows.slice(0, 12).map((r) =>
      `<tr><td>${esc(r.group)}</td><td>${esc(r.name)}</td><td>${r.pct}%</td><td>${r.count}</td></tr>`,
    ).join("")
  }</tbody></table>`;
}

function sampleCards(samples, dir) {
  const label = dir === "bull" ? "상승" : "하락";
  const color = dir === "bull" ? "#22c55e" : "#ef4444";
  return samples.slice(0, 8).map((s) => `
    <div class="card">
      <div class="card-head" style="border-color:${color}">${s.kst} · ${label} · $${s.price.toLocaleString()}</div>
      <div class="grid4">
        ${["1m", "15m", "1H", "4H"].map((tf) => {
          const t = s.tf[tf];
          if (!t) return `<div><b>${TF_LABEL[tf]}</b><br>—</div>`;
          return `<div><b>${TF_LABEL[tf]}</b><br>
            RSI ${t.rsi} · %b ${t.bbPb}<br>
            ATR%ile ${t.atrPctile} · Vol ${t.volR}x<br>
            E200 ${t.distE200}% · DC ${t.dcPos}%
          </div>`;
        }).join("")}
      </div>
      <div class="fwd">전방: 15m ${s.forward["15m"]}% · 1H ${s.forward["1H"]}% · 4H ${s.forward["4H"]}% · 8H ${s.forward["8H"]}%</div>
    </div>`).join("");
}

function main() {
  if (!existsSync(JSON_PATH)) {
    console.error("mtf-align.json 없음 — analyze.mjs 먼저 실행");
    process.exit(1);
  }
  const d = JSON.parse(readFileSync(JSON_PATH, "utf8"));
  const s = d.summary;

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>MTF 4봉 정렬 — TA 시작점</title>
<style>
  :root { --bg:#0f1117; --surface:#1a1d27; --text:#e2e8f0; --dim:#94a3b8; --accent:#60a5fa; --border:#2d3348; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 1.5rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 .75rem; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: .35rem; }
  .meta { color: var(--dim); font-size: .85rem; margin-bottom: 1.5rem; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: .75rem; margin: 1rem 0; }
  .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: .75rem; }
  .kpi b { display: block; font-size: 1.25rem; }
  .kpi span { font-size: .75rem; color: var(--dim); }
  table { width: 100%; border-collapse: collapse; font-size: .8rem; margin: .5rem 0 1rem; }
  th, td { border: 1px solid var(--border); padding: .4rem .5rem; text-align: left; }
  th { background: var(--surface); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin: .75rem 0; overflow: hidden; }
  .card-head { padding: .5rem .75rem; font-size: .85rem; font-weight: 600; border-left: 3px solid; background: #12141c; }
  .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: .5rem; padding: .75rem; font-size: .75rem; }
  .fwd { padding: 0 .75rem .75rem; font-size: .75rem; color: var(--dim); }
  .note { background: #1e293b; border-left: 3px solid #f59e0b; padding: .75rem 1rem; font-size: .85rem; margin: 1rem 0; border-radius: 0 6px 6px 0; }
  @media (max-width: 700px) { .grid4 { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<h1>MTF 4봉 동방향 정렬 — TA 시작점</h1>
<p class="meta">${esc(d.inst)} · ${esc(d.period.from)} → ${esc(d.period.to)} (${d.period.days}일) · 생성 ${esc(d.generatedAt.slice(0, 16))}</p>

<div class="note">${esc(d.definition.alignment)}</div>

<h2>요약</h2>
<div class="kpis">
  <div class="kpi"><b>${s.alignedPct}%</b><span>1m 봉 중 4-way 정렬</span></div>
  <div class="kpi"><b>${s.startEvents.toLocaleString()}</b><span>정렬 시작 이벤트 (${s.startsPerYear}/년)</span></div>
  <div class="kpi"><b>${s.bullStarts.toLocaleString()}</b><span>상승 시작 (${s.bullStartsPerYear}/년)</span></div>
  <div class="kpi"><b>${s.bearStarts.toLocaleString()}</b><span>하락 시작 (${s.bearStartsPerYear}/년)</span></div>
  <div class="kpi"><b>${s.medDurationMin.up}분</b><span>상승 정렬 중앙 지속</span></div>
  <div class="kpi"><b>${s.medDurationMin.dn}분</b><span>하락 정렬 중앙 지속</span></div>
  <div class="kpi"><b>${s.impulseOverlapPct}%</b><span>1% 임펄스와 겹침</span></div>
</div>

<h2>정렬 시작 후 전방 수익 (방향 기준)</h2>
<table>
<thead><tr><th>구간</th><th>상승 μ / P50 / 승률</th><th>하락 μ / P50 / 승률</th></tr></thead>
<tbody>
${["15m", "1H", "4H", "8H"].map((h) => {
  const u = d.forward.up[h], dn = d.forward.dn[h];
  return `<tr><td>${h}</td><td>${u.mean}% / ${u.p50}% / ${u.winPct}%</td><td>${dn.mean}% / ${dn.p50}% / ${dn.winPct}%</td></tr>`;
}).join("")}
</tbody></table>

<h2>TA 프로파일 — 상승 정렬 시작</h2>
${profileTable(d.profiles, "up")}

<h2>TA 프로파일 — 하락 정렬 시작</h2>
${profileTable(d.profiles, "dn")}

<h2>1m 조건 빈도 (상승 시작)</h2>
${condTable(d.conditions.bull)}

<h2>1m 조건 빈도 (하락 시작)</h2>
${condTable(d.conditions.bear)}

<h2>샘플 — 상승 정렬 시작</h2>
${sampleCards(d.samples.bull, "bull")}

<h2>샘플 — 하락 정렬 시작</h2>
${sampleCards(d.samples.bear, "bear")}

<h2>백테스트 맥락</h2>
<ul style="font-size:.85rem;color:var(--dim)">
<li>${esc(d.backtestContext.onewayConclusion)}</li>
<li>${esc(d.backtestContext.basisRound)}</li>
<li>${esc(d.backtestContext.labFrontier)}</li>
</ul>
</body></html>`;

  writeFileSync(HTML_PATH, html);
  console.log(`→ ${HTML_PATH}`);
}

main();
