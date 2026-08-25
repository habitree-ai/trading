/**
 * 비대칭 전용 지표. 기존 tradeStats(승률·PF·t)로는 이번 질문에 답할 수 없다.
 * "손실이 하방에 고정됐는가"와 "수익이 실제로 길게 열렸는가"는 별도로 재야 한다.
 */
import { median, tradeStats } from "../../lib/stats.mjs";

const r2 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

/** 손실 초과 판정 허용폭 — 왕복 비용 0.12%와 갭을 감안한 1.25배. 사전 등록값. */
export const BREACH_TOL = 1.25;

export function asymStats(trades, pnls) {
  const base = tradeStats(pnls);
  if (!base.n) return base;

  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const avgWin = wins.length ? wins.reduce((s, p) => s + p, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, p) => s + p, 0) / losses.length : 0;

  // 꼬리 기여 — 상위 5% 거래가 총이익에서 차지하는 몫. 비대칭 설계의 서명이다.
  const sortedDesc = [...pnls].sort((a, b) => b - a);
  const k = Math.max(1, Math.ceil(base.n * 0.05));
  const gp = wins.reduce((s, p) => s + p, 0);
  const tailSum = sortedDesc.slice(0, k).filter((p) => p > 0).reduce((s, p) => s + p, 0);
  const exTail = sortedDesc.slice(k);
  const evExTail = exTail.length ? exTail.reduce((s, p) => s + p, 0) / exTail.length : null;

  // 1R 정규화 — 손절폭이 거래마다 다르므로 R 단위로 봐야 비교가 된다.
  const rNet = trades.map((t, i) => (t.slPct > 0 ? pnls[i] / t.slPct : 0));
  const breaches = trades.filter((t, i) => pnls[i] < 0 && -pnls[i] > t.slPct * BREACH_TOL).length;
  // 초과의 원인 분해. 비용 탓인지(1R이 비용보다 작아서) 갭·증량 탓인지 나눠야 판정이 된다.
  const breachGross = trades.filter((t) => t.grossPct < 0 && -t.grossPct > t.slPct * 1.02).length;
  const costOverR = trades
    .map((t) => (t.slPct > 0 ? ((0.12 * (t.peakUnits ?? 1)) / t.slPct) * 100 : null))
    .filter((v) => v !== null);
  const worstR = rNet.length ? Math.min(...rNet) : null;
  const bestR = rNet.length ? Math.max(...rNet) : null;

  // MFE 포착률 — 실현손익 ÷ 최대 미실현. 50% 미만이면 진입보다 청산을 고쳐야 한다는 신호.
  const capt = trades
    .map((t, i) => (t.mfePct > 0.05 && pnls[i] > 0 ? (pnls[i] / t.mfePct) * 100 : null))
    .filter((v) => v !== null);

  const m = pnls.reduce((s, p) => s + p, 0) / base.n;
  const sd = base.sd;
  const skew = sd > 0 ? pnls.reduce((s, p) => s + ((p - m) / sd) ** 3, 0) / base.n : null;

  const holds = trades.map((t) => t.holdBars);
  const types = {};
  for (const t of trades) types[t.exitType] = (types[t.exitType] ?? 0) + 1;

  return {
    ...base,
    avgWin: r4(avgWin),
    avgLoss: r4(avgLoss),
    payoff: avgLoss < 0 ? r2(avgWin / Math.abs(avgLoss)) : null,
    tailShare: gp > 0 ? r2((tailSum / gp) * 100) : null,
    evExTail: r4(evExTail),
    tailDependent: evExTail !== null ? evExTail <= 0 : null,
    breachRate: r2((breaches / base.n) * 100),
    breaches,
    breachGrossRate: r2((breachGross / base.n) * 100),
    costOverR: costOverR.length ? r2(median(costOverR)) : null,
    worstR: r2(worstR),
    bestR: r2(bestR),
    captureRate: capt.length ? r2(median(capt)) : null,
    skew: r2(skew),
    holdMed: holds.length ? median(holds) : null,
    holdMax: holds.length ? Math.max(...holds) : null,
    holdAvg: holds.length ? r2(holds.reduce((s, h) => s + h, 0) / holds.length) : null,
    exitTypes: types,
    avgUnits: r2(trades.reduce((s, t) => s + (t.peakUnits ?? 1), 0) / base.n),
  };
}

/** 결정적 표집 — 재현 가능해야 원장으로 쓸 수 있다. */
export function sampleEvenly(arr, max) {
  if (arr.length <= max) return arr.map((v, i) => ({ v, i }));
  const step = arr.length / max;
  const out = [];
  for (let k = 0; k < max; k += 1) {
    const i = Math.min(arr.length - 1, Math.floor(k * step));
    out.push({ v: arr[i], i });
  }
  return out;
}

/** 선형 합동 생성기 — 랜덤 대조군을 재현 가능하게 만든다. */
export function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
