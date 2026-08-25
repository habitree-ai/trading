/**
 * 통계 — 판정에 쓰이는 수치만. 예쁜 지표는 넣지 않는다.
 *
 * 이 회차에서 가장 중요한 함수는 benjaminiHochberg 다.
 * 4,464개를 훑고 나서 t=2.5 하나를 들고 "찾았다"고 말하면 그건 발견이 아니라
 * 우연을 세는 데 실패한 것이다.
 */

export const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
export const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);

export function mean(v) {
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
}

export function stdevSample(v) {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

/** 표준정규 누적분포 — Abramowitz-Stegun 7.1.26 오차함수 근사. */
export function normCdf(z) {
  const s = z < 0 ? -1 : 1;
  const a = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return 0.5 * (1 + s * y);
}

/** 양측 p — 표본이 크므로 t를 정규로 근사한다(n>100에서 차이는 무시할 수준). */
export function twoSidedP(t) {
  return 2 * (1 - normCdf(Math.abs(t)));
}

/**
 * 단측 p (H1: EV > 0).
 * 우리가 찾는 것은 "0이 아닌 전략"이 아니라 "돈을 버는 전략"이다.
 * 양측 p를 쓰면 크게 잃는 조합이 p<0.05 로 "유의"해져 FDR 예산을 먹는다.
 */
export function oneSidedP(t) {
  return 1 - normCdf(t);
}

export function wilsonLow(wins, n, z = 1.96) {
  if (!n) return null;
  const p = wins / n;
  const den = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return ((center - margin) / den) * 100;
}

/** 거래 순손익(%) 배열 → 판정 수치 묶음. */
export function tradeStats(pnls) {
  const n = pnls.length;
  if (!n) return { n: 0 };
  const wins = pnls.filter((p) => p > 0);
  const gp = wins.reduce((s, p) => s + p, 0);
  const gl = pnls.filter((p) => p <= 0).reduce((s, p) => s + p, 0);
  const m = mean(pnls);
  const sd = stdevSample(pnls);
  const t = sd > 0 ? (m / sd) * Math.sqrt(n) : 0;

  let eq = 0;
  let peak = 0;
  let mdd = 0;
  for (const p of pnls) {
    eq += p;
    peak = Math.max(peak, eq);
    mdd = Math.min(mdd, eq - peak);
  }

  return {
    n,
    winRate: r2((wins.length / n) * 100),
    wilsonLow: r2(wilsonLow(wins.length, n)),
    ev: r4(m),
    sd: r4(sd),
    pf: gl === 0 ? (gp > 0 ? 99 : 0) : r2(gp / Math.abs(gl)),
    t: r2(t),
    p: r4(oneSidedP(t)), // 판정용 — 단측(H1: EV>0)
    p2: r4(twoSidedP(t)), // 참고용 — 양측

    totalPct: r2(eq),
    mddR: r2(mdd),
  };
}

/** 창 3등분 — 시간 기준. 구간별 합계 부호가 안정성 게이트(G4). */
export function splitThirds(trades, pnls, tStart, tEnd) {
  const w = (tEnd - tStart) / 3;
  const sums = [0, 0, 0];
  const counts = [0, 0, 0];
  for (let i = 0; i < trades.length; i += 1) {
    const k = Math.min(2, Math.max(0, Math.floor((trades[i].exitAt - tStart) / w)));
    sums[k] += pnls[i];
    counts[k] += 1;
  }
  return { sums: sums.map(r2), counts, positive: sums.filter((s) => s > 0).length };
}

/**
 * Benjamini–Hochberg FDR.
 * p를 오름차순 정렬하고 p_(k) ≤ k/m·q 를 만족하는 최대 k까지 기각.
 * Bonferroni(q/m)보다 검정력이 높으면서 거짓발견 비율을 q로 통제한다.
 */
export function benjaminiHochberg(items, q = 0.1) {
  const m = items.length;
  if (!m) return { rejected: new Set(), threshold: 0, m };
  const sorted = items.map((it, i) => ({ i, p: it.p ?? 1 })).sort((a, b) => a.p - b.p);
  let kMax = 0;
  for (let k = 1; k <= m; k += 1) {
    if (sorted[k - 1].p <= (k / m) * q) kMax = k;
  }
  const rejected = new Set();
  for (let k = 0; k < kMax; k += 1) rejected.add(sorted[k].i);
  return { rejected, threshold: kMax ? sorted[kMax - 1].p : 0, m, kMax };
}

/** 전수 규모에서 귀무 하 |t| 최대 기댓값 — 게이트 눈높이의 참고선. */
export function nullMaxT(m) {
  return m > 1 ? Math.sqrt(2 * Math.log(m)) : 0;
}

/* ---------- 복리 회계 ---------- */

/** 월별 수익률 — 잔고 시계열(정렬된 {t, equity})에서 월말 대비. */
export function monthlyReturns(curve) {
  if (curve.length < 2) return [];
  const byMonth = new Map();
  for (const pt of curve) {
    const d = new Date(pt.t);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    byMonth.set(key, pt.equity);
  }
  const keys = [...byMonth.keys()].sort();
  const out = [];
  let prev = curve[0].equity;
  for (const k of keys) {
    const end = byMonth.get(k);
    if (prev > 0) out.push({ month: k, ret: r2(((end - prev) / prev) * 100), equity: r2(end) });
    prev = end;
  }
  return out;
}

export function median(v) {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function percentile(v, p) {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * s.length)));
  return s[idx];
}

/** 봉 단위 최대낙폭 % — 거래 단위 MDD보다 항상 나쁘고, 그래서 이쪽이 정직하다. */
export function maxDrawdownPct(curve) {
  let peak = -Infinity;
  let mdd = 0;
  for (const pt of curve) {
    peak = Math.max(peak, pt.equity);
    if (peak > 0) mdd = Math.min(mdd, ((pt.equity - peak) / peak) * 100);
  }
  return r2(mdd);
}

export function cagrPct(start, end, days) {
  if (start <= 0 || end <= 0 || days <= 0) return null;
  return r2((Math.pow(end / start, 365 / days) - 1) * 100);
}

/**
 * 블록 부트스트랩 — 거래 순서를 블록 단위로 재표집.
 * 개별 거래를 섞으면 연속 손실(군집성)이 사라져 파산확률을 과소평가한다.
 */
export function blockBootstrap(pnls, { blocks = 20, runs = 1000, start = 100, ruinAt = 10, seed = 12345 } = {}) {
  const n = pnls.length;
  if (n < blocks * 2) return null;
  const blockLen = Math.max(1, Math.floor(n / blocks));
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const finals = [];
  let ruined = 0;
  for (let run = 0; run < runs; run += 1) {
    let eq = start;
    let dead = false;
    for (let b = 0; b < blocks; b += 1) {
      const from = Math.floor(rnd() * (n - blockLen));
      for (let k = 0; k < blockLen; k += 1) {
        eq *= 1 + pnls[from + k] / 100;
        if (eq <= ruinAt) {
          dead = true;
          break;
        }
      }
      if (dead) break;
    }
    if (dead) ruined += 1;
    finals.push(Math.max(eq, 0));
  }
  finals.sort((a, b) => a - b);
  return {
    runs,
    ruinPct: r2((ruined / runs) * 100),
    p05: r2(percentile(finals, 5)),
    p20: r2(percentile(finals, 20)),
    p50: r2(percentile(finals, 50)),
    p80: r2(percentile(finals, 80)),
  };
}
