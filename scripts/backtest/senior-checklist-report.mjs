/**
 * 선배님 체크리스트 리포트 빌드 — 회차 JSON을 템플릿에 심어 자기완결 HTML로 만든다.
 *
 * 출력은 둘이다.
 *   docs/backtest/senior-checklist-report.html — 자료실용 완전한 문서(항상 같은 파일, 링크 유지)
 *   <tmp>/senior-checklist-artifact.html      — 아티팩트용 조각(바깥 <html>/<head>/<body> 없음)
 * 아티팩트는 게시할 때 문서 껍데기를 스스로 씌우므로, 껍데기가 든 파일을 올리면 이중이 된다.
 * 그래서 템플릿에 표시해 둔 FRAGMENT 구간만 잘라 따로 쓴다.
 *
 * 사용: node scripts/backtest/senior-checklist-report.mjs [회차.json] [조각 출력 경로]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "docs", "backtest");

const rounds = readdirSync(outDir)
  .filter((f) => /^\d{4}-\d{2}-\d{2}-senior-checklist\.json$/.test(f))
  .sort();
if (rounds.length === 0) {
  console.error("docs/backtest/ 에 회차 JSON이 없습니다 — 먼저 senior-checklist.mjs 를 돌리세요.");
  process.exit(1);
}

const jsonPath = process.argv[2] ?? join(outDir, rounds[rounds.length - 1]);
const raw = readFileSync(jsonPath, "utf8");

// 데이터는 <script type="application/json"> 안에 들어간다. 문자열 안의 "</script>" 가
// 태그를 조기 종료시키지 않게 슬래시만 이스케이프한다 — JSON 파싱에는 영향이 없다.
const safe = raw.replace(/<\/(script)/gi, "<\\/$1");
const html = readFileSync(join(here, "senior-checklist-template.html"), "utf8").replace("__DATA_JSON__", () => safe);

const full = join(outDir, "senior-checklist-report.html");
writeFileSync(full, html);

const s = html.indexOf("<!--FRAGMENT-START-->");
const e = html.indexOf("<!--FRAGMENT-END-->");
if (s < 0 || e < 0) {
  console.error("템플릿에 FRAGMENT 표시가 없습니다 — 조각을 만들 수 없습니다.");
  process.exit(1);
}
const frag = html
  .slice(s + "<!--FRAGMENT-START-->".length, e)
  .replace(/<\/head>\s*<body>/, "") // 껍데기 경계만 걷어 낸다
  .trim();
if (/<\/?(html|head|body)\b/i.test(frag)) {
  console.error("조각에 문서 껍데기 태그가 남았습니다 — 중단");
  process.exit(1);
}

const fragPath = process.argv[3] ?? join(outDir, "senior-checklist-artifact.html");
writeFileSync(fragPath, frag);

const mb = (n) => (n / 1024 / 1024).toFixed(2);
console.log(`${basename(jsonPath)}`);
console.log(`  → ${full} (${mb(Buffer.byteLength(html))}MB)`);
console.log(`  → ${fragPath} (${mb(Buffer.byteLength(frag))}MB · 아티팩트용 조각)`);
