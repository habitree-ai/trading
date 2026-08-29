/**
 * 리포트 빌드 — out/arbitrage.json 을 template.html 의 __DATA_JSON__ 에 심어 자기완결 HTML 로 만든다.
 * scripts/backtest/impulse-mtf-report.mjs 와 같은 방식(토큰 하나 치환, </script 이스케이프, 고정 출력명).
 *
 * 사용: node arbitrage/report.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR, ROOT } from "./lib/cache.mjs";

const jsonPath = join(OUT_DIR, "arbitrage.json");
const raw = readFileSync(jsonPath, "utf8");
// 데이터는 <script type="application/json"> 안에 들어간다. 문자열 안의 "</script>" 가 태그를 조기 종료시키지 않게.
const safe = raw.replace(/<\/(script)/gi, "<\\/$1");
const html = readFileSync(join(ROOT, "template.html"), "utf8").replace("__DATA_JSON__", () => safe);
const out = join(OUT_DIR, "arbitrage-report.html");
writeFileSync(out, html);
console.log(`arbitrage.json → ${out} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)}MB)`);
