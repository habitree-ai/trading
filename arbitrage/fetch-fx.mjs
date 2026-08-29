/**
 * USD/KRW 일별 환율 — Frankfurter(ECB 기준환율, 무키) 를 정본으로 쓴다.
 *
 * Dunamu 환율 API 는 이 환경에서 DNS 가 풀리지 않고 종료 정황이 있어 제외했다.
 * ECB 는 영업일에만 값이 있으므로 주말·휴일은 직전값으로 채우고(src=1) 채운 날을 표시한다 —
 * 김프 통계는 채운 날을 제외한 버전도 함께 낸다(analyze.mjs).
 * 4일 넘게 비는 구간은 jsDelivr currency-api 로 메운다(src=2).
 *
 * 행: [t(UTC 00:00 ms), usdkrw, src]  src 0=ECB 1=ffill 2=jsDelivr
 * 사용: node arbitrage/fetch-fx.mjs [--days 1125]
 */
import { fetchJson } from "./lib/http.mjs";
import { mergeReport, saveCache } from "./lib/cache.mjs";
import { verifySeries } from "./lib/verify.mjs";

const DAY = 86_400_000;
const args = process.argv.slice(2);
const di = args.indexOf("--days");
const days = di >= 0 ? Number(args[di + 1]) : 3 * 365 + 30;

function iso(t) {
  return new Date(t).toISOString().slice(0, 10);
}

async function main() {
  const today = Math.floor(Date.now() / DAY) * DAY;
  const from = today - days * DAY;
  const url = `https://api.frankfurter.dev/v1/${iso(from)}..${iso(today)}?base=USD&symbols=KRW`;
  console.log(`Frankfurter ${iso(from)} → ${iso(today)}`);
  const json = await fetchJson(url);
  const ecb = new Map();
  for (const [d, r] of Object.entries(json.rates || {})) {
    if (r && Number.isFinite(r.KRW)) ecb.set(Date.parse(`${d}T00:00:00Z`), r.KRW);
  }
  console.log(`  ECB 영업일 ${ecb.size}일`);
  if (ecb.size < days * 0.6) throw new Error(`ECB 값이 너무 적다: ${ecb.size}`);

  const rows = [];
  let last = null;
  let gap = 0;
  let filled = 0;
  let jsd = 0;
  const firstT = Math.min(...ecb.keys());
  for (let t = firstT; t <= today; t += DAY) {
    if (ecb.has(t)) {
      last = ecb.get(t);
      gap = 0;
      rows.push([t, last, 0]);
      continue;
    }
    gap += 1;
    let v = null;
    if (gap > 4) {
      // 긴 공백(연휴) — jsDelivr 스냅샷으로 시도. 없으면 그대로 forward-fill.
      try {
        const j = await fetchJson(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${iso(t)}/v1/currencies/usd.json`, { retries: 1, baseDelayMs: 500 });
        if (j && j.usd && Number.isFinite(j.usd.krw)) {
          v = j.usd.krw;
          jsd += 1;
        }
      } catch {
        /* forward-fill 로 간다 */
      }
    }
    if (v === null) {
      v = last;
      filled += 1;
      rows.push([t, v, 1]);
    } else {
      last = v;
      rows.push([t, v, 2]);
    }
  }
  const v = verifySeries("fx-usdkrw-1d", rows, { tfMs: DAY, maxMissPct: 0.01 });
  console.log(`  ${v.line}`);
  console.log(`  forward-fill ${filled}일 · jsDelivr ${jsd}일 · 최신 ${iso(rows[rows.length - 1][0])} = ${rows[rows.length - 1][1]}`);
  if (!v.ok) {
    console.error("✗ 검증 실패 — 저장 안 함");
    process.exit(1);
  }
  saveCache("fx-usdkrw-1d.json", rows);
  mergeReport([{ ...v, source: "frankfurter.dev (ECB)", filled, jsDelivr: jsd }]);
  console.log("✓ 저장 .cache/fx-usdkrw-1d.json");
}

main().catch((e) => {
  console.error("\n✗", e.message);
  process.exit(1);
});
