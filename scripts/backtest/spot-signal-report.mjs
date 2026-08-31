/**
 * SPOT-SIGNAL 회차 P3 — 게이트 리포트 생성 (REQ-0023 Phase A·A2).
 *
 * 1차(spot-signal-results.json)·2차(spot-signal2-results.json) 결과를 읽어
 * 판정 근거 표와 채택 신호(crash)의 종목별·건별 상세 내역을 담은 정적 HTML 을 만든다.
 * 이 파일은 계산하지 않는다 — 숫자를 만들면 정본이 두 개가 된다.
 *
 * 사용: node scripts/backtest/spot-signal-report.mjs
 * 출력: docs/backtest/spot-signal-report.html  (/lab 자료실 bt-spot-signal)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cache = (name) => join(root, "scripts", "backtest", ".cache", "spot", name);
const results = JSON.parse(readFileSync(cache("spot-signal-results.json"), "utf8"));
const r2 = existsSync(cache("spot-signal2-results.json"))
  ? JSON.parse(readFileSync(cache("spot-signal2-results.json"), "utf8"))
  : null;

const SIG_LABEL = { pullback: "추세 눌림목", gc: "골든크로스", breakout: "신고가 돌파", squeeze: "압축 후 돌파" };
const SIG2_LABEL = { mr1d: "과매도 반전(1D)", crash: "급락 반전", rs: "상대강도 리더", volx: "거래대금 급증" };
const EXIT_LABEL = { hold24: "24봉 보유", hold72: "72봉 보유", hold168: "168봉 보유", atr: "ATR 손절/목표" };
const fmt = (v, suffix = "") => (v === null || v === undefined ? "—" : `${v}${suffix}`);
const pctCls = (v) => (v === null || v === undefined ? "" : v > 0 ? "pos" : "neg");
const pct = (v, d = 2) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(d)}%`);
/** KST 표기 — 신호는 한국 시장의 사건이라 화면과 같은 시간대로 읽혀야 한다. */
const kst = (t) => new Date(t + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
const priceFmt = (v) => (v < 10 ? v.toFixed(3) : Math.round(v).toLocaleString());

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
      ? `<span class="badge ok">채택 후보</span>`
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

/* ── 2차 회차 + 채택 신호(crash) 상세 ─────────────────────────────────────── */

let round2Html = "";
if (r2) {
  const summaryRows = Object.keys(r2.summary)
    .map((sig) => {
      const e = r2.summary[sig].exits.hold24;
      const v = r2.verdict[sig];
      const cell = (s) =>
        s ? `<td class="${pctCls(s.avg)}">${fmt(s.avg, "%")}</td>` : `<td class="dim">—</td>`;
      return `<tr>
        <td class="l">${SIG2_LABEL[sig] ?? sig} <span class="mono">${sig}</span></td>
        <td>${r2.summary[sig].total.toLocaleString()}</td>
        ${cell(e.all)}<td>${e.all ? `${e.all.winRate}%` : "—"}</td>${cell(e.y2025)}${cell(e.y2026)}
        <td>${v.adopted ? `<span class="badge ok">통과</span>` : `<span class="badge no">기각</span>`}</td>
      </tr>`;
    })
    .join("\n");

  const crash = r2.trades.filter((t) => t.sig === "crash");
  const isT1 = (t) => t.tier.startsWith("T1");

  // 종목별 집계 — 어떤 종목에서 이 신호가 났고 결과가 어땠는지 한눈에.
  const byMarket = new Map();
  for (const t of crash) {
    const key = t.market;
    if (!byMarket.has(key)) byMarket.set(key, []);
    byMarket.get(key).push(t);
  }
  const marketRows = [...byMarket.entries()]
    .map(([market, list]) => {
      const rets = list.map((t) => t.exits.hold24).filter((x) => x !== undefined);
      const avg = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null;
      const win = rets.length ? (rets.filter((r) => r > 0).length / rets.length) * 100 : null;
      const best = rets.length ? Math.max(...rets) : null;
      const worst = rets.length ? Math.min(...rets) : null;
      const last = Math.max(...list.map((t) => t.t));
      return { market, n: list.length, t1: list.filter(isT1).length, avg, win, best, worst, last };
    })
    .sort((a, b) => b.n - a.n || b.last - a.last)
    .map(
      (m) => `<tr>
        <td class="l">${m.market.slice(4)}</td><td>${m.n}</td><td>${m.t1}</td>
        <td class="${pctCls(m.avg)}">${pct(m.avg)}</td><td>${m.win === null ? "—" : `${m.win.toFixed(0)}%`}</td>
        <td class="pos">${pct(m.best, 1)}</td><td class="neg">${pct(m.worst, 1)}</td>
        <td class="dim">${kst(m.last)}</td>
      </tr>`,
    )
    .join("\n");

  // 발화 내역 전건 — 최신순. T1 이 아닌 행은 흐리게(실전 규칙은 T1 만 알람한다).
  const tradeRows = [...crash]
    .sort((a, b) => b.t - a.t)
    .map((t) => {
      const cell = (ek) => {
        const v = t.exits[ek];
        return v === undefined ? `<td class="dim">—</td>` : `<td class="${pctCls(v)}">${pct(v)}</td>`;
      };
      return `<tr${isT1(t) ? "" : ' class="offrule"'}>
        <td class="dim">${kst(t.t)}</td><td class="l">${t.market.slice(4)}</td>
        <td>${t.tier.slice(0, 2)}</td>
        <td class="neg">${fmt(t.drop72Pct, "%")}</td><td>${fmt(t.volMult, "배")}</td>
        <td>${priceFmt(t.entry)}</td>
        ${cell("hold24")}${cell("hold72")}${cell("atr")}
      </tr>`;
    })
    .join("\n");

  const c2 = r2.criteria;
  round2Html = `
<section>
  <h2>2차 회차 — 역발상 4종 (게이트 강화: 전체·2025·2026 각각 양수)</h2>
  <p class="dim">1차 결과를 보고 고른 가설이라(순차 검정) 연도 단위로 기준을 높였다.
  채택 = <code>${c2.adopt}</code> · 24봉 보유 기준 · 분석 ${r2.universe.analyzed}종 · 발화 ${r2.totalSignals.toLocaleString()}건</p>
  <table>
    <thead><tr><th>신호</th><th>발화</th><th>전체 평균</th><th>승률</th><th>2025</th><th>2026</th><th>판정</th></tr></thead>
    <tbody>${summaryRows}</tbody>
  </table>
</section>

<section>
  <h2>채택 신호 상세 — 급락 반전(crash) 종목별 성적</h2>
  <p class="dim">${byMarket.size}개 종목 · 발화 ${crash.length}건 (T1 ${crash.filter(isT1).length}건).
  실전 알람 규칙은 T1(일 거래대금 30일 중앙값 ≥10억)만 발화한다. 수익률은 24봉 보유·비용 차감 후.</p>
  <table>
    <thead><tr><th>종목</th><th>발화</th><th>T1</th><th>평균</th><th>승률</th><th>최고</th><th>최악</th><th>최근 발화(KST)</th></tr></thead>
    <tbody>${marketRows}</tbody>
  </table>
</section>

<section>
  <h2>발화 내역 전건 — 최신순</h2>
  <p class="dim">흐린 행은 T1 미달(실전 알람 제외 — 유동성 하한의 근거로 함께 보인다). 시각은 KST 신호 봉 기준.</p>
  <table>
    <thead><tr><th>봉 시각</th><th>종목</th><th>티어</th><th>3일 낙폭</th><th>거래량</th><th>진입가</th><th>24봉</th><th>72봉</th><th>ATR</th></tr></thead>
    <tbody>${tradeRows}</tbody>
  </table>
</section>`;
}

const c = results.criteria;
const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>현물신호 백테스트 — 게이트와 상세 내역 (REQ-0023)</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: 'Segoe UI', 'Malgun Gothic', sans-serif; max-width: 1080px; margin: 2rem auto; padding: 0 1rem; line-height: 1.55; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.15rem; margin-top: 2.5rem; } h3 { font-size: 0.95rem; margin: 1.2rem 0 0.4rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; font-variant-numeric: tabular-nums; }
  th, td { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); padding: 0.3rem 0.55rem; text-align: right; white-space: nowrap; }
  th:first-child, td:first-child, td.l { text-align: left; }
  tr.sep td { background: color-mix(in srgb, currentColor 8%, transparent); font-weight: 600; text-align: left; }
  tr.offrule td { opacity: 0.45; }
  .pos { color: #0a7d33; font-weight: 600; } .neg { color: #c0392b; font-weight: 600; }
  .dim { opacity: 0.65; }
  .badge { font-size: 0.75rem; padding: 0.15rem 0.5rem; border-radius: 0.6rem; vertical-align: middle; }
  .badge.ok { background: #0a7d33; color: #fff; } .badge.no { background: #c0392b; color: #fff; }
  code { opacity: 0.6; font-size: 0.8em; } .mono { font-family: Consolas, monospace; font-size: 0.75em; opacity: 0.6; }
  .criteria { background: color-mix(in srgb, currentColor 6%, transparent); padding: 0.8rem 1rem; border-radius: 0.5rem; font-size: 0.85rem; }
  section { overflow-x: auto; }
</style>
</head>
<body>
<h1>현물신호 백테스트 — 게이트와 상세 내역</h1>
<p class="dim">생성 ${results.generatedAt.slice(0, 16).replace("T", " ")} · 1차 ${results.universe.analyzed}종 · 신호 ${results.totalSignals.toLocaleString()}건${r2 ? ` · 2차 ${r2.totalSignals.toLocaleString()}건` : ""} · REQ-0023</p>
<div class="criteria">
  <strong>사전 등록 판정 기준</strong> — 평가 ${new Date(c.evalFrom).toISOString().slice(0, 10)}~ ·
  OOS 분할 ${new Date(c.oosSplit).toISOString().slice(0, 10)} · 수수료 왕복 ${(c.feeRt * 100).toFixed(2)}% ·
  슬리피지 ${c.slip.map((s) => `${s.tier} ${(s.rt * 100).toFixed(1)}%`).join(" / ")} ·
  쿨다운 ${c.cooldown}봉 · 진입 = 신호 다음 1H 봉 시가 ·
  1차 채택 = <code>${c.adopt}</code>
</div>
${round2Html}
<h2 style="margin-top:3rem">부록 — 1차 회차: 추세추종 롱 4종 (전부 기각)</h2>
<p class="dim">학습(23~24) 양수가 검증(25~)에서 전부 음수로 뒤집혔다 — 신호가 아니라 알트 강세장을 산 것이었다.</p>
${sigSections}
</body>
</html>
`;

const outDir = join(root, "docs", "backtest");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "spot-signal-report.html");
writeFileSync(outPath, html);
console.log(`✓ ${outPath}`);
