/**
 * MTF 방향 판정 — oneway-ta htfAlign 과 동일한 부등식.
 * 각 봉 독립 + 하위봉→상위봉 인덱스 매핑 (미래 참조 없음).
 */
import { C } from "../../scripts/backtest/lib/oneway-core.mjs";

function ema(rows, period) {
  const n = rows.length;
  const out = new Float32Array(n);
  let e = rows[0][C];
  const k = 2 / (period + 1);
  for (let i = 0; i < n; i += 1) {
    e = i === 0 ? rows[0][C] : rows[i][C] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** 단일 TF 전체 방향 배열 — 1=상승, -1=하락, 0=혼조 */
export function computeDirection(rows) {
  const n = rows.length;
  const out = new Int8Array(n);
  if (n < 60) return out;
  const e20 = ema(rows, 20);
  const e50 = ema(rows, 50);
  for (let i = 0; i < n; i += 1) {
    const up = e20[i] > e50[i] && rows[i][C] > e20[i];
    const dn = e20[i] < e50[i] && rows[i][C] < e20[i];
    out[i] = up ? 1 : dn ? -1 : 0;
  }
  return out;
}

/**
 * 하위봉 i → 그 시점에 이미 마감된 상위봉 인덱스.
 * 상위봉 마감 시각(t_open + htfMs) <= 하위봉 시작(t) 인 것만.
 */
export function htfIndexMap(baseRows, htfRows, htfMs) {
  const n = baseRows.length;
  const out = new Int32Array(n).fill(-1);
  if (!htfRows?.length) return out;
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    const t = baseRows[i][0];
    while (j + 1 < htfRows.length && htfRows[j + 1][0] + htfMs <= t) j += 1;
    if (htfRows[j][0] + htfMs <= t) out[i] = j;
  }
  return out;
}

/** 하위봉 각 인덱스에서 상위봉 방향을 매핑 */
export function mapDirection(baseRows, htfRows, htfDir, htfMs) {
  const n = baseRows.length;
  const out = new Int8Array(n);
  const idx = htfIndexMap(baseRows, htfRows, htfMs);
  for (let i = 0; i < n; i += 1) {
    const j = idx[i];
    out[i] = j >= 0 ? htfDir[j] : 0;
  }
  return out;
}
