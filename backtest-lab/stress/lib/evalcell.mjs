/**
 * 칸 하나를 재는 함수 — 창 확장 · 워크포워드 · 스트레스가 **같은 회계**를 쓰도록 여기 모은다.
 * 세 곳이 각자 계산하면 숫자가 어긋나고, 어긋난 줄도 모르게 된다.
 *
 * 게이트 C1~C6 은 14회차 사전 등록 그대로다. 이번 회차는 게이트를 바꾸지 않고
 * **창과 절차만** 바꿔 같은 잣대로 다시 잰다.
 */
import { blockBootstrap } from "../../lib/stats.mjs";
import { runBook, START } from "../../compound/lib/book.mjs";
import { METHODS } from "../../compound/lib/sizing.mjs";

export const BOOT = { blocks: 20, runs: 1000, start: START, ruinAt: 10, seed: 20260818 };

/** 창 3등분 각 구간의 월 기하수익 — C6. */
export function thirdsGeo(curve, from, to) {
  const w = (to - from) / 3;
  const bounds = [from, from + w, from + 2 * w, to];
  const eqAt = (ts) => { let last = curve[0].equity; for (const p of curve) { if (p.t > ts) break; last = p.equity; } return last; };
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    const a = eqAt(bounds[i]);
    const b = eqAt(bounds[i + 1]);
    const m = (bounds[i + 1] - bounds[i]) / 86_400_000 / 30.4375;
    out.push(a > 0 && b > 0 && m > 0 ? Math.round((Math.pow(b / a, 1 / m) - 1) * 1e4) / 100 : null);
  }
  return out;
}

/**
 * @param opts { trades, methodKey, levCap, riskPct, maxConcurrent, heatCap, from, to, benchMonthlyGeo, boot }
 *   boot=false 면 부트스트랩을 건너뛴다 — 워크포워드 학습 구간처럼 만 번 도는 곳에서 쓴다.
 */
export function evalCell({ trades, methodKey, levCap, riskPct, maxConcurrent = 3, heatCap = null, from, to, benchMonthlyGeo, boot = true }) {
  const r = runBook(trades, { method: METHODS[methodKey], riskPct, levCap, maxConcurrent, heatCap, from, to });
  const b = boot && r.stepReturns.length >= 60 ? blockBootstrap(r.stepReturns, BOOT) : null;
  const thirds = thirdsGeo(r.curve, from, to);
  const row = {
    method: methodKey, levCap, riskPct, maxConcurrent, heatCap,
    trades: r.trades, tradesPerMonth: r.tradesPerMonth, finalEquity: r.finalEquity,
    cagr: r.cagr, monthlyGeo: r.monthlyGeo, mdd: r.mddPessimistic, mar: r.mar,
    underwaterMaxDays: r.underwaterMaxDays, monthWinRate: r.monthWinRate,
    monthlyMedian: r.monthlyMedian, monthlyP10: r.monthlyP10,
    avgLeverage: r.avgLeverage, avgRiskPct: r.avgRiskPct,
    liquidations: r.liquidations, skipMargin: r.skipMargin, skipConcurrent: r.skipConcurrent,
    ruin: b ? b.ruinPct : null, bootP05: b ? b.p05 : null, bootP50: b ? b.p50 : null,
    thirds,
  };
  row.c1 = r.liquidations === 0;
  row.c2 = b ? b.ruinPct <= 1 : null;
  row.c3 = row.mdd !== null && row.mdd >= -40;
  row.c4 = row.mar !== null && row.mar >= 1.0;
  row.c5 = row.monthlyGeo !== null && row.monthlyGeo > 0 && (benchMonthlyGeo === undefined || row.monthlyGeo > benchMonthlyGeo);
  row.c6 = thirds.every((x) => x !== null && x > 0);
  row.gates = ["c1", "c2", "c3", "c4", "c5", "c6"].filter((g) => row[g] === true).length;
  row.pass = row.gates === 6;
  return { row, curve: r.curve, monthly: r.monthly, stepReturns: r.stepReturns };
}

/** 매수보유 — 같은 창, 무레버리지. 4H 종가 기준. */
export function buyHold(c4, from, to) {
  const seg = c4.filter((b) => b.t >= from && b.t <= to);
  if (seg.length < 2) return null;
  const base = seg[0].o;
  const days = (to - from) / 86_400_000;
  const months = days / 30.4375;
  let peak = 0, mdd = 0;
  for (const b of seg) { peak = Math.max(peak, b.c); mdd = Math.min(mdd, ((b.c - peak) / peak) * 100); }
  const last = seg[seg.length - 1].c;
  return {
    totalPct: Math.round(((last - base) / base) * 1e4) / 100,
    monthlyGeo: Math.round((Math.pow(last / base, 1 / months) - 1) * 1e4) / 100,
    cagr: Math.round((Math.pow(last / base, 365 / days) - 1) * 1e4) / 100,
    mdd: Math.round(mdd * 100) / 100,
    days: Math.round(days),
    curve: seg.filter((_, i) => i % Math.max(1, Math.ceil(seg.length / 400)) === 0 || i === seg.length - 1)
      .map((b) => ({ t: b.t, equity: Math.round((b.c / base) * 10000) / 100 })),
  };
}
