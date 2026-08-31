/**
 * SPOT-SIGNAL 회차 P3 — 게이트 리포트 생성 (REQ-0023 Phase A·A2 / REQ-0025 탭 구조).
 *
 * 1차(spot-signal-results.json)·2차(spot-signal2-results.json) 결과를 읽어
 * 탭 5개(설명·기준 / 판정 요약 / 종목별 성적 / 발화 내역 / 1차 부록)의 정적 HTML 을 만든다.
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

/* ── 1차 부록 ── */
const round1Sections = Object.keys(results.summary)
  .map((sig) => {
    const v = results.verdict[sig];
    const badge = v.adopted ? `<span class="badge ok">채택 후보</span>` : `<span class="badge no">기각</span>`;
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

/* ── 1차 한 줄 요약 (판정 요약 탭용) ── */
const round1Summary = Object.keys(results.summary)
  .map((sig) => {
    const e = results.summary[sig].exits.hold24;
    const cell = (s) => (s ? `<td class="${pctCls(s.avg)}">${fmt(s.avg, "%")}</td>` : `<td class="dim">—</td>`);
    return `<tr><td class="l">${SIG_LABEL[sig]} <span class="mono">${sig}</span></td><td>${results.summary[sig].total.toLocaleString()}</td>${cell(e.all)}${cell(e.train)}${cell(e.valid)}<td><span class="badge no">기각</span></td></tr>`;
  })
  .join("\n");

/* ── 2차 요약 + crash 상세 ── */
let round2Summary = "";
let marketSection = "";
let tradesSection = "";
if (r2) {
  round2Summary = Object.keys(r2.summary)
    .map((sig) => {
      const e = r2.summary[sig].exits.hold24;
      const v = r2.verdict[sig];
      const cell = (s) => (s ? `<td class="${pctCls(s.avg)}">${fmt(s.avg, "%")}</td>` : `<td class="dim">—</td>`);
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

  const byMarket = new Map();
  for (const t of crash) {
    if (!byMarket.has(t.market)) byMarket.set(t.market, []);
    byMarket.get(t.market).push(t);
  }
  const marketRows = [...byMarket.entries()]
    .map(([market, list]) => {
      const rets = list.map((t) => t.exits.hold24).filter((x) => x !== undefined);
      const avg = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null;
      const win = rets.length ? (rets.filter((r) => r > 0).length / rets.length) * 100 : null;
      return {
        market,
        n: list.length,
        t1: list.filter(isT1).length,
        avg,
        win,
        best: rets.length ? Math.max(...rets) : null,
        worst: rets.length ? Math.min(...rets) : null,
        last: Math.max(...list.map((t) => t.t)),
      };
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

  marketSection = `
  <p class="dim">${byMarket.size}개 종목 · 발화 ${crash.length}건 (T1 ${crash.filter(isT1).length}건).
  실전 알람은 T1(일 거래대금 30일 중앙값 ≥10억)만 발화한다. 수익률은 24봉 보유·비용 차감 후.</p>
  <table>
    <thead><tr><th>종목</th><th>발화</th><th>T1</th><th>평균</th><th>승률</th><th>최고</th><th>최악</th><th>최근 발화(KST)</th></tr></thead>
    <tbody>${marketRows}</tbody>
  </table>`;

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

  tradesSection = `
  <p class="dim">흐린 행은 T1 미달(실전 알람 제외 — 유동성 하한의 근거로 함께 보인다). 시각은 KST 신호 봉 기준.</p>
  <table>
    <thead><tr><th>봉 시각</th><th>종목</th><th>티어</th><th>3일 낙폭</th><th>거래량</th><th>진입가</th><th>24봉</th><th>72봉</th><th>ATR</th></tr></thead>
    <tbody>${tradeRows}</tbody>
  </table>`;
}

/* ── 설명·기준 탭 ── */
const c = results.criteria;
const guideSection = `
<section>
  <h2>이 리포트가 답하는 질문</h2>
  <p>업비트 KRW 현물에서 <b>기술적 신호로 진입할 현실적 근거가 있는가?</b>
  있다면 어떤 규칙이고, 과거에 어떤 종목에서 어떻게 벌고 잃었는가.
  카톡 알람(현물신호 탭)은 여기서 <b>통과한 규칙 하나만</b> 실시간으로 돌린 것이다.</p>

  <h2>검증 방식 — 사전 등록 후 판정</h2>
  <ol>
    <li><b>기준을 먼저 고정한다.</b> 신호 규칙·비용·평가 방법·채택 조건을 코드에 적은 뒤에 실행한다.
    결과를 보고 기준을 고치면(스누핑) 어떤 규칙이든 통과시킬 수 있기 때문이다.</li>
    <li><b>1차 — 추세추종 롱 4종</b> (눌림목·골든크로스·신고가 돌파·압축 돌파): 전부 기각.
    학습 구간(23~24)의 양수가 검증 구간(25~)에서 전부 음수로 뒤집혔다 — 신호가 아니라 알트 강세장을 산 것.</li>
    <li><b>2차 — 역발상 4종</b>: 1차 결과를 보고 고른 가설이라(순차 검정) 기준을 더 높였다 —
    전체뿐 아니라 <b>2025년·2026년 각각 양수</b>여야 통과. <b>급락 반전(crash)만 통과</b>했다.</li>
  </ol>

  <h2>채택 규칙 — 급락 반전(crash) 각 조건의 의미</h2>
  <table>
    <thead><tr><th>조건</th><th>값</th><th>왜 이 조건인가</th></tr></thead>
    <tbody>
      <tr><td class="l">3일(72×1H봉) 낙폭</td><td>≤ −25%</td><td class="l">공포 매도가 쏟아진 뒤라야 반등에 엣지가 있다. 얕은 조정은 통과 못 한다</td></tr>
      <tr><td class="l">신호 봉이 양봉</td><td>종가 &gt; 시가</td><td class="l">떨어지는 칼날을 잡지 않는다 — 매수세가 실제로 들어온 첫 확인</td></tr>
      <tr><td class="l">거래량 확증</td><td>&gt; 직전 20봉 평균 ×1.5</td><td class="l">반등이 소액 호가 튐이 아니라 실제 수요인지 거른다</td></tr>
      <tr><td class="l">유동성 하한 (T1)</td><td>일 거래대금 30일 중앙값 ≥ 10억</td><td class="l">계층 분해 결과 T3(&lt;1억)는 음수 — 잡코인은 슬리피지가 엣지를 다 먹는다</td></tr>
      <tr><td class="l">쿨다운</td><td>같은 종목 ${c.cooldown}봉(24시간)</td><td class="l">같은 급락 하나에 매시간 재알람하는 것을 막는다</td></tr>
    </tbody>
  </table>

  <h2>평가 방법 — 숫자가 만들어진 방식</h2>
  <table>
    <thead><tr><th>항목</th><th>값</th><th>설명</th></tr></thead>
    <tbody>
      <tr><td class="l">진입가</td><td>다음 1H봉 시가</td><td class="l">알람은 봉 마감 후에 오므로, 마감가가 아니라 그다음 봉 시가로 산 것으로 계산</td></tr>
      <tr><td class="l">비용(왕복)</td><td>수수료 ${(c.feeRt * 100).toFixed(2)}% + 슬리피지 0.1~0.3%</td><td class="l">슬리피지는 유동성 계층(T1/T2/T3)별로 다르게 차감 — 모든 수익률은 차감 후 값</td></tr>
      <tr><td class="l">보유 기준</td><td>24 / 72 / 168봉 · ATR</td><td class="l">진입 후 N시간 뒤 시가 청산으로 평가. 채택 근거는 24봉(약 1일). ATR은 손절 1.5·목표 3.0 배</td></tr>
      <tr><td class="l">평가 구간</td><td>${new Date(c.evalFrom).toISOString().slice(0, 10)} ~</td><td class="l">앞 3개월은 지표 워밍업으로 제외</td></tr>
      <tr><td class="l">OOS 분할</td><td>${new Date(c.oosSplit).toISOString().slice(0, 10)}</td><td class="l">학습(23~24)에서 좋아 보여도 검증(25~)에서 무너지면 기각 — 1차 4종이 전부 이 관문에서 죽었다</td></tr>
    </tbody>
  </table>

  <h2>용어</h2>
  <table>
    <thead><tr><th>용어</th><th>뜻</th></tr></thead>
    <tbody>
      <tr><td class="l">PF (Profit Factor)</td><td class="l">총이익 ÷ 총손실. 1보다 커야 번 것. 2면 손실 1원당 2원 벌었다는 뜻</td></tr>
      <tr><td class="l">승률</td><td class="l">비용 차감 후 수익이 양수인 거래의 비율</td></tr>
      <tr><td class="l">OOS (Out-of-Sample)</td><td class="l">규칙을 고를 때 보지 않은 구간에서의 성적 — 과최적화를 걸러내는 장치</td></tr>
      <tr><td class="l">T1 / T2 / T3</td><td class="l">유동성 계층: 일 거래대금 30일 중앙값 ≥10억 / 1억~10억 / &lt;1억</td></tr>
      <tr><td class="l">발화</td><td class="l">규칙의 모든 조건이 동시에 참이 된 봉 — 알람 1건에 해당</td></tr>
    </tbody>
  </table>

  <h2>한계 — 이 숫자를 믿기 전에</h2>
  <ul>
    <li>발화가 폭락일에 군집한다 — 같은 날 신호들은 사실상 시장 반등 하나에 거는 상관된 베팅이다</li>
    <li>2026년은 승률 39%로 소수 큰 반등이 평균을 끌었다 — 엣지가 약해지는 중일 수 있다</li>
    <li>폭락장의 실제 슬리피지는 모델(0.1~0.3%)보다 나쁠 수 있다</li>
    <li>과거 통계이며 미래를 보장하지 않는다. 자동 매수 없음 — 진입·크기·청산 판단은 사람 몫이다</li>
  </ul>
</section>`;

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>현물신호 백테스트 — 게이트와 상세 내역 (REQ-0023)</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: 'Segoe UI', 'Malgun Gothic', sans-serif; max-width: 1080px; margin: 1.5rem auto 3rem; padding: 0 1rem; line-height: 1.55; }
  h1 { font-size: 1.4rem; margin-bottom: 0.2rem; } h2 { font-size: 1.1rem; margin-top: 2rem; } h3 { font-size: 0.95rem; margin: 1.2rem 0 0.4rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; font-variant-numeric: tabular-nums; }
  th, td { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); padding: 0.3rem 0.55rem; text-align: right; white-space: nowrap; }
  th:first-child, td:first-child, td.l { text-align: left; }
  td.l { white-space: normal; }
  tr.sep td { background: color-mix(in srgb, currentColor 8%, transparent); font-weight: 600; text-align: left; }
  tr.offrule td { opacity: 0.45; }
  .pos { color: #0a7d33; font-weight: 600; } .neg { color: #c0392b; font-weight: 600; }
  .dim { opacity: 0.65; }
  .badge { font-size: 0.75rem; padding: 0.15rem 0.5rem; border-radius: 0.6rem; vertical-align: middle; }
  .badge.ok { background: #0a7d33; color: #fff; } .badge.no { background: #c0392b; color: #fff; }
  code { opacity: 0.6; font-size: 0.8em; } .mono { font-family: Consolas, monospace; font-size: 0.75em; opacity: 0.6; }
  .tabs { position: sticky; top: 0; display: flex; flex-wrap: wrap; gap: 0.4rem; padding: 0.6rem 0;
    background: Canvas; border-bottom: 1px solid color-mix(in srgb, currentColor 25%, transparent); z-index: 5; }
  .tab { font: inherit; font-size: 0.85rem; padding: 0.35rem 0.8rem; border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 999px; background: transparent; color: inherit; cursor: pointer; }
  .tab.active { background: color-mix(in srgb, currentColor 12%, transparent); font-weight: 600; }
  .pane { display: none; overflow-x: auto; }
  .pane.active { display: block; }
</style>
</head>
<body>
<h1>현물신호 백테스트 — 게이트와 상세 내역</h1>
<p class="dim">생성 ${results.generatedAt.slice(0, 16).replace("T", " ")} · 1차 ${results.universe.analyzed}종 · 신호 ${results.totalSignals.toLocaleString()}건${r2 ? ` · 2차 ${r2.totalSignals.toLocaleString()}건` : ""} · REQ-0023</p>

<nav class="tabs">
  <button class="tab active" data-tab="guide">설명·기준</button>
  <button class="tab" data-tab="verdict">판정 요약</button>
  ${r2 ? `<button class="tab" data-tab="markets">종목별 성적</button>
  <button class="tab" data-tab="trades">발화 내역</button>` : ""}
  <button class="tab" data-tab="round1">1차 상세 (부록)</button>
</nav>

<div id="tab-guide" class="pane active">${guideSection}</div>

<div id="tab-verdict" class="pane">
  ${r2 ? `<h2>2차 회차 — 역발상 4종 (게이트 강화: 전체·2025·2026 각각 양수)</h2>
  <p class="dim">채택 = <code>${r2.criteria.adopt}</code> · 24봉 보유 기준 · 분석 ${r2.universe.analyzed}종 · 발화 ${r2.totalSignals.toLocaleString()}건</p>
  <table>
    <thead><tr><th>신호</th><th>발화</th><th>전체 평균</th><th>승률</th><th>2025</th><th>2026</th><th>판정</th></tr></thead>
    <tbody>${round2Summary}</tbody>
  </table>` : ""}
  <h2>1차 회차 — 추세추종 롱 4종 (전부 기각)</h2>
  <p class="dim">24봉 보유 기준. 학습 양수 → 검증 음수의 전형적 반전. 상세 표는 "1차 상세" 탭.</p>
  <table>
    <thead><tr><th>신호</th><th>발화</th><th>전체</th><th>학습 23~24</th><th>검증 25~</th><th>판정</th></tr></thead>
    <tbody>${round1Summary}</tbody>
  </table>
  <h2 style="margin-top:2rem">사전 등록 기준 원문</h2>
  <p class="dim">평가 ${new Date(c.evalFrom).toISOString().slice(0, 10)}~ · OOS 분할 ${new Date(c.oosSplit).toISOString().slice(0, 10)} ·
  수수료 왕복 ${(c.feeRt * 100).toFixed(2)}% · 슬리피지 ${c.slip.map((s) => `${s.tier} ${(s.rt * 100).toFixed(1)}%`).join(" / ")} ·
  쿨다운 ${c.cooldown}봉 · 진입 = 신호 다음 1H봉 시가 · 1차 채택 = <code>${c.adopt}</code>${r2 ? ` · 2차 채택 = <code>${r2.criteria.adopt}</code>` : ""}</p>
</div>

${r2 ? `<div id="tab-markets" class="pane"><h2>채택 신호 상세 — 급락 반전(crash) 종목별 성적</h2>${marketSection}</div>
<div id="tab-trades" class="pane"><h2>발화 내역 전건 — 최신순</h2>${tradesSection}</div>` : ""}

<div id="tab-round1" class="pane">
  <h2>부록 — 1차 회차: 추세추종 롱 4종 전체 표</h2>
  <p class="dim">학습(23~24) 양수가 검증(25~)에서 전부 음수로 뒤집혔다 — 신호가 아니라 알트 강세장을 산 것이었다.</p>
  ${round1Sections}
</div>

<script>
  document.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
      document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + b.dataset.tab));
      window.scrollTo({ top: 0 });
    }),
  );
</script>
</body>
</html>
`;

const outDir = join(root, "docs", "backtest");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "spot-signal-report.html");
writeFileSync(outPath, html);
console.log(`✓ ${outPath}`);
