/**
 * P7 — 워크포워드 분석: "그래서 월 몇 %까지 되는가, 어떤 지표로?"
 *
 * 앞 회차가 보여준 것: 인샘플 t 상위로 고른 부품 8개가 OOS에서 8/8 마이너스였다.
 * 그러므로 "최대 수익률 지표"를 전체 창 랭킹으로 뽑으면 같은 거짓말을 반복하게 된다.
 *
 * 여기서는 **지표를 고르는 대신 고르는 절차를 검증한다.**
 * 창을 10등분하고, 폴드 f 시점에는 폴드 1..f−1 의 정보만으로 부품을 뽑아 폴드 f 에서 매매한다.
 * 그렇게 이어붙인 손익이 "그때 그 자리에서 실제로 손에 쥐었을 수익"이다.
 *
 * 선별 규칙 4종을 나란히 돌린다 — 어느 하나가 맞기를 바라는 게 아니라,
 * 절차 자체에 재현 가능한 우위가 있는지를 본다.
 *   R1 t상위      누적 t 상위 N개                (앞 회차가 실패한 바로 그 방식)
 *   R2 EV상위     누적 기대값 상위 N개
 *   R3 광범위분산  누적 EV>0 인 것 전부 동일가중   (선별을 최소화)
 *   R4 무선별     전 조합 동일가중               (순수 분산 대조군)
 *
 * 사용: node backtest-lab/wfa.mjs
 */
import { TFS, saveOut } from "./lib/data.mjs";
import { EXITS, FAMILIES, FILTERS } from "./lib/signals.mjs";
import { blockBootstrap, median, percentile, r2, tradeStats } from "./lib/stats.mjs";
import { runPortfolio, START } from "./lib/portfolio.mjs";
import { SAMPLE_MIN, TF_LIST, buildTfContext, comboKey, loadAll, runCombo, signalCache } from "./lib/runner.mjs";

const FOLDS = 10;
const TRAIN_FOLDS = 3; // 폴드 1~3은 학습 전용. 매매는 폴드 4~10.
const TOP_N = 4; // 봉당 선발 인원 (R1·R2)
const PER_FAMILY = 1; // 같은 계열 중복 방지 — 분산이 아니라 같은 베팅의 반복이 되지 않게
const MIN_TRAIN_TRADES = 60; // 학습 구간 누적 최소 표본
const RISKS = [0.5, 1, 1.5, 2, 3, 4, 5, 7, 10, 15];
const LEV_CAP = 10;
const OVERLAYS = ["base", "throttle"];
const MDD_CEILINGS = [20, 30, 40, 50];

/* ---------- 폴드 경계 ---------- */

function foldEdges(candles, warmup = 300) {
  const t0 = candles[warmup].t;
  const t1 = candles[candles.length - 1].t;
  const step = (t1 - t0) / FOLDS;
  return Array.from({ length: FOLDS + 1 }, (_, i) => t0 + step * i);
}

/** 거래를 폴드로 나눈다 — 청산 시각 기준(그때 손익이 확정된다). */
function foldOf(edges, ts) {
  for (let f = 0; f < FOLDS; f += 1) if (ts < edges[f + 1]) return f;
  return FOLDS - 1;
}

/* ---------- 1차 통과: 조합 × 폴드 요약 ---------- */

function pass1(data, fundingCum) {
  const perTf = {};
  for (const tf of TF_LIST) {
    const candles = data[tf];
    const ctx = buildTfContext(data, tf);
    const sigs = signalCache(ctx);
    const edges = foldEdges(candles);
    const stats = new Map(); // key → 폴드별 {n, sum, sumsq, gp, gl}

    for (const [sigKey, idx] of sigs) {
      const [famKey, side, filterKey] = sigKey.split("|");
      for (const exit of EXITS) {
        const { trades, pnls } = runCombo({
          ctx, candles, tf, famKey, side, filterKey, exitKey: exit.key, signalIdx: idx, fundingCum,
        });
        if (!trades.length) continue;
        const per = Array.from({ length: FOLDS }, () => ({ n: 0, sum: 0, sumsq: 0, gp: 0, gl: 0 }));
        for (let i = 0; i < trades.length; i += 1) {
          const f = foldOf(edges, trades[i].exitAt);
          const v = pnls[i];
          per[f].n += 1;
          per[f].sum += v;
          per[f].sumsq += v * v;
          if (v > 0) per[f].gp += v;
          else per[f].gl += v;
        }
        stats.set(comboKey(tf, famKey, side, filterKey, exit.key), per);
      }
    }
    perTf[tf] = { edges, stats, ctx, candles };
    console.log(`  [${tf}] 조합 ${stats.size}개 · 폴드 경계 ${new Date(edges[0]).toISOString().slice(0, 10)} … ${new Date(edges[FOLDS]).toISOString().slice(0, 10)}`);
  }
  return perTf;
}

/** 폴드 0..f-1 누적 통계. */
function cumStats(per, f) {
  let n = 0, sum = 0, sumsq = 0, gp = 0, gl = 0;
  for (let k = 0; k < f; k += 1) {
    n += per[k].n; sum += per[k].sum; sumsq += per[k].sumsq; gp += per[k].gp; gl += per[k].gl;
  }
  if (n < 2) return { n, ev: 0, t: 0, pf: 0 };
  const ev = sum / n;
  const varr = Math.max(0, sumsq / n - ev * ev) * (n / (n - 1));
  const sd = Math.sqrt(varr);
  return { n, ev, t: sd > 0 ? (ev / sd) * Math.sqrt(n) : 0, pf: gl === 0 ? (gp > 0 ? 9 : 0) : gp / Math.abs(gl) };
}

/* ---------- 선별 규칙 ---------- */

const RULES = {
  R1: {
    name: "누적 t 상위",
    why: "앞 회차가 실패한 방식 그대로 — 절차로서 재현되는지 확인한다",
    pick: (cands) => topN(cands, (c) => c.t),
  },
  R2: {
    name: "누적 기대값 상위",
    why: "유의성 대신 크기로 고른다",
    pick: (cands) => topN(cands, (c) => c.ev),
  },
  R3: {
    name: "EV>0 전부 (광범위 분산)",
    why: "선별을 최소화하고 분산에 기댄다",
    pick: (cands) => cands.filter((c) => c.ev > 0),
  },
  R4: {
    name: "무선별 (전 조합 동일가중)",
    why: "순수 분산 대조군 — 선별에 가치가 있는지 재는 기준선",
    pick: (cands) => cands,
  },
};

function topN(cands, score) {
  const famUsed = {};
  const out = [];
  for (const c of [...cands].sort((a, b) => score(b) - score(a))) {
    if (out.length >= TOP_N) break;
    if (score(c) <= 0) break;
    if ((famUsed[c.famKey] ?? 0) >= PER_FAMILY) continue;
    famUsed[c.famKey] = (famUsed[c.famKey] ?? 0) + 1;
    out.push(c);
  }
  return out;
}

/* ---------- 2차 통과: 선발된 조합의 거래 되살리기 ---------- */

function materialize(perTf, keys, fundingCum, cache) {
  for (const key of keys) {
    if (cache.has(key)) continue;
    const [tf, famKey, side, filterKey, exitKey] = key.split(":");
    const { ctx, candles } = perTf[tf];
    const { trades, pnls } = runCombo({ ctx, candles, tf, famKey, side, filterKey, exitKey, fundingCum });
    cache.set(key, trades.map((t, i) => ({
      entryAt: t.entryAt, exitAt: t.exitAt, side: t.side, slPct: t.slPct, maePct: t.maePct, net: pnls[i], key,
    })));
  }
}

/* ---------- 실행 ---------- */

function main() {
  const t0 = Date.now();
  const { data, fundingCum } = loadAll();
  console.log(`워크포워드 — 창 ${FOLDS}등분 · 폴드 1~${TRAIN_FOLDS} 학습 전용 · 폴드 ${TRAIN_FOLDS + 1}~${FOLDS} 매매\n`);

  console.log("1차 통과 — 조합 × 폴드 요약");
  const perTf = pass1(data, fundingCum);

  // 매매 구간 = 각 봉의 폴드 TRAIN_FOLDS 시작 ~ 끝. 봉마다 창이 다르므로 합집합으로 본다.
  const tradeFrom = Math.min(...TF_LIST.map((tf) => perTf[tf].edges[TRAIN_FOLDS]));
  const tradeTo = Math.max(...TF_LIST.map((tf) => perTf[tf].edges[FOLDS]));
  console.log(`\n매매 구간 ${new Date(tradeFrom).toISOString().slice(0, 10)} → ${new Date(tradeTo).toISOString().slice(0, 10)} (${Math.round((tradeTo - tradeFrom) / 86_400_000)}일)`);
  for (const tf of TF_LIST) {
    console.log(`  ${tf.padEnd(4)} 매매 개시 ${new Date(perTf[tf].edges[TRAIN_FOLDS]).toISOString().slice(0, 10)}`);
  }

  const tradeCache = new Map();
  const selections = {}; // rule → fold → tf → [key]
  const eventsByRule = {}; // rule → 이어붙인 OOS 거래
  const famScore = {}; // 계열별 실현 OOS 기여 (R1·R2 기준 선발분)

  for (const rk of Object.keys(RULES)) {
    selections[rk] = [];
    eventsByRule[rk] = [];
  }

  console.log(`\n2차 통과 — 폴드별 선별 → 해당 폴드에서만 매매`);
  for (let f = TRAIN_FOLDS; f < FOLDS; f += 1) {
    for (const tf of TF_LIST) {
      const { edges, stats } = perTf[tf];
      const foldFrom = edges[f];
      const foldTo = edges[f + 1];

      // 후보 = 학습 구간 누적 표본이 최소치를 넘는 것만. 데이터가 없는 봉은 자연히 빠진다.
      const cands = [];
      for (const [key, per] of stats) {
        const cum = cumStats(per, f);
        if (cum.n < MIN_TRAIN_TRADES) continue;
        const [, famKey, side, filterKey, exitKey] = key.split(":");
        cands.push({ key, tf, famKey, side, filterKey, exitKey, ...cum });
      }
      if (!cands.length) continue;

      for (const [rk, rule] of Object.entries(RULES)) {
        const picked = rule.pick(cands);
        if (!picked.length) continue;
        selections[rk].push({ fold: f, tf, from: foldFrom, to: foldTo, keys: picked.map((p) => p.key) });
        materialize(perTf, picked.map((p) => p.key), fundingCum, tradeCache);
        for (const p of picked) {
          for (const tr of tradeCache.get(p.key)) {
            // 이 폴드 안에서 청산된 거래만 — 폴드 경계를 넘나들면 정보가 샌다.
            if (tr.exitAt < foldFrom || tr.exitAt >= foldTo) continue;
            eventsByRule[rk].push({ ...tr, fold: f, tf, famKey: p.famKey });
          }
        }
        if (rk === "R1" || rk === "R2") {
          for (const p of picked) {
            const realized = tradeCache.get(p.key).filter((tr) => tr.exitAt >= foldFrom && tr.exitAt < foldTo);
            const s = (famScore[p.famKey] ??= { picks: 0, trades: 0, sum: 0, sumsq: 0, wins: 0, byFold: {}, family: FAMILIES[p.famKey].family, name: FAMILIES[p.famKey].name, novel: FAMILIES[p.famKey].novel === true });
            s.picks += 1;
            // 폴드별 손익도 따로 센다 — 누적 플러스가 한 폴드의 운인지 반복인지는 이걸로만 갈린다.
            const fk = `${f}`;
            s.byFold[fk] ??= { sum: 0, n: 0 };
            for (const tr of realized) {
              s.trades += 1; s.sum += tr.net; s.sumsq += tr.net * tr.net; if (tr.net > 0) s.wins += 1;
              s.byFold[fk].sum += tr.net; s.byFold[fk].n += 1;
            }
          }
        }
      }
    }
  }

  /* ---------- 규칙별 OOS 성적 ---------- */

  const ruleResults = [];
  for (const [rk, rule] of Object.entries(RULES)) {
    const evs = eventsByRule[rk];
    if (!evs.length) continue;
    const raw = tradeStats(evs.map((e) => e.net));

    // 리스크·오버레이 격자에서 낙폭 상한별 최대 월 복리를 찾는다.
    const grid = [];
    for (const overlay of OVERLAYS) {
      for (const riskPct of RISKS) {
        const res = runPortfolio(evs, { riskPct, levCap: LEV_CAP, overlay, from: tradeFrom, to: tradeTo });
        const boot = blockBootstrap(res.stepReturns, { blocks: 20, runs: 1000 });
        grid.push({ overlay, riskPct, ...res, ruin: boot?.ruinPct ?? null, bootP20: boot?.p20 ?? null, bootP50: boot?.p50 ?? null, stepReturns: undefined });
      }
    }
    const best = {};
    for (const ceil of MDD_CEILINGS) {
      const ok = grid.filter((g) => g.mddPessimistic !== null && g.mddPessimistic >= -ceil && g.liquidations === 0);
      best[ceil] = ok.length ? ok.reduce((a, b) => ((b.monthlyGeo ?? -99) > (a.monthlyGeo ?? -99) ? b : a)) : null;
    }
    ruleResults.push({ rule: rk, name: rule.name, why: rule.why, raw, events: evs.length, grid, best });
  }

  /* ---------- 지표별 OOS 기여 ---------- */

  const famRank = Object.entries(famScore).map(([k, s]) => {
    const ev = s.trades ? s.sum / s.trades : 0;
    const varr = s.trades > 1 ? Math.max(0, s.sumsq / s.trades - ev * ev) * (s.trades / (s.trades - 1)) : 0;
    const sd = Math.sqrt(varr);
    const folds = Object.values(s.byFold).filter((v) => v.n > 0);
    return {
      famKey: k, name: s.name, family: s.family, novel: s.novel,
      picks: s.picks, trades: s.trades,
      ev: Math.round(ev * 1e4) / 1e4,
      t: r2(sd > 0 && s.trades > 1 ? (ev / sd) * Math.sqrt(s.trades) : 0),
      winRate: r2(s.trades ? (s.wins / s.trades) * 100 : 0),
      totalPct: r2(s.sum),
      foldsTraded: folds.length,
      foldsPositive: folds.filter((v) => v.sum > 0).length,
    };
  }).sort((a, b) => b.totalPct - a.totalPct);

  /* ---------- 후행 상한 — OOS 결과를 미리 알았다면 ---------- */

  /**
   * 이것은 기대값이 아니라 **상한**이다. 어떤 지표가 잘될지 미리 알 수 없으므로
   * 실전에서 도달할 수 없다. 그럼에도 재는 이유: "지표 선택만 잘하면 되지 않나"에
   * 숫자로 답하기 위해서다. 완벽한 지표 선택조차 얼마까지밖에 못 가는지를 본다.
   */
  const hindsight = [];
  const poolEvents = [...eventsByRule.R1, ...eventsByRule.R2];
  for (const topK of [1, 2, 3, 5]) {
    const keep = new Set(famRank.slice(0, topK).map((f) => f.famKey));
    const evs = poolEvents.filter((e) => keep.has(e.famKey));
    if (evs.length < 30) continue;
    const raw = tradeStats(evs.map((e) => e.net));
    let best = null;
    for (const overlay of OVERLAYS) {
      for (const riskPct of RISKS) {
        const res = runPortfolio(evs, { riskPct, levCap: LEV_CAP, overlay, from: tradeFrom, to: tradeTo });
        if (res.liquidations > 0 || res.mddPessimistic < -50) continue;
        if (!best || (res.monthlyGeo ?? -99) > (best.monthlyGeo ?? -99)) {
          const boot = blockBootstrap(res.stepReturns, { blocks: 20, runs: 1000 });
          best = { overlay, riskPct, ...res, ruin: boot?.ruinPct ?? null, bootP20: boot?.p20 ?? null, stepReturns: undefined };
        }
      }
    }
    hindsight.push({ topK, families: famRank.slice(0, topK).map((f) => f.name), raw, best });
  }

  /* ---------- 매수보유 기준선 ---------- */

  const bh = {};
  let bhCurve = null;
  let bhMdd = null;
  for (const tf of TF_LIST) {
    const c = perTf[tf].candles;
    const inRange = c.filter((b) => b.t >= tradeFrom && b.t <= tradeTo);
    if (inRange.length < 2) continue;
    const total = ((inRange[inRange.length - 1].c - inRange[0].c) / inRange[0].c) * 100;
    const months = (tradeTo - tradeFrom) / 86_400_000 / 30.4375;
    bh[tf] = { totalPct: r2(total), monthlyGeo: r2((Math.pow(1 + total / 100, 1 / months) - 1) * 100) };
    // 비교용 곡선·낙폭은 4H(가장 긴 창)로 그린다. 매수보유는 봉과 무관하지만 표본 간격만 다르다.
    if (tf === "4H") {
      const base = inRange[0].c;
      const every = Math.max(1, Math.ceil(inRange.length / 600));
      bhCurve = inRange.filter((_, i) => i % every === 0 || i === inRange.length - 1)
        .map((b) => ({ t: b.t, equity: (b.c / base) * START }));
      let peak = -Infinity;
      bhMdd = 0;
      for (const b of inRange) {
        peak = Math.max(peak, b.c);
        bhMdd = Math.min(bhMdd, ((b.c - peak) / peak) * 100);
      }
      bhMdd = r2(bhMdd);
    }
  }

  /* ---------- 보고 ---------- */

  console.log(`\n${"=".repeat(100)}`);
  console.log(`선별 규칙별 OOS 성적 — 거래당 순손익(1× 기준)`);
  console.log(`규칙  ${"이름".padEnd(24)} 거래수   EV%      PF     t      승률%`);
  for (const r of ruleResults) {
    console.log(`${r.rule}    ${r.name.padEnd(24)} ${String(r.raw.n).padStart(6)} ${String(r.raw.ev).padStart(8)} ${String(r.raw.pf).padStart(6)} ${String(r.raw.t).padStart(6)} ${String(r.raw.winRate).padStart(7)}`);
  }

  console.log(`\n${"=".repeat(100)}`);
  console.log(`낙폭 상한별 달성 가능 최대 월 복리 (거래소 레버 ${LEV_CAP}×, 강제청산 0건 조건)`);
  console.log(`규칙  MDD상한  설정            월복리%   CAGR%    실현MDD%   최종$    거래/월  파산확률%  부트p20$`);
  for (const r of ruleResults) {
    for (const ceil of MDD_CEILINGS) {
      const b = r.best[ceil];
      if (!b) { console.log(`${r.rule}    ≤${String(ceil).padStart(3)}%   — 해당 설정 없음`); continue; }
      console.log(
        `${r.rule}    ≤${String(ceil).padStart(3)}%   ${(b.overlay + " r" + b.riskPct).padEnd(14)} ` +
        `${String(b.monthlyGeo).padStart(8)} ${String(b.cagr).padStart(8)} ${String(b.mddPessimistic).padStart(9)} ` +
        `${String(b.finalEquity).padStart(9)} ${String(b.tradesPerMonth).padStart(8)} ${String(b.ruin).padStart(9)} ${String(b.bootP20).padStart(9)}`,
      );
    }
  }

  console.log(`\n매수보유 기준선 (같은 구간): ${TF_LIST.map((tf) => bh[tf] ? `${tf} 총 ${bh[tf].totalPct}% = 월 ${bh[tf].monthlyGeo}%` : "").filter(Boolean).join(" · ")}`);

  console.log(`\n${"=".repeat(100)}`);
  console.log(`지표별 OOS 실현 기여 (t·EV 상위 규칙에서 실제로 선발되어 매매된 것만)`);
  console.log(`${"지표".padEnd(24)} 계열   선발  거래   EV%      t      승률%   누적손익%  플러스폴드`);
  for (const f of famRank) {
    console.log(
      `${(f.name + (f.novel ? " ★" : "")).padEnd(24)} ${f.family.padEnd(5)} ${String(f.picks).padStart(4)} ${String(f.trades).padStart(5)} ` +
      `${String(f.ev.toFixed(3)).padStart(8)} ${String(f.t).padStart(6)} ${String(f.winRate).padStart(7)} ${String(f.totalPct).padStart(10)}  ${f.foldsPositive}/${f.foldsTraded}`,
    );
  }

  console.log(`\n${"=".repeat(100)}`);
  console.log(`후행 상한 — 어떤 지표가 잘될지 "미리 알았다면" (실전 도달 불가, 상한 측정용)`);
  console.log(`상위K  구성                                        거래   EV%      t      월복리%   MDD%     최종$`);
  for (const hs of hindsight) {
    const b = hs.best;
    console.log(
      `${String(hs.topK).padStart(4)}   ${hs.families.join(", ").slice(0, 42).padEnd(43)} ${String(hs.raw.n).padStart(5)} ` +
      `${String(hs.raw.ev).padStart(8)} ${String(hs.raw.t).padStart(6)} ` +
      (b ? `${String(b.monthlyGeo).padStart(8)} ${String(b.mddPessimistic).padStart(8)} ${String(b.finalEquity).padStart(9)} (${b.overlay} r${b.riskPct})` : "  — 낙폭 50% 이내 설정 없음"),
    );
  }

  saveOut("wfa.json", {
    generatedAt: Date.now(),
    config: { folds: FOLDS, trainFolds: TRAIN_FOLDS, topN: TOP_N, perFamily: PER_FAMILY, minTrainTrades: MIN_TRAIN_TRADES, risks: RISKS, levCap: LEV_CAP, overlays: OVERLAYS, mddCeilings: MDD_CEILINGS },
    window: { from: tradeFrom, to: tradeTo, days: Math.round((tradeTo - tradeFrom) / 86_400_000) },
    tfStart: Object.fromEntries(TF_LIST.map((tf) => [tf, perTf[tf].edges[TRAIN_FOLDS]])),
    rules: ruleResults.map((r) => ({ ...r, grid: r.grid.map((g) => ({ ...g, monthly: undefined, curve: undefined })) })),
    curves: Object.fromEntries(ruleResults.map((r) => {
      const b = r.best[40] ?? r.best[50] ?? r.best[30] ?? r.best[20];
      return [r.rule, b ? { overlay: b.overlay, riskPct: b.riskPct, curve: b.curve, monthly: b.monthly } : null];
    })),
    familyRanking: famRank,
    hindsight: hindsight.map((h) => ({ ...h, best: h.best ? { ...h.best, monthly: undefined, curve: undefined } : null })),
    // 곡선은 topK별로 전부 남긴다 — 어느 것이 최선인지는 리포트가 정하므로
    // 여기서 하나를 골라 두면 라벨과 곡선이 어긋난다(실제로 어긋났었다).
    hindsightCurves: Object.fromEntries(hindsight.filter((h) => h.best).map((h) => [h.topK, { curve: h.best.curve, monthly: h.best.monthly }])),
    selections,
    buyHold: bh,
    buyHoldCurve: bhCurve,
    buyHoldMdd: bhMdd,
  });
  console.log(`\n저장 → out/wfa.json · ${((Date.now() - t0) / 1000).toFixed(0)}초`);
}

main();
