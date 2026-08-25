/**
 * P2·P3 — 전수 스윕 + 다중검정 보정 + 워크포워드.
 *
 * 62 신호 × 6 청산 × 4 필터 × 3 봉 = 4,464 백테스트.
 *
 * 이 단계의 위험은 계산이 아니라 해석이다. 4,464개를 훑으면 귀무가설이 참이어도
 * |t|가 4 근처인 조합이 하나쯤 나온다. 그래서 게이트를 두 겹으로 둔다:
 *  · BH-FDR q=0.10 — 거짓발견 비율 통제
 *  · IS/OOS 분리 — 앞 65%로 고르고 뒤 35%로 확인. 여기서 죽으면 그건 곡선 맞추기였다.
 */
import { OUT_DIR, TFS, saveOut } from "./lib/data.mjs";
import { EXITS, FAMILIES, FILTERS } from "./lib/signals.mjs";
import { benjaminiHochberg, nullMaxT, splitThirds, tradeStats } from "./lib/stats.mjs";
import {
  COST, GATE_FEE, GATE_SLIP, SAMPLE_MIN, TF_LIST, WARMUP,
  buildTfContext, comboKey, loadAll, runCombo, signalCache,
} from "./lib/runner.mjs";

const IS_FRACTION = 0.65;
const FDR_Q = 0.1;
const PF_MIN = 1.15;

function main() {
  const t0 = Date.now();
  const { data, fetchedAt, funding, fundingCum } = loadAll();
  console.log(`데이터: ${TF_LIST.map((tf) => `${tf} ${data[tf].length}개`).join(" · ")} · 펀딩 ${funding.length}건`);

  const rows = [];
  const emptyCombos = [];
  const tfMeta = {};

  for (const tf of TF_LIST) {
    const candles = data[tf];
    const tStart = candles[WARMUP].t;
    const tEnd = candles[candles.length - 1].t;
    const isCut = tStart + (tEnd - tStart) * IS_FRACTION;
    tfMeta[tf] = {
      bars: candles.length,
      from: new Date(tStart).toISOString().slice(0, 10),
      to: new Date(tEnd).toISOString().slice(0, 10),
      days: Math.round((tEnd - tStart) / 86_400_000),
      isCut: new Date(isCut).toISOString().slice(0, 10),
      maxHold: TFS[tf].maxHold,
      sampleMin: SAMPLE_MIN[tf],
    };

    console.log(`\n[${tf}] 지표 계산…`);
    const ctx = buildTfContext(data, tf);
    const sigs = signalCache(ctx);
    console.log(`[${tf}] 신호 인덱스 ${sigs.size}종 · 조합 ${sigs.size * EXITS.length}개 실행`);

    let done = 0;
    for (const [sigKey, idx] of sigs) {
      const [famKey, side, filterKey] = sigKey.split("|");
      for (const exit of EXITS) {
        const { trades, pnls } = runCombo({
          ctx, candles, tf, famKey, side, filterKey, exitKey: exit.key,
          signalIdx: idx, fundingCum,
        });
        done += 1;

        const key = comboKey(tf, famKey, side, filterKey, exit.key);
        if (!trades.length) {
          emptyCombos.push(key);
          rows.push({ key, tf, famKey, side, filterKey, exitKey: exit.key, family: FAMILIES[famKey].family, n: 0 });
          continue;
        }

        const full = tradeStats(pnls);
        const thirds = splitThirds(trades, pnls, tStart, tEnd);

        const isMask = trades.map((t) => t.exitAt <= isCut);
        const isPnls = pnls.filter((_, i) => isMask[i]);
        const oosPnls = pnls.filter((_, i) => !isMask[i]);

        rows.push({
          key, tf, famKey, side, filterKey, exitKey: exit.key,
          family: FAMILIES[famKey].family,
          novel: FAMILIES[famKey].novel === true,
          ...full,
          avgHold: Math.round(trades.reduce((s, t) => s + t.holdBars, 0) / trades.length),
          tpRate: Math.round((trades.filter((t) => t.exitType === "tp").length / trades.length) * 1000) / 10,
          timeRate: Math.round((trades.filter((t) => t.exitType === "time").length / trades.length) * 1000) / 10,
          thirds: thirds.sums,
          thirdsPositive: thirds.positive,
          tradesPerMonth: Math.round((trades.length / ((tEnd - tStart) / 86_400_000 / 30.44)) * 100) / 100,
          is: tradeStats(isPnls),
          oos: tradeStats(oosPnls),
        });
      }
      if (done % 400 === 0) process.stdout.write(`\r  ${done}/${sigs.size * EXITS.length}`);
    }
    process.stdout.write(`\r  ${done}/${sigs.size * EXITS.length} 완료\n`);
  }

  /* ---------- 게이트 ---------- */

  const tested = rows.filter((r) => r.n > 0);
  const bh = benjaminiHochberg(tested, FDR_Q);
  const bhKeys = new Set([...bh.rejected].map((i) => tested[i].key));
  const bonferroniP = FDR_Q / Math.max(1, tested.length);
  const maxTRef = nullMaxT(tested.length);

  for (const r of rows) {
    if (!r.n) {
      r.gates = { g1: false, g2: false, g3: false, g4: false, g5: false, g6: false, passed: 0 };
      continue;
    }
    const g1 = r.n >= SAMPLE_MIN[r.tf];
    const g2 = r.ev > 0;
    const g3 = r.pf >= PF_MIN;
    const g4 = r.thirdsPositive >= 2;
    const g5 = bhKeys.has(r.key);
    const g6 = r.oos.n > 0 && r.oos.ev > 0 && r.oos.pf >= 1.0;
    r.gates = { g1, g2, g3, g4, g5, g6, passed: [g1, g2, g3, g4, g5, g6].filter(Boolean).length };
    r.survivor = g1 && g2 && g3 && g4 && g5 && g6;
    r.bonferroni = r.p !== null && r.p <= bonferroniP;
  }

  const survivors = rows.filter((r) => r.survivor).sort((a, b) => b.t - a.t);
  const near = rows.filter((r) => !r.survivor && r.gates.passed === 5).sort((a, b) => b.t - a.t);

  /* ---------- 보고 ---------- */

  const byGate = {};
  for (const g of ["g1", "g2", "g3", "g4", "g5", "g6"]) byGate[g] = rows.filter((r) => r.gates[g]).length;

  console.log(`\n${"=".repeat(66)}`);
  console.log(`전수 ${rows.length}개 · 거래발생 ${tested.length}개 · 0거래 ${emptyCombos.length}개`);
  console.log(`게이트 개별 통과: G1 표본 ${byGate.g1} · G2 EV ${byGate.g2} · G3 PF ${byGate.g3} · G4 구간 ${byGate.g4} · G5 FDR ${byGate.g5} · G6 OOS ${byGate.g6}`);
  console.log(`다중검정: BH q=${FDR_Q} → p임계 ${bh.threshold.toExponential(2)} (${bh.kMax}개 기각) · Bonferroni ${bonferroniP.toExponential(2)} · 귀무 max|t| 기댓값 ${maxTRef.toFixed(2)}`);
  console.log(`\n★ 6/6 생존: ${survivors.length}개`);
  for (const s of survivors.slice(0, 25)) {
    console.log(
      `  ${s.tf.padEnd(4)} ${s.famKey.padEnd(17)} ${s.side.padEnd(5)} ${s.filterKey} ${s.exitKey} ` +
        `n=${String(s.n).padStart(5)} EV=${String(s.ev).padStart(7)}% PF=${String(s.pf).padStart(5)} t=${String(s.t).padStart(5)} ` +
        `OOS EV=${String(s.oos.ev).padStart(7)}% PF=${s.oos.pf}`,
    );
  }
  if (near.length) {
    console.log(`\n5/6 근접: ${near.length}개 (상위 10)`);
    for (const s of near.slice(0, 10)) {
      const miss = Object.entries(s.gates).filter(([k, v]) => k !== "passed" && !v).map(([k]) => k);
      console.log(`  ${s.tf.padEnd(4)} ${s.famKey.padEnd(17)} ${s.side.padEnd(5)} ${s.filterKey} ${s.exitKey} t=${String(s.t).padStart(5)} 탈락:${miss.join(",")}`);
    }
  }

  saveOut("sweep.json", {
    generatedAt: Date.now(),
    dataFetchedAt: fetchedAt,
    config: {
      warmup: WARMUP,
      cost: COST,
      gateFee: GATE_FEE,
      gateSlip: GATE_SLIP,
      isFraction: IS_FRACTION,
      fdrQ: FDR_Q,
      pfMin: PF_MIN,
      sampleMin: SAMPLE_MIN,
      families: Object.fromEntries(Object.entries(FAMILIES).map(([k, v]) => [k, { name: v.name, family: v.family, rule: v.rule, novel: v.novel === true }])),
      filters: Object.fromEntries(Object.entries(FILTERS).map(([k, v]) => [k, { name: v.name, desc: v.desc }])),
      exits: EXITS.map((e) => ({ key: e.key, name: e.name, sl: e.sl, tp: e.tp, trail: e.trail })),
      fundingRows: funding.length,
    },
    tfMeta,
    multipleTesting: { tested: tested.length, fdrQ: FDR_Q, bhThresholdP: bh.threshold, bhRejected: bh.kMax, bonferroniP, nullMaxT: maxTRef },
    gateCounts: byGate,
    emptyCombos,
    survivorKeys: survivors.map((s) => s.key),
    nearMissKeys: near.map((s) => s.key),
    rows,
  });

  console.log(`\n저장 → ${OUT_DIR}/sweep.json · ${((Date.now() - t0) / 1000).toFixed(0)}초`);
}

main();
