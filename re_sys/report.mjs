/**
 * P3 — 복기 리포트 생성.
 *
 * data/replay.json 을 템플릿에 심어 자기완결 HTML 로 만든다(브라우저만 있으면 열린다).
 * out/report.html 이 최신본이고, out/archive/ 에 날짜별 사본을 남겨 회차를 누적한다 —
 * 설정이 바뀐 뒤에도 "그때 복기가 뭐라고 했는지"를 다시 열어볼 수 있게.
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR, ROOT, loadData, saveOut } from "./lib/data.mjs";

const replay = loadData("replay.json");
if (!replay) {
  console.error("복기 결과 없음: re_sys/data/replay.json — node re_sys/replay.mjs 를 먼저 실행하라.");
  process.exit(1);
}

const template = readFileSync(join(ROOT, "report-template.html"), "utf8");
// </script> 조기 종료 방지 — JSON 안의 < 를 이스케이프한다.
const json = JSON.stringify(replay).replace(/</g, "\\u003c");
saveOut("report.html", template.replace("__DATA_JSON__", json));

const stamp = new Date(replay.generatedAt).toISOString().slice(0, 10);
mkdirSync(join(OUT_DIR, "archive"), { recursive: true });
copyFileSync(join(OUT_DIR, "report.html"), join(OUT_DIR, "archive", `report-${stamp}.html`));

console.log(`생성 완료 → re_sys/out/report.html (사본: out/archive/report-${stamp}.html)`);
