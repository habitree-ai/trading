/**
 * M3 — 매매 복기 리포트 생성.
 *
 * 집계는 전 거래를 다루지만, 캔들 카드까지 전부 심으면 HTML 이 수십 MB가 된다.
 * 카드는 대표 거래(손익 절대값 상위·강제청산·일지 메모 보유)만 캔들 창을 심고,
 * 나머지는 전량 테이블로 내려간다 — 집계·테이블은 항상 전체다.
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR, ROOT, loadData, saveOut } from "./lib/data.mjs";
import { getWindow, loadChunkStore, pickTf, windowRange } from "./lib/windows.mjs";

const CARD_TOP_N = 120;

const review = loadData("manual-review.json");
if (!review) {
  console.error("분석 결과 없음 — node re_sys/manual-analyze.mjs 를 먼저 실행하라.");
  process.exit(1);
}

const chunkStore = loadChunkStore();
const trades = review.trades;
const cardIds = new Set([
  ...trades.filter((t) => t.pnlUsd !== null).sort((a, b) => Math.abs(b.pnlUsd) - Math.abs(a.pnlUsd)).slice(0, CARD_TOP_N),
  ...trades.filter((t) => t.liq),
  ...trades.filter((t) => t.note),
].map((t) => t.id));

const windows = {};
for (const t of trades) {
  if (!cardIds.has(t.id) || !t.exitTs) continue;
  const tf = pickTf(t.exitTs - t.entryTs);
  const { from, to } = windowRange(t, tf);
  const w = getWindow(chunkStore, t.instId, tf, from, to);
  if (w) windows[t.id] = { tf: tf.bar, tfMs: tf.ms, candles: w };
}

const data = { ...review, windows };
const template = readFileSync(join(ROOT, "manual-report-template.html"), "utf8");
const json = JSON.stringify(data).replace(/</g, "\\u003c");
saveOut("manual-report.html", template.replace("__DATA_JSON__", json));

const stamp = new Date(review.generatedAt).toISOString().slice(0, 10);
mkdirSync(join(OUT_DIR, "archive"), { recursive: true });
copyFileSync(join(OUT_DIR, "manual-report.html"), join(OUT_DIR, "archive", `manual-report-${stamp}.html`));

console.log(
  `생성 완료 → re_sys/out/manual-report.html (거래 ${trades.length}건 · 카드 ${Object.keys(windows).length}건 · 사본: archive/manual-report-${stamp}.html)`,
);
