/**
 * 복리 장부 — 부품 거래 스트림 + 자금 기법 → 자산 곡선.
 *
 * lib/portfolio.mjs 의 회계 규약을 그대로 따르되(레버리지 두 갈래, 증거금은 거래소
 * 상한으로, 청산은 MAE 로 판정), 세 가지를 더 다룬다:
 *   ① 사이징이 플러그인이다 — 8종을 같은 장부에 꽂아 비교한다.
 *   ② 포트폴리오 히트 상한 — 동시에 열린 리스크의 합에 뚜껑을 씌운다.
 *   ③ 상태 조회 — 켈리·변동성·패리티가 "그 시점까지 닫힌 거래"만 보도록 한다.
 *
 * 미래 참조 방지가 이 파일의 존재 이유다. 사이징 함수는 state 를 통해서만 과거를
 * 볼 수 있고, state 는 **청산 시각이 지난 거래만** 담는다.
 */
import { cagrPct, maxDrawdownPct, median, monthlyReturns, percentile } from "../../lib/stats.mjs";

export const START = 100;
export const MAINT_PCT = 0.5;
export const COST_ROUNDTRIP = 0.12; // 테이커 0.10 + 슬리피지 0.02

const r2 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

function sdOf(arr, min = 8) {
  if (arr.length < min) return null;
  const m = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

/**
 * @param trades 부품 전체를 합쳐 시간순 정렬 전 배열. {part, side, entryAt, exitAt, slPct, maePct, net}
 * @param opts   { method, riskPct, levCap, maxConcurrent, heatCap, from, to }
 */
export function runBook(trades, opts) {
  const { method, riskPct, levCap, maxConcurrent = 3, heatCap = null, from, to } = opts;
  const evs = trades
    .filter((t) => t.entryAt >= from && t.exitAt <= to)
    .sort((a, b) => a.entryAt - b.entryAt || a.exitAt - b.exitAt);

  let equity = START;
  let peak = START;
  const open = [];
  const curve = [{ t: from, equity }];
  const stepReturns = [];
  const closedR = [];              // 책 전체의 R 배수 이력(시간순)
  const closedByPart = new Map();  // 부품별 R 배수 이력
  let mddPess = 0;
  let liquidations = 0;
  let taken = 0;
  let skipConcurrent = 0;
  let skipMargin = 0;
  let skipHeat = 0;
  let skipZeroSize = 0;
  let levSum = 0;
  let riskSum = 0;

  const pushClosed = (p) => {
    closedR.push(p.rMult);
    if (!closedByPart.has(p.part)) closedByPart.set(p.part, []);
    closedByPart.get(p.part).push(p.rMult);
    stepReturns.push(p.stepRet);
  };

  const settleUntil = (ts) => {
    open.sort((a, b) => a.exitAt - b.exitAt);
    while (open.length && open[0].exitAt <= ts) {
      const p = open.shift();
      equity += p.pnlAbs;
      if (equity < 0) equity = 0;
      peak = Math.max(peak, equity);
      curve.push({ t: p.exitAt, equity });
      pushClosed(p);
    }
  };

  const tail = (arr, n) => (arr.length > n ? arr.slice(arr.length - n) : arr.slice());
  const state = {
    start: START,
    get equity() { return equity; },
    get peak() { return peak; },
    recentReturns: (n) => tail(stepReturns, n),
    partR: (part, n) => tail(closedByPart.get(part) ?? [], n),
    partReturns: (part, n) => tail(closedByPart.get(part) ?? [], n),
    avgPartVol: () => {
      const vs = [];
      for (const arr of closedByPart.values()) {
        const v = sdOf(tail(arr, 40));
        if (v !== null && v > 0) vs.push(v);
      }
      return vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : null;
    },
  };

  for (const e of evs) {
    settleUntil(e.entryAt);
    if (equity <= 1) break; // 사실상 파산 — 더 볼 것이 없다.

    if (open.length >= maxConcurrent) { skipConcurrent += 1; continue; }

    const riskEff = method.fn(state, riskPct, e);
    if (!(riskEff > 0)) { skipZeroSize += 1; continue; }

    // 포트폴리오 히트 — 지금 열린 모든 포지션이 동시에 손절될 때의 총 리스크.
    if (heatCap !== null) {
      const heat = open.reduce((s, p) => s + p.riskPct, 0);
      if (heat + riskEff > heatCap) { skipHeat += 1; continue; }
    }

    const denom = e.slPct + COST_ROUNDTRIP;
    if (!(denom > 0)) continue;
    const levEff = Math.min(levCap, riskEff / denom);
    if (!(levEff > 0)) { skipZeroSize += 1; continue; }

    const notional = equity * levEff;
    const margin = notional / levCap;
    const used = open.reduce((s, p) => s + p.margin, 0);
    const room = Math.max(0, equity - used);
    if (room <= equity * 0.02) { skipMargin += 1; continue; }
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

    // 보수 낙폭 — 이 거래가 최악으로 갔을 때의 자산을 그 시점까지의 고점과 비교.
    const worst = equity - Math.min(marginEff, (notionalEff * e.maePct) / 100);
    if (peak > 0) mddPess = Math.min(mddPess, ((worst - peak) / peak) * 100);

    open.push({
      exitAt: e.exitAt,
      part: e.part,
      margin: marginEff,
      pnlAbs,
      riskPct: riskEff * scale,
      rMult: e.slPct > 0 ? e.net / e.slPct : 0,
      stepRet: (pnlAbs / equity) * 100,
    });
    levSum += levEff * scale;
    riskSum += riskEff * scale;
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
  const nMonths = days / 30.4375;
  const monthlyGeo = equity > 0 && nMonths > 0 ? (Math.pow(equity / START, 1 / nMonths) - 1) * 100 : null;

  // 최장 수중 기간 — 고점 회복까지 걸린 최대 일수. 낙폭 깊이만큼이나 견디기 어려운 값이다.
  let underwaterMax = 0;
  let peakT = curve[0].t;
  let peakE = curve[0].equity;
  for (const p of curve) {
    if (p.equity >= peakE) { peakE = p.equity; peakT = p.t; }
    else underwaterMax = Math.max(underwaterMax, (p.t - peakT) / 86_400_000);
  }

  return {
    finalEquity: r2(equity),
    cagr,
    monthlyGeo: r2(monthlyGeo),
    mdd: mddRealized,
    mddPessimistic: r2(mddFinal),
    mar: cagr !== null && mddFinal < 0 ? r2(cagr / Math.abs(mddFinal)) : null,
    underwaterMaxDays: Math.round(underwaterMax),
    avgLeverage: taken ? r2(levSum / taken) : null,
    avgRiskPct: taken ? r4(riskSum / taken) : null,
    months: monthsArr.length,
    monthlyMedian: r2(median(rets)),
    monthlyP10: r2(percentile(rets, 10)),
    monthlyP90: r2(percentile(rets, 90)),
    monthWinRate: r2((rets.filter((x) => x > 0).length / Math.max(1, rets.length)) * 100),
    trades: taken,
    tradesPerMonth: r2(taken / Math.max(1, monthsArr.length)),
    liquidations,
    skipConcurrent,
    skipMargin,
    skipHeat,
    skipZeroSize,
    stepReturns,
    monthly: monthsArr,
    curve: curve.filter((_, i) => i % Math.max(1, Math.ceil(curve.length / 500)) === 0 || i === curve.length - 1),
    curvePoints: curve.length,
  };
}
