/**
 * 백테스트 아카이브 빌드 — rounds.json(정본 레지스트리)에서 docs/backtest/index.html 생성.
 *
 * 목적: 회차가 쌓일수록 "무엇을 검증했고 무엇이 결론이었나"가 파일 더미에 묻힌다.
 * 이 문서가 계보 전체의 입구다 — 회차 카드(질문·결론·링크), 채택 시스템, 재실행 안내.
 *
 * 사용: node scripts/backtest/build-archive.mjs
 * 새 회차를 만들면: rounds.json에 항목 추가 → 이 스크립트 재실행 → 커밋.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = join(repoRoot, "docs", "backtest");
const reg = JSON.parse(readFileSync(join(dir, "rounds.json"), "utf8"));

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const cards = reg.rounds
  .slice()
  .reverse()
  .map(
    (r) => `
  <article class="card${r.artifact && r.name.includes("★") ? " star" : ""}">
    <div class="head"><span class="date tnum">${r.date}</span><h3>${esc(r.name)}</h3></div>
    <p class="q">${esc(r.question)}</p>
    <p class="c">${esc(r.conclusion)}</p>
    <div class="links">
      <a href="${r.report}">리포트</a>
      <a href="${r.data}">데이터 JSON</a>
      ${r.artifact ? `<a href="${r.artifact}" target="_blank" rel="noopener">아티팩트 ↗</a>` : ""}
    </div>
  </article>`,
  )
  .join("");

const adopted = reg.adopted
  .map((a) => `<li><b>${esc(a.name)}</b> — ${esc(a.detail)}</li>`)
  .join("");

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>백테스트 아카이브</title>
<style>
  :root {
    color-scheme: dark;
    --bg:#0e1116; --surface:#161a21; --surface-2:#1e232c; --border:#2a3039;
    --ink:#e6e9ee; --dim:#8b95a3; --accent:#5b8cff; --profit:#26c281; --loss:#f0616d; --bench:#c98500; --grid:#232935;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      color-scheme: light;
      --bg:#f7f8fa; --surface:#ffffff; --surface-2:#f1f3f6; --border:#e2e5ea;
      --ink:#14171c; --dim:#666e7a; --accent:#3b6ef5; --profit:#0f9d58; --loss:#dc3545; --bench:#b06f00; --grid:#eceef2;
    }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.6 ui-sans-serif, system-ui, "Pretendard", "Segoe UI", "Malgun Gothic", sans-serif; -webkit-font-smoothing:antialiased; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 44px 20px 72px; }
  h1 { margin: 0; font-size: 24px; font-weight: 750; letter-spacing: -0.02em; }
  .sub { color: var(--dim); font-size: 13px; margin-top: 6px; padding-bottom: 18px; border-bottom: 1px solid var(--border); }
  .tnum { font-variant-numeric: tabular-nums; }
  section { margin-top: 40px; }
  .eyebrow { font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--dim); margin: 0 0 10px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 12px; padding: 14px 18px; margin-top: 12px; }
  .card.star { border-left-color: var(--profit); }
  .card .head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .card .date { color: var(--dim); font-size: 12px; }
  .card h3 { margin: 0; font-size: 15px; font-weight: 750; }
  .card .q { color: var(--dim); font-size: 12.5px; margin: 6px 0 4px; }
  .card .c { font-size: 13px; margin: 0; }
  .links { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .links a { color: var(--accent); font-size: 12px; text-decoration: none; border: 1px solid var(--border); border-radius: 999px; padding: 2px 11px; }
  .links a:hover { border-color: var(--accent); }
  ul.adopted { list-style: none; padding: 0; margin: 12px 0 0; display: grid; gap: 8px; }
  ul.adopted li { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; font-size: 13px; }
  .note { background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--bench); border-radius: 10px; padding: 12px 16px; font-size: 12.5px; color: var(--dim); margin-top: 12px; }
  .note b { color: var(--ink); }
  code { font-family: ui-monospace, "Cascadia Mono", monospace; font-size: 11.5px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }
  footer { margin-top: 48px; padding-top: 14px; border-top: 1px solid var(--border); color: var(--dim); font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>백테스트 아카이브</h1>
  <p class="sub">BTC-USDT-SWAP · 회차 ${reg.rounds.length}개 · 계보: 그리드 탐색 → 표본 검증 → 기하·비용 축 → 조합·오버레이 → 파생 데이터 — 각 회차의 질문과 결론, 원자료 링크의 정본 목록.
  갱신: <code>docs/backtest/rounds.json</code> 편집 후 <code>node scripts/backtest/build-archive.mjs</code></p>

  <section>
    <p class="eyebrow">Adopted Systems</p>
    <ul class="adopted">${adopted}</ul>
    <div class="note"><b>판정 정본은 criteria.md</b> — 이 아카이브는 "왜 그렇게 정했나"의 기록이다. 모든 백테스트 수치는 인샘플 상한이며, 최종 판정은 전방 검증(페이퍼 북 실측)이다. 본 문서는 투자 조언이 아니라 검증 기록이다.</div>
  </section>

  <section>
    <p class="eyebrow">Rounds — 최신순</p>
    ${cards}
  </section>

  <footer>생성: build-archive.mjs · 데이터·리포트는 같은 폴더(docs/backtest/)에 회차별로 보존 · 캔들 캐시는 scripts/backtest/.cache/ (재수집 가능)</footer>
</div>
</body>
</html>
`;

writeFileSync(join(dir, "index.html"), html);
console.log(`회차 ${reg.rounds.length}개 → ${join(dir, "index.html")}`);
