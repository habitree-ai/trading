/**
 * P4·P5 — 레버리지 · 병행 복리 · 월수익 프런티어.
 *
 * P3에서 사전 등록 게이트 6/6 통과가 0개였다. 그래서 이 단계는
 * "생존자로 포트폴리오를 만든다"가 아니라 **상한을 재는 것**이 목적이다.
 *
 *  바스켓 A (인샘플 상한) — 전체 창 t 상위. 결과를 보고 고른 것이므로
 *    실전 기대값이 아니다. "가장 잘 봐줘도 여기까지"의 천장이다.
 *  바스켓 B (정직한 워크포워드) — IS(앞 65%)만 보고 고른 뒤 OOS(뒤 35%)에서만 평가.
 *    이쪽이 실전에 가까운 추정치다.
 *
 * 두 바스켓 모두 월 10%에 못 미치면, 미달 폭이 이 회차의 답이다.
 */
import { TFS, saveOut } from "./lib/data.mjs";
import { EXITS, FAMILIES, FILTERS } from "./lib/signals.mjs";
import {
  blockBootstrap, cagrPct, maxDrawdownPct, median, monthlyReturns, percentile, r2, tradeStats,
} from "./lib/stats.mjs";
import { loadOut } from "./lib/data.mjs";
import { TF_LIST, buildTfContext, loadAll, parseComboKey, runCombo } from "./lib/runner.mjs";

const START = 100;
const MAINT_PCT = 0.5; // 유지증거금 — 청산 임계 = 100/L − 0.5
const MAX_CONCURRENT = 3;
const BASKET_SIZE = 8;
const RISKS = [1, 2, 3, 5, 7, 10, 15, 20, 30];
const LEV_CAPS = [3, 5, 10, 20];
const OVERLAYS = ["base", "throttle", "regime", "both"];
const TARGETS = [3, 5, 10];

/* ---------- 바스켓 구성 ---------- */

/**
 * 다양성 상한을 건 상위 선별.
 * 같은 계열 3개를 담으면 분산이 아니라 같은 베팅의 3배다.
 */
function pickBasket(rows, scoreOf, sampleOf, { size = BASKET_SIZE, perFamily = 2, perTf = 4 } = {}) {
  const famCount = {};
  const tfCount = {};
  const picked = [];
  for (const r of [...rows].sort((a, b) => scoreOf(b) - scoreOf(a))) {
    if (picked.length >= size) break;
    if (scoreOf(r) <= 0) break;
    if ((famCount[r.famKey] ?? 0) >= perFamily) continue;
    if ((tfCount[r.tf] ?? 0) >= perTf) continue;
    famCount[r.famKey] = (famCount[r.famKey] ?? 0) + 1;
    tfCount[r.tf] = (tfCount[r.tf] ?? 0) + 1;
    picked.push(r);
  }
  return picked;
}

/* ---------- 병행 복리 회계 ---------- */

/**
 * 진입 시점의 실현 잔고로 사이징한다. 미실현을 포함하면 아직 없는 돈에 베팅하는 것이다.
 *
 * 레버리지를 두 가지로 나눈다 — 이걸 섞으면 회계가 조용히 틀린다.
 *   실효 레버리지 Leff = 명목/자산 = riskPct / (손절폭% + 비용%)   ← 얼마나 크게 베팅하는가
 *   거래소 레버리지 Lex = levCap                                  ← 증거금을 얼마나 적게 걸 수 있는가
 * 증거금 = 명목 / Lex 이므로 Lex가 클수록 같은 베팅에 자본이 덜 묶이고 동시 보유가 는다.
 * 청산 임계 = 100/Lex − 유지증거금 — 손절보다 먼저 걸리는 경우는 갭뿐이다.
 */
function runPortfolio(members, { riskPct, levCap, overlay, from, to, regimeOf }) {
  const events = [];
  for (const m of members) {
    for (const t of m.trades) {
      if (t.exitAt < from || t.entryAt > to) continue;
      events.push({ ...t, memberKey: m.key, net: m.netOf(t) });
    }
  }
  events.sort((a, b) => a.entryAt - b.entryAt);

  const useThrottle = overlay === "throttle" || overlay === "both";
  const useRegime = overlay === "regime" || overlay === "both";

  let equity = START;
  let peak = START;
  const open = []; // {exitAt, margin, pnlAbs}
  const curve = [{ t: from, equity }];
  const stepReturns = []; // 거래별 자산 대비 손익 % — 부트스트랩은 이걸 재표집해야 한다.
  let mddPess = 0;
  let liquidations = 0;
  let skippedConcurrent = 0;
  let skippedRegime = 0;
  let skippedMargin = 0;
  let taken = 0;
  let levSum = 0;

  const settleUntil = (ts) => {
    open.sort((a, b) => a.exitAt - b.exitAt);
    while (open.length && open[0].exitAt <= ts) {
      const p = open.shift();
      equity += p.pnlAbs;
      if (equity < 0) equity = 0;
      peak = Math.max(peak, equity);
      curve.push({ t: p.exitAt, equity });
    }
  };

  for (const e of events) {
    settleUntil(e.entryAt);
    if (equity <= 1) break; // 사실상 파산 — 더 볼 것이 없다.

    if (useRegime) {
      const up = regimeOf(e.entryAt);
      if (up === null || (e.side === "long" ? up !== true : up !== false)) {
        skippedRegime += 1;
        continue;
      }
    }
    if (open.length >= MAX_CONCURRENT) {
      skippedConcurrent += 1;
      continue;
    }

    // 드로다운 스로틀 — 실현 낙폭에 비례해 리스크 축소(하한 25%).
    const throttle = useThrottle ? Math.max(0.25, Math.min(1, equity / peak)) : 1;
    const riskEff = riskPct * throttle;

    const denom = e.slPct + 0.12; // 손절폭 + 수수료·슬리피지
    if (!(denom > 0)) continue;
    const levEff = Math.min(levCap, riskEff / denom); // 베팅 크기
    if (!(levEff > 0)) continue;

    const notional = equity * levEff;
    const margin = notional / levCap; // 거래소 최대 레버리지로 걸어 증거금을 최소화
    const usedMargin = open.reduce((s, p) => s + p.margin, 0);
    const room = Math.max(0, equity - usedMargin);
    if (room <= equity * 0.02) {
      skippedMargin += 1;
      continue;
    }
    const scale = Math.min(1, room / margin);
    const notionalEff = notional * scale;
    const marginEff = margin * scale;

    const liqThr = 100 / levCap - MAINT_PCT;
    let pnlAbs;
    if (e.maePct >= liqThr) {
      pnlAbs = -marginEff; // 증거금 소각 — 격리이므로 손실은 여기서 멈춘다.
      liquidations += 1;
    } else {
      pnlAbs = (notionalEff * e.net) / 100;
      if (pnlAbs < -marginEff) pnlAbs = -marginEff;
    }

    // 보수 낙폭 — 이 거래가 최악으로 갔을 때의 자산을 "그 시점까지의" 고점과 비교한다.
    // 전체 창의 고점과 비교하면 아직 오지도 않은 고점 대비 낙폭을 세게 된다.
    const worst = equity - Math.min(marginEff, (notionalEff * e.maePct) / 100);
    if (peak > 0) mddPess = Math.min(mddPess, ((worst - peak) / peak) * 100);

    stepReturns.push((pnlAbs / equity) * 100);
    levSum += levEff * scale;
    open.push({ exitAt: e.exitAt, margin: marginEff, pnlAbs });
    taken += 1;
  }
  settleUntil(Infinity);
  curve.push({ t: to, equity });
  curve.sort((a, b) => a.t - b.t);

  const days = (to - from) / 86_400_000;
  const months = monthlyReturns(curve);
  const rets = months.map((m) => m.ret).filter((x) => x !== null);
  const mddRealized = maxDrawdownPct(curve);
  const mddFinal = Math.min(mddRealized ?? 0, mddPess); // 실현 낙폭과 미실현 최악 중 나쁜 쪽

  const cagr = cagrPct(START, equity, days);
  return {
    finalEquity: r2(equity),
    cagr,
    mdd: mddRealized,
    mddPessimistic: r2(mddFinal),
    mar: cagr !== null && mddFinal < 0 ? r2(cagr / Math.abs(mddFinal)) : null,
    avgLeverage: taken ? r2(levSum / taken) : null,
    stepReturns,
    months: months.length,
    monthlyMedian: r2(median(rets)),
    monthlyP25: r2(percentile(rets, 25)),
    monthlyP75: r2(percentile(rets, 75)),
    hitRate10: r2((rets.filter((x) => x >= 10).length / Math.max(1, rets.length)) * 100),
    hitRate5: r2((rets.filter((x) => x >= 5).length / Math.max(1, rets.length)) * 100),
    hitRate3: r2((rets.filter((x) => x >= 3).length / Math.max(1, rets.length)) * 100),
    trades: taken,
    tradesPerMonth: r2(taken / Math.max(1, months.length)),
    liquidations,
    skippedConcurrent,
    skippedMargin,
    skippedRegime,
    monthly: months,
    curve: curve.filter((_, i) => i % Math.max(1, Math.ceil(curve.length / 600)) === 0 || i === curve.length - 1),
    curvePoints: curve.length,
  };
}

/* ---------- 실행 ---------- */

function main() {
  const sweep = loadOut("sweep.json");
  const { data, fundingCum } = loadAll();

  // 후보 풀 — 표본(G1) · 기대값(G2) · 구간안정(G4)은 최소한 만족해야 담는다.
  // G3/G5/G6까지 요구하면 0개다(P3의 결론). 여기서는 상한을 재는 것이 목적이므로
  // 완화 조건을 쓰되, 그것이 완화라는 사실을 리포트에 그대로 싣는다.
  const pool = sweep.rows.filter((r) => r.n > 0 && r.gates.g1 && r.gates.g2 && r.gates.g4);
  const poolIs = sweep.rows.filter(
    (r) => r.n > 0 && r.is && r.is.n >= Math.round(sweep.config.sampleMin[r.tf] * 0.65) && r.is.ev > 0,
  );

  const basketA = pickBasket(pool, (r) => r.t, (r) => r.n);
  const basketB = pickBasket(poolIs, (r) => r.is.t, (r) => r.is.n);

  console.log(`후보 풀: 전체창 ${pool.length}개 · IS기준 ${poolIs.length}개`);
  console.log(`\n바스켓 A (인샘플 상한 — 전체 창 t 상위):`);
  for (const r of basketA) console.log(`  ${r.tf.padEnd(4)} ${r.famKey.padEnd(17)} ${r.side.padEnd(5)} ${r.filterKey} ${r.exitKey}  n=${String(r.n).padStart(4)} EV=${String(r.ev).padStart(7)}% PF=${String(r.pf).padStart(5)} t=${r.t}`);
  console.log(`\n바스켓 B (IS 선별 → OOS 평가):`);
  for (const r of basketB) console.log(`  ${r.tf.padEnd(4)} ${r.famKey.padEnd(17)} ${r.side.padEnd(5)} ${r.filterKey} ${r.exitKey}  IS n=${String(r.is.n).padStart(4)} EV=${String(r.is.ev).padStart(7)}% t=${String(r.is.t).padStart(5)} → OOS n=${String(r.oos.n).padStart(4)} EV=${r.oos.ev}`);

  // 거래 되살리기 — sweep은 요약만 남겼다.
  const ctxCache = {};
  const materialize = (rows) =>
    rows.map((r) => {
      ctxCache[r.tf] ??= buildTfContext(data, r.tf);
      const { trades, pnls } = runCombo({
        ctx: ctxCache[r.tf], candles: data[r.tf], tf: r.tf,
        famKey: r.famKey, side: r.side, filterKey: r.filterKey, exitKey: r.exitKey, fundingCum,
      });
      const netMap = new Map(trades.map((t, i) => [`${t.entryAt}`, pnls[i]]));
      return { key: r.key, row: r, trades, netOf: (t) => netMap.get(`${t.entryAt}`) ?? 0 };
    });

  const memA = materialize(basketA);
  const memB = materialize(basketB);

  // 레짐 게이트용 일봉 SMA200 — 마감 완료된 일봉만 본다.
  const d1 = data["1D"];
  const d1Closes = d1.map((b) => b.c);
  const d1Sma = [];
  {
    let sum = 0;
    for (let i = 0; i < d1Closes.length; i += 1) {
      sum += d1Closes[i];
      if (i >= 200) sum -= d1Closes[i - 200];
      d1Sma[i] = i >= 199 ? sum / 200 : null;
    }
  }
  const regimeOf = (ts) => {
    let j = -1;
    for (let i = 0; i < d1.length; i += 1) {
      if (d1[i].t + TFS["1D"].ms <= ts) j = i;
      else break;
    }
    if (j < 0 || d1Sma[j] === null) return null;
    return d1[j].c > d1Sma[j];
  };

  const windowOf = (members) => {
    const starts = members.map((m) => (m.trades.length ? m.trades[0].entryAt : Infinity));
    const ends = members.map((m) => (m.trades.length ? m.trades[m.trades.length - 1].exitAt : -Infinity));
    return { from: Math.max(...starts), to: Math.min(...ends) };
  };

  const winA = windowOf(memA);
  const isCutOf = (tf) => {
    const c = data[tf];
    const s = c[300].t;
    const e = c[c.length - 1].t;
    return s + (e - s) * sweep.config.isFraction;
  };
  // 바스켓 B는 OOS 구간에서만 평가한다 — 가장 늦은 IS 컷 이후.
  const oosFrom = Math.max(...memB.map((m) => isCutOf(m.row.tf)));
  const winB = { from: oosFrom, to: windowOf(memB).to };

  const runGrid = (members, win, label) => {
    const out = [];
    for (const overlay of OVERLAYS) {
      for (const levCap of LEV_CAPS) {
        for (const riskPct of RISKS) {
          const res = runPortfolio(members, { riskPct, levCap, overlay, from: win.from, to: win.to, regimeOf });
          out.push({ basket: label, overlay, levCap, riskPct, ...res });
        }
      }
    }
    return out;
  };

  console.log(`\n포트폴리오 그리드 실행 — ${OVERLAYS.length}×${LEV_CAPS.length}×${RISKS.length} = ${OVERLAYS.length * LEV_CAPS.length * RISKS.length} 설정 × 2 바스켓`);
  const gridA = runGrid(memA, winA, "A");
  const gridB = runGrid(memB, winB, "B");

  /* ---------- 게이트 판정 ---------- */

  // 파산확률은 그 설정에서 실제로 난 거래별 자산 수익률을 재표집해야 한다.
  // 1× 손익을 재표집하면 리스크 30% 설정의 파산확률이 리스크 1%와 같아진다 — 무의미하다.
  const judge = (g) => {
    const boot = blockBootstrap(g.stepReturns);
    const c1 = g.monthlyMedian !== null && g.monthlyMedian >= 10;
    const c2 = g.hitRate10 >= 50;
    const c3 = g.mddPessimistic !== null && g.mddPessimistic >= -50;
    const c4 = g.liquidations === 0;
    const c5 = boot ? boot.ruinPct <= 5 : false;
    return { c1, c2, c3, c4, c5, passed: [c1, c2, c3, c4, c5].filter(Boolean).length, boot };
  };

  for (const g of gridA) {
    g.gates = judge(g);
    delete g.stepReturns;
  }
  for (const g of gridB) {
    g.gates = judge(g);
    delete g.stepReturns;
  }

  /* ---------- 목표 역산 ---------- */

  /**
   * 월 X%가 되려면 무엇이 더 필요한가.
   * 월수익 ≈ (월 거래수) × ln(1 + L × EV/100) 이므로, 관측 EV·빈도에서
   * 목표를 만족하는 레버리지를 역산한다. 그리고 그 레버리지의 낙폭을 함께 본다.
   */
  const requirement = (members, win, target, takenPerMonth) => {
    const days = (win.to - win.from) / 86_400_000;
    const months = days / 30.44;
    const all = [];
    for (const m of members) {
      for (const t of m.trades) {
        if (t.exitAt < win.from || t.entryAt > win.to) continue;
        all.push(m.netOf(t));
      }
    }
    if (!all.length || months <= 0) return null;
    const st = tradeStats(all);
    // 실제로 체결된 빈도를 쓴다 — 신호 전부를 잡을 수 있다고 가정하면 답이 낙관으로 기운다.
    const perMonth = takenPerMonth ?? all.length / months;
    const needLogPerTrade = Math.log(1 + target / 100) / perMonth;
    const needRetPerTrade = (Math.exp(needLogPerTrade) - 1) * 100;
    const needLev = st.ev > 0 ? needRetPerTrade / st.ev : null;
    // 필요한 엣지가 통계적으로 얼마나 큰 주장인지 — 같은 표본·같은 변동성에서
    // EV가 needRetPerTrade 였다면 t는 얼마였을까. 관측 t와 비교하면 격차가 보인다.
    const impliedT = st.sd > 0 ? (needRetPerTrade / st.sd) * Math.sqrt(st.n) : null;

    return {
      target,
      tradesPerMonth: r2(perMonth),
      signalsPerMonth: r2(all.length / months),
      observedEvPct: st.ev,
      observedN: st.n,
      observedT: st.t,
      observedSd: st.sd,
      requiredReturnPerTradePct: r2(needRetPerTrade),
      requiredEdgeMultiple: st.ev > 0 ? r2(needRetPerTrade / st.ev) : null,
      requiredT: impliedT === null ? null : r2(impliedT),
      requiredLeverage: needLev === null ? null : r2(needLev),
      // 그 레버리지에서 한 번의 최악 역행이 자산에 미치는 영향.
      worstMaePct: r2(Math.max(...members.flatMap((m) => m.trades.map((t) => t.maePct)))),
      liquidationAtLev: needLev ? r2(100 / needLev - MAINT_PCT) : null,
    };
  };

  const takenA = median(gridA.map((g) => g.tradesPerMonth));
  const takenB = median(gridB.map((g) => g.tradesPerMonth));
  const reqA = TARGETS.map((t) => requirement(memA, winA, t, takenA));
  const reqB = TARGETS.map((t) => requirement(memB, winB, t, takenB));

  /* ---------- 보고 ---------- */

  const show = (grid, label, win) => {
    console.log(`\n${"=".repeat(96)}`);
    console.log(`바스켓 ${label} — ${new Date(win.from).toISOString().slice(0, 10)} → ${new Date(win.to).toISOString().slice(0, 10)} (${Math.round((win.to - win.from) / 86_400_000)}일)`);
    const best = [...grid].sort((a, b) => (b.monthlyMedian ?? -99) - (a.monthlyMedian ?? -99)).slice(0, 12);
    console.log(`오버레이  cap  risk   최종$    CAGR%    MDD보수%   MAR   월중앙%  월≥10%  월≥5%  거래/월  청산`);
    for (const g of best) {
      console.log(
        `${g.overlay.padEnd(9)} ${String(g.levCap).padStart(3)} ${String(g.riskPct).padStart(5)}  ` +
          `${String(g.finalEquity).padStart(9)} ${String(g.cagr).padStart(8)} ${String(g.mddPessimistic).padStart(9)} ` +
          `${String(g.mar ?? "—").padStart(6)} ${String(g.monthlyMedian).padStart(8)} ${String(g.hitRate10).padStart(7)} ` +
          `${String(g.hitRate5).padStart(6)} ${String(g.tradesPerMonth).padStart(8)} ${String(g.liquidations).padStart(5)}`,
      );
    }
    const passers = grid.filter((g) => g.gates.passed === 5);
    console.log(`\nC1~C5 전부 통과: ${passers.length}개`);
    const bestC = [...grid].sort((a, b) => b.gates.passed - a.gates.passed || (b.monthlyMedian ?? -99) - (a.monthlyMedian ?? -99))[0];
    console.log(`최다 통과 설정: ${bestC.overlay} cap${bestC.levCap} risk${bestC.riskPct} → ${bestC.gates.passed}/5 (월중앙 ${bestC.monthlyMedian}% · MDD ${bestC.mddPessimistic}% · 청산 ${bestC.liquidations} · 파산확률 ${bestC.gates.boot?.ruinPct}%)`);
  };

  show(gridA, "A (인샘플 상한)", winA);
  show(gridB, "B (워크포워드 OOS)", winB);

  console.log(`\n${"=".repeat(96)}\n목표 역산 — 관측 엣지로 목표를 채우려면 레버리지가 얼마여야 하는가`);
  for (const [label, reqs] of [["A", reqA], ["B", reqB]]) {
    for (const q of reqs) {
      if (!q) continue;
      console.log(
        `  [${label}] 월 ${q.target}% ← 체결 ${q.tradesPerMonth}회/월(신호 ${q.signalsPerMonth}) · 관측 EV ${q.observedEvPct}%(n=${q.observedN}, t=${q.observedT}) · ` +
          `거래당 필요 ${q.requiredReturnPerTradePct}% → 필요 실효레버리지 ${q.requiredLeverage ?? "불가(EV≤0)"}× ` +
          `(관측 최악 역행 ${q.worstMaePct}%)`,
      );
    }
  }

  saveOut("frontier.json", {
    generatedAt: Date.now(),
    config: { start: START, maintPct: MAINT_PCT, maxConcurrent: MAX_CONCURRENT, basketSize: BASKET_SIZE, risks: RISKS, levCaps: LEV_CAPS, overlays: OVERLAYS, targets: TARGETS },
    poolSizes: { full: pool.length, is: poolIs.length },
    basketA: basketA.map((r) => ({ key: r.key, tf: r.tf, famKey: r.famKey, famName: FAMILIES[r.famKey].name, side: r.side, filterKey: r.filterKey, filterName: FILTERS[r.filterKey].name, exitKey: r.exitKey, exitName: EXITS.find((e) => e.key === r.exitKey).name, n: r.n, ev: r.ev, pf: r.pf, t: r.t, oos: r.oos, gates: r.gates })),
    basketB: basketB.map((r) => ({ key: r.key, tf: r.tf, famKey: r.famKey, famName: FAMILIES[r.famKey].name, side: r.side, filterKey: r.filterKey, filterName: FILTERS[r.filterKey].name, exitKey: r.exitKey, exitName: EXITS.find((e) => e.key === r.exitKey).name, n: r.n, ev: r.ev, pf: r.pf, t: r.t, is: r.is, oos: r.oos, gates: r.gates })),
    windows: {
      A: { from: winA.from, to: winA.to, days: Math.round((winA.to - winA.from) / 86_400_000) },
      B: { from: winB.from, to: winB.to, days: Math.round((winB.to - winB.from) / 86_400_000) },
    },
    gridA,
    gridB,
    requirements: { A: reqA, B: reqB },
  });
  console.log(`\n저장 → out/frontier.json`);
}

main();
