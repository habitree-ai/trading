/**
 * 병행 포트폴리오 회계 — frontier.mjs 와 wfa.mjs 가 공유한다.
 *
 * 레버리지를 두 가지로 나눈다. 섞으면 회계가 조용히 틀린다.
 *   실효 레버리지 Leff = 명목/자산 = riskPct / (손절폭% + 비용%)   ← 얼마나 크게 베팅하는가
 *   거래소 레버리지 Lex = levCap                                  ← 증거금을 얼마나 적게 걸 수 있는가
 * 증거금 = 명목 / Lex. 청산 임계 = 100/Lex − 유지증거금.
 *
 * 사이징은 진입 시점의 **실현** 잔고로 한다. 미실현을 포함하면 아직 없는 돈에 베팅하는 것이다.
 */
import { cagrPct, maxDrawdownPct, median, monthlyReturns, percentile, r2 } from "./stats.mjs";

export const START = 100;
export const MAINT_PCT = 0.5;
export const MAX_CONCURRENT = 3;
export const COST_ROUNDTRIP = 0.12; // 테이커 0.10 + 슬리피지 0.02

/**
 * @param events 시간순 정렬 전 거래 배열. 각 원소에 {entryAt, exitAt, side, slPct, maePct, net} 필요.
 *               net 은 이미 비용·펀딩이 반영된 1× 순손익 %.
 */
export function runPortfolio(events, { riskPct, levCap, overlay = "base", from, to, regimeOf, maxConcurrent = MAX_CONCURRENT }) {
  const evs = events.filter((e) => e.exitAt >= from && e.entryAt <= to).sort((a, b) => a.entryAt - b.entryAt);

  const useThrottle = overlay === "throttle" || overlay === "both";
  const useRegime = overlay === "regime" || overlay === "both";

  let equity = START;
  let peak = START;
  const open = [];
  const curve = [{ t: from, equity }];
  const stepReturns = []; // 거래별 자산 대비 손익 % — 파산확률은 이걸 재표집해야 뜻이 있다.
  let mddPess = 0;
  let liquidations = 0;
  let skippedConcurrent = 0;
  let skippedMargin = 0;
  let skippedRegime = 0;
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

  for (const e of evs) {
    settleUntil(e.entryAt);
    if (equity <= 1) break; // 사실상 파산 — 더 볼 것이 없다.

    if (useRegime && regimeOf) {
      const up = regimeOf(e.entryAt);
      if (up === null || (e.side === "long" ? up !== true : up !== false)) {
        skippedRegime += 1;
        continue;
      }
    }
    if (open.length >= maxConcurrent) {
      skippedConcurrent += 1;
      continue;
    }

    // 드로다운 스로틀 — 실현 낙폭에 비례해 리스크 축소(하한 25%).
    const throttle = useThrottle ? Math.max(0.25, Math.min(1, equity / peak)) : 1;
    const riskEff = riskPct * throttle;

    const denom = e.slPct + COST_ROUNDTRIP;
    if (!(denom > 0)) continue;
    const levEff = Math.min(levCap, riskEff / denom);
    if (!(levEff > 0)) continue;

    const notional = equity * levEff;
    const margin = notional / levCap;
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
      pnlAbs = -marginEff; // 격리 증거금 소각
      liquidations += 1;
    } else {
      pnlAbs = (notionalEff * e.net) / 100;
      if (pnlAbs < -marginEff) pnlAbs = -marginEff;
    }

    // 보수 낙폭 — 이 거래가 최악으로 갔을 때의 자산을 "그 시점까지의" 고점과 비교한다.
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
  const monthsArr = monthlyReturns(curve);
  const rets = monthsArr.map((m) => m.ret).filter((x) => x !== null);
  const mddRealized = maxDrawdownPct(curve);
  const mddFinal = Math.min(mddRealized ?? 0, mddPess);
  const cagr = cagrPct(START, equity, days);

  // 사용자가 묻는 "월 복리수익률"은 이것이다 — 중앙값이 아니라 기하평균.
  // 중앙값은 큰 손실 한 번을 못 본다. 복리 결과를 정하는 것은 기하평균이다.
  const nMonths = days / 30.4375;
  const monthlyGeo = equity > 0 && nMonths > 0 ? (Math.pow(equity / START, 1 / nMonths) - 1) * 100 : null;

  return {
    finalEquity: r2(equity),
    cagr,
    monthlyGeo: r2(monthlyGeo),
    mdd: mddRealized,
    mddPessimistic: r2(mddFinal),
    mar: cagr !== null && mddFinal < 0 ? r2(cagr / Math.abs(mddFinal)) : null,
    avgLeverage: taken ? r2(levSum / taken) : null,
    stepReturns,
    months: monthsArr.length,
    monthlyMedian: r2(median(rets)),
    monthlyP25: r2(percentile(rets, 25)),
    monthlyP75: r2(percentile(rets, 75)),
    hitRate10: r2((rets.filter((x) => x >= 10).length / Math.max(1, rets.length)) * 100),
    hitRate5: r2((rets.filter((x) => x >= 5).length / Math.max(1, rets.length)) * 100),
    hitRate3: r2((rets.filter((x) => x >= 3).length / Math.max(1, rets.length)) * 100),
    trades: taken,
    tradesPerMonth: r2(taken / Math.max(1, monthsArr.length)),
    liquidations,
    skippedConcurrent,
    skippedMargin,
    skippedRegime,
    monthly: monthsArr,
    curve: curve.filter((_, i) => i % Math.max(1, Math.ceil(curve.length / 600)) === 0 || i === curve.length - 1),
    curvePoints: curve.length,
  };
}
