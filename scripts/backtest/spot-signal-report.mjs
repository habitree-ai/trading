/**
 * SPOT-SIGNAL 회차 P3 — 게이트 리포트 생성 (REQ-0023 Phase A).
 *
 * spot-signal-results.json 을 읽어 채택/기각 판정과 근거 표를 담은 정적 HTML 을 만든다.
 * 판정 기준은 P2(spot-signal.mjs) 헤더에 사전 등록된 것을 그대로 표시만 한다 —
 * 이 파일은 계산하지 않는다(숫자를 만들면 정본이 두 개가 된다).
 *
 * 사용: node scripts/backtest/spot-signal-report.mjs
 * 출력: docs/backtest/spot-signal-report.html
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const results = JSON.parse(readFileSync(join(root, "scripts", "backtest", ".cache", "spot", "spot-signal-results.json"), "utf8"));

const SIG_LABEL = { pullback: "추세 눌림목", gc: "골든크로스", breakout: "신고가 돌파", squeeze: "압축 후 돌파" };
const EXIT_LABEL = { hold24: "24봉 보유", hold72: "72봉 보유", hold168: "168봉 보유", atr: "ATR 손절/목표" };
const fmt = (v, suffix = "") => (v === null || v === undefined ? "—" : `${v}${suffix}`);

function statRow(label, s) {
  if (!s) return `<tr><td>${label}</td><td colspan="7" class="dim">표본 없음</td></tr>`;
  const cls = s.avg > 0 ? "pos" : "neg";
  return `<tr><td>${label}</td><td>${s.n.toLocaleString()}</td><td class="${cls}">${fmt(s.avg, "%")}</td><td>${fmt(s.median, "%")}</td><td>${fmt(s.winRate, "%")}</td><td>${fmt(s.pf)}</td><td>${fmt(s.worst, "%")}</td><td>${fmt(s.best, "%")}</td></tr>`;
}

function exitTable(sig) {
  const rows = [];
  for (const [ek, byPeriod] of Object.entries(results.summary[sig].exits)) {
    rows.push(`<tr class="sep"><td colspan="8">${EXIT_LABEL[ek] ?? ek}</td></tr>`);
    rows.push(statRow("전체", byPeriod.all));
    rows.push(statRow("학습 23~24", byPeriod.train));
    rows.push(statRow("검증 25~", byPeriod.valid));
  }
  return rows.join("\n");
}

function tierTable(sig) {
  const rows = [];
  for (const [tier, byExit] of Object.entries(results.summary[sig].tiers)) {
    rows.push(`<tr class="sep"><td colspan="8">${tier}</td></tr>`);
    for (const [ek, s] of Object.entries(byExit)) rows.push(statRow(EXIT_LABEL[ek] ?? ek, s));
  }
  return rows.join("\n");
}

const sigSections = Object.keys(results.summary)
  .map((sig) => {
    const v = results.verdict[sig];
    const badge = v.adopted
      ? `<span class="badge ok">채택 후보 — ${v.passingExits.map((e) => EXIT_LABEL[e] ?? e).join(", ")}</span>`
      : `<span class="badge no">기각</span>`;
    return `
<section>
  <h2>${SIG_LABEL[sig] ?? sig} <code>${sig}</code> ${badge}</h2>
  <p class="dim">발화 ${results.summary[sig].total.toLocaleString()}건 (쿨다운 24봉 적용 후)</p>
  <h3>청산 방식 × 구간 (수익률은 왕복 비용 차감 후)</h3>
  <table>
    <thead><tr><th>구간</th><th>표본</th><th>평균</th><th>중앙값</th><th>승률</th><th>PF</th><th>최악</th><th>최고</th></tr></thead>
    <tbody>${exitTable(sig)}</tbody>
  </table>
  <h3>유동성 계층별 (전 구간)</h3>
  <table>
    <thead><tr><th>청산</th><th>표본</th><th>평균</th><th>중앙값</th><th>승률</th><th>PF</th><th>최악</th><th>최고</th></tr></thead>
    <tbody>${tierTable(sig)}</tbody>
  </table>
</section>`;
  })
  .join("\n");

const c = results.criteria;
const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>현물신호 백테스트 — 채택 게이트 (REQ-0023 Phase A)</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: 'Segoe UI', 'Malgun Gothic', sans-serif; max-width: 1080px; margin: 2rem auto; padding: 0 1rem; line-height: 1.55; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.15rem; margin-top: 2.5rem; } h3 { font-size: 0.95rem; margin: 1.2rem 0 0.4rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; font-variant-numeric: tabular-nums; }
  th, td { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); padding: 0.3rem 0.55rem; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  tr.sep td { background: color-mix(in srgb, currentColor 8%, transparent); font-weight: 600; text-align: left; }
  .pos { color: #0a7d33; font-weight: 600; } .neg { color: #c0392b; font-weight: 600; }
  .dim { opacity: 0.65; }
  .badge { font-size: 0.75rem; padding: 0.15rem 0.5rem; border-radius: 0.6rem; vertical-align: middle; }
  .badge.ok { background: #0a7d33; color: #fff; } .badge.no { background: #c0392b; color: #fff; }
  code { opacity: 0.6; font-size: 0.8em; }
  .criteria { background: color-mix(in srgb, currentColor 6%, transparent); padding: 0.8rem 1rem; border-radius: 0.5rem; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>현물신호 백테스트 — 채택 게이트</h1>
<p class="dim">생성 ${results.generatedAt} · 분석 ${results.universe.analyzed}종 (제외 ${results.universe.skipped}종) · 신호 ${results.totalSignals.toLocaleString()}건 · REQ-0023 Phase A</p>
<div class="criteria">
  <strong>사전 등록 판정 기준</strong> — 평가 ${new Date(c.evalFrom).toISOString().slice(0, 10)}~ ·
  OOS 분할 ${new Date(c.oosSplit).toISOString().slice(0, 10)} · 수수료 왕복 ${(c.feeRt * 100).toFixed(2)}% ·
  슬리피지 ${c.slip.map((s) => `${s.tier} ${(s.rt * 100).toFixed(1)}%`).join(" / ")} ·
  쿨다운 ${c.cooldown}봉 · 진입 = 신호 다음 1H 봉 시가 ·
  채택 = <code>${c.adopt}</code>
</div>
${sigSections}
</body>
</html>
`;

const outDir = join(root, "docs", "backtest");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "spot-signal-report.html");
writeFileSync(outPath, html);
console.log(`✓ ${outPath}`);
