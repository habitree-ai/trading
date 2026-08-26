/**
 * IMPULSE-MTF 리포트 빌드 — 회차 JSON을 템플릿에 심어 자기완결 HTML로 만든다.
 *
 * 출력은 항상 같은 파일이다(docs/backtest/impulse-mtf-report.html) — 자료실 링크가
 * 회차마다 바뀌지 않게. oneway-report.mjs 와 같은 방식.
 *
 * 사용: node scripts/backtest/impulse-mtf-report.mjs [회차.json]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "docs", "backtest");

const rounds = readdirSync(outDir)
  .filter((f) => /^\d{4}-\d{2}-\d{2}-impulse-mtf\.json$/.test(f))
  .sort();
if (rounds.length === 0) {
  console.error("docs/backtest/ 에 impulse-mtf 회차 JSON이 없습니다 — 먼저 impulse-mtf.mjs run 을 돌리세요.");
  process.exit(1);
}

const jsonPath = process.argv[2] ?? join(outDir, rounds[rounds.length - 1]);
const raw = readFileSync(jsonPath, "utf8");

// 데이터는 <script type="application/json"> 안에 들어간다. 문자열 안의 "</script>" 가
// 태그를 조기 종료시키지 않게 슬래시만 이스케이프한다 — JSON 파싱에는 영향이 없다.
const safe = raw.replace(/<\/(script)/gi, "<\\/$1");

const html = readFileSync(join(here, "impulse-mtf-template.html"), "utf8").replace("__DATA_JSON__", () => safe);

const out = join(outDir, "impulse-mtf-report.html");
writeFileSync(out, html);
console.log(`${basename(jsonPath)} → ${out} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)}MB)`);
