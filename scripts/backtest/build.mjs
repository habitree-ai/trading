/**
 * 백테스트 리포트 빌드 — 회차 JSON을 템플릿에 심어 HTML로 만든다.
 *
 * 사용: node scripts/backtest/build.mjs [회차.json]
 *   → 기본: docs/backtest/ 의 가장 최근 *-btc-1h.json
 *   → 출력: docs/backtest/btc-1h-report.html (항상 같은 파일 — 아티팩트 URL 유지)
 *
 * 회차 번호는 docs/backtest/ 에 쌓인 JSON 파일 순서에서 나온다 — 따로 세지 않는다.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "docs", "backtest");

const rounds = readdirSync(outDir)
  .filter((f) => /^\d{4}-\d{2}-\d{2}-btc-1h\.json$/.test(f))
  .sort();
if (rounds.length === 0) {
  console.error("docs/backtest/ 에 회차 JSON이 없습니다 — 먼저 run.mjs 를 돌리세요.");
  process.exit(1);
}

const jsonPath = process.argv[2] ?? join(outDir, rounds[rounds.length - 1]);
const round = rounds.indexOf(basename(jsonPath)) + 1 || rounds.length;

const html = readFileSync(join(here, "report-template.html"), "utf8")
  .replace("__DATA_JSON__", readFileSync(jsonPath, "utf8"))
  .replace("__ROUND__", String(round))
  .replace("__DATA_PATH__", `docs/backtest/${basename(jsonPath)}`);

const out = join(outDir, "btc-1h-report.html");
writeFileSync(out, html);
console.log(`${round}회차 (${basename(jsonPath)}) → ${out}`);
