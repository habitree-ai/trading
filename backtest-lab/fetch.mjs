/**
 * P1 — 데이터 수집.
 *
 * 검증 기준(README §3): 봉별 개수·실제 일수 출력 · 결측률 <1% · 시각 단조 증가.
 * 하나라도 어긋나면 여기서 멈춘다. 나쁜 데이터로 돌린 4,464개는 나쁜 4,464개다.
 */
import { TFS, fetchCandles, fetchFundingBinance, fetchFundingOkx, saveCache } from "./lib/data.mjs";

const label = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

async function main() {
  const data = {};
  const report = [];

  for (const [tf, cfg] of Object.entries(TFS)) {
    console.log(`\n[${tf}] ${cfg.days}일 수집`);
    const rows = await fetchCandles(cfg.bar, cfg.ms, cfg.days);
    data[tf] = rows;

    if (!rows.length) {
      console.error(`  ✗ ${tf}: 0개 — 중단`);
      process.exit(1);
    }
    let nonMono = 0;
    for (let i = 1; i < rows.length; i += 1) if (rows[i].t <= rows[i - 1].t) nonMono += 1;

    const spanMs = rows[rows.length - 1].t - rows[0].t;
    const spanDays = spanMs / 86_400_000;
    const expected = Math.floor(spanMs / cfg.ms) + 1;
    const missPct = ((expected - rows.length) / expected) * 100;

    console.log(
      `  ✓ ${label(rows.length)}개 · 실제 ${spanDays.toFixed(0)}일 · ` +
        `결측 ${missPct.toFixed(2)}% · 단조위반 ${nonMono} · ` +
        `${new Date(rows[0].t).toISOString().slice(0, 10)} → ${new Date(rows[rows.length - 1].t).toISOString().slice(0, 10)}`,
    );
    if (nonMono > 0) {
      console.error(`  ✗ ${tf}: 시각 단조 위반 — 중단`);
      process.exit(1);
    }
    if (missPct > 1) {
      console.error(`  ✗ ${tf}: 결측률 ${missPct.toFixed(2)}% > 1% — 중단`);
      process.exit(1);
    }
    report.push({ tf, bars: rows.length, spanDays: Math.round(spanDays), missPct: Number(missPct.toFixed(3)) });
  }

  // 펀딩 — OKX 공개 API는 약 95일만 보존한다. 전 구간은 Binance 대리변수로 덮고,
  // 겹치는 구간에서 둘이 실제로 같은 것을 재는지 확인한 뒤에 쓴다.
  console.log(`\n[펀딩] OKX 실측(보존 한계 확인)`);
  const okx = await fetchFundingOkx(1800);
  console.log(`\n[펀딩] Binance 1800일 대리변수`);
  const bin = await fetchFundingBinance(1800);

  if (bin.length < 3000) {
    console.error(`  ✗ Binance 펀딩 ${bin.length}건 — 1800일이면 5,400건 근처여야 한다. 중단`);
    process.exit(1);
  }

  const stat = (rows) => {
    const avg = (rows.reduce((s, f) => s + f.rate, 0) / rows.length) * 100;
    const pos = (rows.filter((f) => f.rate > 0).length / rows.length) * 100;
    return { rows: rows.length, avgPer8hPct: avg, annualLongPct: avg * 3 * 365, positiveSharePct: pos };
  };
  const sOkx = stat(okx);
  const sBin = stat(bin);
  console.log(
    `  OKX      ${sOkx.rows}건 · 평균 ${sOkx.avgPer8hPct.toFixed(5)}%/8h · 롱 연 ${sOkx.annualLongPct.toFixed(1)}% · ` +
      `${new Date(okx[0].t).toISOString().slice(0, 10)} →`,
  );
  console.log(
    `  Binance  ${sBin.rows}건 · 평균 ${sBin.avgPer8hPct.toFixed(5)}%/8h · 롱 연 ${sBin.annualLongPct.toFixed(1)}% · ` +
      `${new Date(bin[0].t).toISOString().slice(0, 10)} →`,
  );

  // 대리변수 검증 — 겹치는 구간에서 상관과 평균 차이.
  const binMap = new Map(bin.map((f) => [Math.round(f.t / 3_600_000) * 3_600_000, f.rate]));
  const pairs = [];
  for (const f of okx) {
    const v = binMap.get(Math.round(f.t / 3_600_000) * 3_600_000);
    if (v !== undefined) pairs.push([f.rate, v]);
  }
  let corr = null;
  let biasPct = null;
  if (pairs.length > 30) {
    const ma = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
    const mb = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
    let cab = 0;
    let va = 0;
    let vb = 0;
    for (const [a, b] of pairs) {
      cab += (a - ma) * (b - mb);
      va += (a - ma) ** 2;
      vb += (b - mb) ** 2;
    }
    corr = va > 0 && vb > 0 ? cab / Math.sqrt(va * vb) : null;
    biasPct = (ma - mb) * 100;
  }
  console.log(
    `  겹침 ${pairs.length}건 · 상관 ${corr === null ? "—" : corr.toFixed(3)} · ` +
      `평균차(OKX−Binance) ${biasPct === null ? "—" : biasPct.toFixed(6)}%/8h`,
  );
  if (corr !== null && corr < 0.5) {
    console.error(`  ✗ 상관 ${corr.toFixed(3)} < 0.5 — 대리변수로 쓸 수 없다. 중단`);
    process.exit(1);
  }

  saveCache("candles.json", { fetchedAt: Date.now(), symbol: "BTC-USDT-SWAP", data });
  saveCache("funding.json", {
    fetchedAt: Date.now(),
    primary: "binance-BTCUSDT",
    reason: "OKX 공개 API 보존 한계 약 95일 — 전 구간은 Binance 대리변수, 겹침 구간에서 검증",
    funding: bin,
    okxSample: okx,
    validation: { overlap: pairs.length, corr, biasPer8hPct: biasPct },
  });
  saveCache("fetch-report.json", {
    fetchedAt: Date.now(),
    tfs: report,
    funding: { okx: sOkx, binance: sBin, validation: { overlap: pairs.length, corr, biasPer8hPct: biasPct } },
  });
  console.log(`\n저장 완료 → backtest-lab/.cache/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
