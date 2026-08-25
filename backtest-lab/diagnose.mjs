/**
 * P2-보조 — "생존 0개"가 발견인가 버그인가.
 *
 * 전수 4,464개에서 최대 t가 2.66이었다. 귀무가설 하 최대 t 기댓값(4.10)보다 낮다.
 * 결론을 내리기 전에 네 가지를 갈라야 한다:
 *
 *  ① 매수보유 대조 — 이 창에서 BTC 자체는 무엇을 했나 (엔진이 방향을 뒤집지 않았나)
 *  ② 무비용 스윕 — 총손익 기준으로는 엣지가 있는데 비용이 먹은 것인가
 *  ③ 무작위 진입 대조 — 지표 신호가 무작위 진입보다 나은가 (엣지의 존재 자체)
 *  ④ 비용 분해 — 봉별로 수수료·슬리피지·펀딩이 각각 얼마를 먹는가
 *
 * ②가 ①과 비슷하고 ③이 실제 신호와 구분되지 않으면, 답은 "엣지가 없다"이다.
 */
import { TFS, saveOut } from "./lib/data.mjs";
import { EXITS, FILTERS, FAMILIES } from "./lib/signals.mjs";
import { nullMaxT, tradeStats } from "./lib/stats.mjs";
import { simulate } from "./lib/engine.mjs";
import { GATE_FEE, GATE_SLIP, TF_LIST, WARMUP, buildTfContext, loadAll, runCombo, signalCache } from "./lib/runner.mjs";

const RANDOM_STRATS = 400;
const SEED = 20260817;

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

function main() {
  const { data, fundingCum } = loadAll();
  const out = { generatedAt: Date.now(), tfs: {} };

  for (const tf of TF_LIST) {
    const candles = data[tf];
    const ctx = buildTfContext(data, tf);
    const sigs = signalCache(ctx);
    const first = candles[WARMUP];
    const last = candles[candles.length - 1];
    const days = (last.t - first.t) / 86_400_000;

    /* ① 매수보유 */
    const bh = ((last.c - first.c) / first.c) * 100;
    const bhCagr = (Math.pow(last.c / first.c, 365 / days) - 1) * 100;

    /* ②③④ — 같은 조합 집합을 비용 있음/없음으로 두 번 */
    const net = [];
    const gross = [];
    let feeSum = 0;
    let fundSum = 0;
    let tradeCount = 0;
    let holdSum = 0;

    for (const [sigKey, idx] of sigs) {
      const [famKey, side, filterKey] = sigKey.split("|");
      for (const exit of EXITS) {
        const rNet = runCombo({ ctx, candles, tf, famKey, side, filterKey, exitKey: exit.key, signalIdx: idx, fundingCum });
        if (!rNet.trades.length) continue;
        const rGross = runCombo({ ctx, candles, tf, famKey, side, filterKey, exitKey: exit.key, signalIdx: idx, fundingCum: null, fee: 0, slip: 0 });
        net.push(tradeStats(rNet.pnls));
        gross.push(tradeStats(rGross.pnls));
        for (let k = 0; k < rNet.trades.length; k += 1) {
          const t = rNet.trades[k];
          const f = fundingCum(t.entryAt, t.exitAt) * (t.side === "long" ? 1 : -1);
          feeSum += GATE_FEE + GATE_SLIP;
          fundSum += f;
          holdSum += t.holdBars;
          tradeCount += 1;
        }
      }
    }

    /* ③ 무작위 진입 — 신호 개수를 실제 중앙값에 맞춘 무작위 시점. 청산은 x3 동일. */
    const rng = makeRng(SEED + tf.length * 7919);
    const sigCounts = [...sigs.values()].map((v) => v.length).filter((x) => x > 0).sort((a, b) => a - b);
    const medSig = sigCounts[sigCounts.length >> 1] || 100;
    const exitX3 = EXITS.find((e) => e.key === "x3");
    const randT = [];
    for (let s = 0; s < RANDOM_STRATS; s += 1) {
      const picks = new Set();
      const room = candles.length - 1 - WARMUP;
      while (picks.size < Math.min(medSig, room)) picks.add(WARMUP + Math.floor(rng() * room));
      const idx = [...picks].sort((a, b) => a - b);
      const side = s % 2 === 0 ? "long" : "short";
      const all = simulate(candles, ctx, idx, side, exitX3, TFS[tf].maxHold).filter((t) => t.exitType !== "open");
      if (all.length < 20) continue;
      const pnls = all.map((t) => t.grossPct - GATE_FEE - GATE_SLIP - (t.side === "long" ? 1 : -1) * fundingCum(t.entryAt, t.exitAt));
      randT.push(tradeStats(pnls).t);
    }
    randT.sort((a, b) => a - b);

    const maxT = (arr) => Math.max(...arr.map((x) => x.t));
    const evPos = (arr) => arr.filter((x) => x.ev > 0).length;

    out.tfs[tf] = {
      window: { from: new Date(first.t).toISOString().slice(0, 10), to: new Date(last.t).toISOString().slice(0, 10), days: Math.round(days) },
      buyHold: { totalPct: +bh.toFixed(2), cagrPct: +bhCagr.toFixed(2) },
      combos: net.length,
      net: { maxT: +maxT(net).toFixed(2), evPositive: evPos(net), evPositivePct: +((evPos(net) / net.length) * 100).toFixed(1) },
      gross: { maxT: +maxT(gross).toFixed(2), evPositive: evPos(gross), evPositivePct: +((evPos(gross) / gross.length) * 100).toFixed(1) },
      nullMaxTExpected: +nullMaxT(net.length).toFixed(2),
      randomEntry: {
        strategies: randT.length,
        medianT: +randT[randT.length >> 1].toFixed(2),
        maxT: +randT[randT.length - 1].toFixed(2),
        p95T: +randT[Math.floor(randT.length * 0.95)].toFixed(2),
      },
      costPerTrade: {
        trades: tradeCount,
        feeSlipPct: +(feeSum / tradeCount).toFixed(4),
        fundingPct: +(fundSum / tradeCount).toFixed(4),
        totalPct: +((feeSum + fundSum) / tradeCount).toFixed(4),
        avgHoldBars: Math.round(holdSum / tradeCount),
        avgHoldDays: +((holdSum / tradeCount) * (TFS[tf].ms / 86_400_000)).toFixed(2),
      },
    };

    const o = out.tfs[tf];
    console.log(`\n[${tf}] ${o.window.from} → ${o.window.to} (${o.window.days}일)`);
    console.log(`  매수보유       총 ${o.buyHold.totalPct}% · CAGR ${o.buyHold.cagrPct}%`);
    console.log(`  비용 후(net)   최대 t ${o.net.maxT} · EV>0 ${o.net.evPositive}/${o.combos} (${o.net.evPositivePct}%)`);
    console.log(`  비용 전(gross) 최대 t ${o.gross.maxT} · EV>0 ${o.gross.evPositive}/${o.combos} (${o.gross.evPositivePct}%)`);
    console.log(`  귀무 max|t| 기댓값 ${o.nullMaxTExpected}`);
    console.log(`  무작위 진입    중앙 t ${o.randomEntry.medianT} · p95 ${o.randomEntry.p95T} · 최대 ${o.randomEntry.maxT} (${o.randomEntry.strategies}개)`);
    console.log(
      `  거래당 비용    수수료+슬립 ${o.costPerTrade.feeSlipPct}% + 펀딩 ${o.costPerTrade.fundingPct}% = ${o.costPerTrade.totalPct}% ` +
        `(평균 보유 ${o.costPerTrade.avgHoldBars}봉 = ${o.costPerTrade.avgHoldDays}일)`,
    );
  }

  saveOut("diagnose.json", out);
  console.log(`\n저장 → out/diagnose.json`);
}

main();
