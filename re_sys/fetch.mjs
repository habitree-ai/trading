/**
 * P1 — OKX 과거 캔들·펀딩비 수집·누적.
 *
 * 종목(BTC·DOGE) × 타임프레임(1D·4H·1H 전 구간, 15m 730일, 5m 60일) 매트릭스.
 * 첫 실행: 캡 또는 상장 시점까지 전부. 이후 실행: 마지막 저장 봉과 다리가 놓일 때까지만
 * 받아 증분 누적한다 — 캡이 있는 TF도 저장분은 시간이 지나며 캡 폭을 넘어 자란다.
 * `--full` 은 저장분을 무시하고 전 구간을 다시 훑는다(복구·검증용).
 *
 * 검증 기준: 시각 단조 증가 위반 0 · 결측률 <1%. 어긋나면 저장하지 않고 멈춘다.
 * 펀딩비는 보존창(약 95일)이 좁아 누적 자체가 아카이브다 — 같이 받는다.
 */
import { existsSync, unlinkSync } from "node:fs";
import {
  INSTRUMENTS,
  TF,
  candlesCsv,
  dataPath,
  fetchFundingBack,
  fetchHistoryBack,
  loadData,
  mergeCandles,
  saveData,
  saveDataText,
  validateCandles,
} from "./lib/data.mjs";

const FULL = process.argv.includes("--full");
const label = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** 구명 파일(candles-4H.json 등, BTC 전용) → 새 이름 시드. 재수집 없이 이어받는다. */
function seedStore(sym, tf) {
  const store = loadData(`candles-${sym}-${tf}.json`);
  if (store || sym !== "BTC") return store;
  const legacy = loadData(`candles-${tf}.json`);
  return legacy ? { ...legacy, migratedFrom: `candles-${tf}.json` } : null;
}

async function main() {
  for (const { sym, instId } of INSTRUMENTS) {
    for (const [tf, cfg] of Object.entries(TF)) {
      const store = FULL ? null : seedStore(sym, tf);
      const existing = store?.candles ?? [];
      // 다리 지점: 저장분이 있으면 그 최신 봉, 없으면 캡 경계(캡 없는 TF는 상장까지).
      const stopAtTs = existing.length
        ? existing[existing.length - 1].t
        : cfg.capDays
          ? Date.now() - cfg.capDays * 86_400_000
          : null;
      const maxPages = stopAtTs ? Math.ceil((Date.now() - stopAtTs) / (100 * cfg.ms)) + 5 : 3000;

      console.log(
        `\n[${sym} ${tf}] ${existing.length ? `저장 ${label(existing.length)}봉 — 증분` : cfg.capDays ? `${cfg.capDays}일 수집` : "전 구간 수집"}${FULL ? " (--full)" : ""}`,
      );
      const fetched = await fetchHistoryBack(cfg.bar, { stopAtTs, maxPages }, instId);
      const merged = mergeCandles(existing, fetched);
      if (!merged.length) {
        console.error(`  ✗ ${sym} ${tf}: 0봉 — 중단`);
        process.exit(1);
      }

      const v = validateCandles(merged, cfg.ms);
      console.log(
        `  ✓ 누적 ${label(v.bars)}봉 · ${v.spanDays.toFixed(0)}일 · 결측 ${v.missPct.toFixed(2)}% · 단조위반 ${v.nonMono} · ` +
          `${new Date(merged[0].t).toISOString().slice(0, 10)} → ${new Date(merged[merged.length - 1].t).toISOString().slice(0, 10)}`,
      );
      if (v.nonMono > 0 || v.missPct > 1) {
        console.error(`  ✗ ${sym} ${tf}: 검증 실패 — 저장하지 않고 중단`);
        process.exit(1);
      }

      saveData(`candles-${sym}-${tf}.json`, {
        instId,
        bar: cfg.bar,
        updatedAt: Date.now(),
        added: merged.length - existing.length,
        candles: merged,
      });
      saveDataText(`candles-${sym}-${tf}.csv`, candlesCsv(merged));
      // 구명 파일 정리 — 새 이름으로 옮겨 심은 뒤에만.
      if (store?.migratedFrom && existsSync(dataPath(store.migratedFrom))) {
        unlinkSync(dataPath(store.migratedFrom));
        unlinkSync(dataPath(store.migratedFrom.replace(".json", ".csv")));
        console.log(`  · ${store.migratedFrom} → candles-${sym}-${tf}.json 이관`);
      }
    }

    // 펀딩비 누적 — 보존창(≈95일)씩 받아 로컬 아카이브를 키운다.
    const fStore = loadData(`funding-${sym}.json`);
    const fetched = await fetchFundingBack(instId);
    const map = new Map((fStore?.funding ?? []).map((f) => [f.t, f]));
    for (const f of fetched) map.set(f.t, f);
    const funding = [...map.values()].sort((a, b) => a.t - b.t);
    saveData(`funding-${sym}.json`, { instId, updatedAt: Date.now(), funding });
    console.log(
      `\n[${sym} 펀딩] 누적 ${funding.length}건 · ${new Date(funding[0].t).toISOString().slice(0, 10)} → ${new Date(funding[funding.length - 1].t).toISOString().slice(0, 10)}`,
    );
  }
  console.log("\n저장 완료 → re_sys/data/candles-*-*.{json,csv} · funding-*.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
