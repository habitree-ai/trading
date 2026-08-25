/**
 * P0 — 복기 시스템 인덱스 페이지.
 *
 * out/index.html 하나에서 두 리포트(쿼드·매매)와 데이터 재고(무엇이 언제까지
 * 얼마나 쌓였는지)를 한눈에 본다. 데이터 파일을 읽어 현황을 재생성한다 —
 * 손으로 고치는 문서가 아니다.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, OUT_DIR, loadData, saveOut } from "./lib/data.mjs";

const fmtD = (ts) => new Date(ts).toISOString().slice(0, 10);
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");

const rows = [];
for (const name of readdirSync(DATA_DIR).sort()) {
  if (!name.endsWith(".json")) continue;
  const size = statSync(join(DATA_DIR, name)).size;
  const obj = loadData(name);
  let desc = "-";
  let range = "-";
  let count = "-";
  if (obj?.candles?.length) {
    count = obj.candles.length.toLocaleString() + "봉";
    range = `${fmtD(obj.candles[0].t)} → ${fmtD(obj.candles[obj.candles.length - 1].t)}`;
    desc = `캔들 (${obj.bar})`;
  } else if (obj?.funding?.length) {
    count = obj.funding.length.toLocaleString() + "건";
    range = `${fmtD(obj.funding[0].t)} → ${fmtD(obj.funding[obj.funding.length - 1].t)}`;
    desc = "펀딩비 실측 누적";
  } else if (obj?.fills) {
    count = obj.fills.length + "건";
    range = obj.fills.length ? `${fmtD(Number(obj.fills[0].ts))} → ${fmtD(Number(obj.fills[obj.fills.length - 1].ts))}` : "-";
    desc = "체결 원장 누적";
  } else if (obj?.bills) {
    count = obj.bills.length + "건";
    desc = "펀딩 청구서 누적";
  } else if (name === "manual-trades.json") {
    count = obj.trades.length + "건";
    range = `${fmtD(obj.trades[0].entryTs)} → ${fmtD(obj.trades[obj.trades.length - 1].entryTs)}`;
    desc = "본인 매매 통합 이력";
  } else if (name === "manual-candles.json") {
    count = Object.keys(obj.windows).length + "창";
    desc = "트레이드별 캔들 창(구형 — 청크로 대체)";
  } else if (name === "manual-chunks.json") {
    count = Object.keys(obj.chunks).length.toLocaleString() + "청크";
    desc = "캔들 청크 캐시(100봉 정렬)";
  } else if (name === "manual-review.json") {
    count = obj.trades.length + "건";
    desc = "매매 복기 분석 정본";
  } else if (name === "replay.json") {
    count = `신호 ${Object.values(obj.members).reduce((s, m) => s + m.signals.length, 0)}`;
    desc = "쿼드 복기 정본";
  }
  rows.push({ name, desc, count, range, size });
}

const archives = readdirSync(join(OUT_DIR, "archive")).sort().reverse();
const quadMeta = loadData("replay.json");
const manualMeta = loadData("manual-review.json");

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>re_sys 복기 인덱스</title>
<style>
  :root { color-scheme: dark; --bg:#0e1116; --surface:#161a21; --border:#2a3039; --ink:#e6e9ee; --dim:#8b95a3; --s1:#3987e5; }
  @media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { color-scheme: light; --bg:#f7f8fa; --surface:#fff; --border:#e2e5ea; --ink:#14171c; --dim:#666e7a; --s1:#2a78d6; } }
  :root[data-theme="light"] { color-scheme: light; --bg:#f7f8fa; --surface:#fff; --border:#e2e5ea; --ink:#14171c; --dim:#666e7a; --s1:#2a78d6; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.7 -apple-system,"Segoe UI","Malgun Gothic",system-ui,sans-serif; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 40px 22px 80px; }
  h1 { font-size: 26px; margin: 0 0 6px; } h2 { font-size: 18px; margin: 36px 0 6px; }
  a { color: var(--s1); }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:16px 20px; margin:14px 0; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th,td { padding:6px 9px; text-align:left; border-bottom:1px solid var(--border); font-variant-numeric:tabular-nums; }
  th { color:var(--dim); font-weight:600; font-size:12.5px; }
  td.r, th.r { text-align:right; }
  .note { color:var(--dim); font-size:13px; }
</style>
</head>
<body><div class="wrap">
<h1>re_sys — 복기 인덱스</h1>
<p class="note">갱신 ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · 데이터는 전부 로컬 누적(재수집 가능)</p>

<div class="card">
  <h2 style="margin-top:0">리포트</h2>
  <table>
    <tr><td><a href="report.html"><b>쿼드 복기</b></a></td>
      <td class="note">시스템 전략 전 기간 재현 — 신호 ${quadMeta ? Object.values(quadMeta.members).reduce((s, m) => s + m.signals.length, 0) : "?"}건 · 생성 ${quadMeta ? fmtD(quadMeta.generatedAt) : "-"}</td></tr>
    <tr><td><a href="manual-report.html"><b>매매 복기</b></a></td>
      <td class="note">본인 매매 실패 분석 — ${manualMeta ? manualMeta.totals.trades : "?"}건 · 승률 ${manualMeta ? manualMeta.totals.winRate : "?"}% · 생성 ${manualMeta ? fmtD(manualMeta.generatedAt) : "-"}</td></tr>
  </table>
  <p class="note">아카이브: ${archives.map((a) => `<a href="archive/${a}">${a.replace(".html", "")}</a>`).join(" · ") || "없음"}</p>
</div>

<div class="card">
  <h2 style="margin-top:0">데이터 재고 (re_sys/data/)</h2>
  <table>
    <thead><tr><th>파일</th><th>내용</th><th class="r">규모</th><th>범위</th><th class="r">크기</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${r.name}</td><td>${r.desc}</td><td class="r">${r.count}</td><td>${r.range}</td><td class="r">${fmtSize(r.size)}</td></tr>`).join("")}</tbody>
  </table>
  <p class="note">CSV 동명 파일이 외부 분석용 로우데이터. 실행 순서는 re_sys/README.md 참조.</p>
</div>
</div></body></html>`;

saveOut("index.html", html);
console.log(`생성 완료 → re_sys/out/index.html (데이터 ${rows.length}종)`);
