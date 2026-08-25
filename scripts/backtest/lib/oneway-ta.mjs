/**
 * ONEWAY 지표 — leg 가 시작된 그 봉에서 차트가 어떤 모습이었나를 숫자로 남긴다.
 *
 * 목적이 매매 신호가 아니라 기술(記述)이므로 지표는 널리 쓰이는 표준형만 쓴다.
 * 백분위 계열(밴드폭·ATR)은 값 자체가 아니라 "그 시점 기준 최근 200봉 안에서 어디였나"로
 * 담는다 — 2020년 7천 달러와 2026년 6만 달러의 절대 변동폭은 비교되지 않는다.
 *
 * 전부 Float32Array — 5m 69만 봉을 객체 배열로 들면 메모리가 기가 단위로 간다.
 */
import { C, H, L, O, T, V } from "./oneway-core.mjs";

export const WARMUP = 260; // SMA200 + 밴드폭 백분위(200) 가 서는 자리

function ema(rows, period) {
  const n = rows.length;
  const out = new Float32Array(n);
  const k = 2 / (period + 1);
  let e = rows[0][C];
  for (let i = 0; i < n; i += 1) {
    e = i === 0 ? rows[0][C] : rows[i][C] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function rsi(rows, period = 14) {
  const n = rows.length;
  const out = new Float32Array(n);
  let avgU = 0, avgD = 0;
  for (let i = 1; i < n; i += 1) {
    const d = rows[i][C] - rows[i - 1][C];
    const u = d > 0 ? d : 0;
    const dn = d < 0 ? -d : 0;
    if (i <= period) {
      avgU += u / period; avgD += dn / period;
      out[i] = 50;
    } else {
      avgU = (avgU * (period - 1) + u) / period;
      avgD = (avgD * (period - 1) + dn) / period;
      out[i] = avgD === 0 ? 100 : 100 - 100 / (1 + avgU / avgD);
    }
  }
  out[0] = 50;
  return out;
}

function atr(rows, period = 14) {
  const n = rows.length;
  const out = new Float32Array(n);
  let a = 0;
  for (let i = 0; i < n; i += 1) {
    const tr = i === 0
      ? rows[0][H] - rows[0][L]
      : Math.max(rows[i][H] - rows[i][L], Math.abs(rows[i][H] - rows[i - 1][C]), Math.abs(rows[i][L] - rows[i - 1][C]));
    a = i === 0 ? tr : (a * (period - 1) + tr) / period;
    out[i] = a;
  }
  return out;
}

/** 볼린저 — %b(밴드 안 위치)와 밴드폭(가격 대비 %). 표준편차는 롤링 합으로 O(N). */
function bollinger(rows, period = 20, mult = 2) {
  const n = rows.length;
  const pb = new Float32Array(n);
  const bw = new Float32Array(n);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    const c = rows[i][C];
    sum += c; sumSq += c * c;
    if (i >= period) { const o = rows[i - period][C]; sum -= o; sumSq -= o * o; }
    const cnt = Math.min(i + 1, period);
    const mean = sum / cnt;
    const varr = Math.max(0, sumSq / cnt - mean * mean);
    const sd = Math.sqrt(varr);
    const up = mean + mult * sd, lo = mean - mult * sd;
    pb[i] = up === lo ? 0.5 : (c - lo) / (up - lo);
    bw[i] = (up - lo) / mean * 100;
  }
  return { pb, bw };
}

/**
 * 롤링 백분위 — 현재 값이 직전 look 봉 안에서 몇 %ile 인가.
 *
 * 정확한 순위는 O(N·look) 라 5m 69만 봉에서 무겁다. 여기서는 값을 200칸 히스토그램으로
 * 눌러 O(N·bins) 로 센다. 0~1 사이 상대순위만 쓰므로 이 정도 해상도면 충분하다.
 */
function rollingPct(src, look) {
  const n = src.length;
  const out = new Float32Array(n);
  const BINS = 256;
  // 전 구간 분포로 bin 경계를 잡는다 — 값의 스케일이 구간마다 달라도 순위는 유지된다.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i += 1) { const v = src[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  const bin = (v) => Math.min(BINS - 1, Math.max(0, Math.floor(((v - lo) / span) * BINS)));
  const hist = new Int32Array(BINS);
  let filled = 0;
  for (let i = 0; i < n; i += 1) {
    if (i >= look) { hist[bin(src[i - look])] -= 1; filled -= 1; }
    const b = bin(src[i]);
    let below = 0;
    for (let k = 0; k < b; k += 1) below += hist[k];
    out[i] = filled > 0 ? below / filled : 0.5;
    hist[b] += 1; filled += 1;
  }
  return out;
}

/** 직전 look 봉의 고·저 채널 안에서 종가 위치 (0=저점, 1=고점). */
function donchianPos(rows, look) {
  const n = rows.length;
  const out = new Float32Array(n);
  // 단조 덱으로 O(N) 슬라이딩 최대·최소.
  const maxD = [], minD = [];
  for (let i = 0; i < n; i += 1) {
    while (maxD.length && rows[maxD[maxD.length - 1]][H] <= rows[i][H]) maxD.pop();
    maxD.push(i);
    while (minD.length && rows[minD[minD.length - 1]][L] >= rows[i][L]) minD.pop();
    minD.push(i);
    while (maxD[0] <= i - look) maxD.shift();
    while (minD[0] <= i - look) minD.shift();
    const hh = rows[maxD[0]][H], ll = rows[minD[0]][L];
    out[i] = hh === ll ? 0.5 : (rows[i][C] - ll) / (hh - ll);
  }
  return out;
}

/** 거래량 / 직전 look 봉 평균 거래량. */
function volRatio(rows, look = 20) {
  const n = rows.length;
  const out = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += rows[i][V];
    if (i >= look) sum -= rows[i - look][V];
    const cnt = Math.min(i + 1, look);
    const avg = sum / cnt;
    out[i] = avg > 0 ? rows[i][V] / avg : 1;
  }
  return out;
}

/**
 * 상위봉 방향을 하위봉 인덱스에 매핑한다.
 *
 * 미래 참조를 막기 위해 상위봉은 "이미 닫힌 것"만 쓴다 — 하위봉 시각 t 에서는
 * t 보다 앞서 시작하고 이미 마감된 상위봉의 값을 본다.
 */
function htfAlign(rows, htfRows, htfMs) {
  const n = rows.length;
  const out = new Int8Array(n); // 1=상승정렬, -1=하락정렬, 0=혼조
  if (!htfRows || htfRows.length < 60) return out;
  const e20 = ema(htfRows, 20), e50 = ema(htfRows, 50);
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    const t = rows[i][T];
    // 마감 시각(t_open + htfMs) 이 현재 봉 시작보다 이른 마지막 상위봉
    while (j + 1 < htfRows.length && htfRows[j + 1][T] + htfMs <= t) j += 1;
    if (htfRows[j][T] + htfMs > t) { out[i] = 0; continue; }
    const up = e20[j] > e50[j] && htfRows[j][C] > e20[j];
    const dn = e20[j] < e50[j] && htfRows[j][C] < e20[j];
    out[i] = up ? 1 : dn ? -1 : 0;
  }
  return out;
}

/** KST 기준 시(0~23)와 요일(0=일). UTC+9 고정 — 한국 거래자의 하루가 기준이다. */
function clock(rows) {
  const n = rows.length;
  const hour = new Int8Array(n);
  const dow = new Int8Array(n);
  for (let i = 0; i < n; i += 1) {
    const kst = rows[i][T] + 9 * 3600_000;
    hour[i] = Math.floor(kst / 3600_000) % 24;
    dow[i] = Math.floor(kst / 86_400_000 + 4) % 7; // 1970-01-01 = 목요일
  }
  return { hour, dow };
}

export function computeTa(rows, htf) {
  const { pb, bw } = bollinger(rows);
  const a = atr(rows);
  const n = rows.length;
  const atrPct = new Float32Array(n);
  for (let i = 0; i < n; i += 1) atrPct[i] = (a[i] / rows[i][C]) * 100;

  const e20 = ema(rows, 20), e50 = ema(rows, 50), e200 = ema(rows, 200);
  const distE200 = new Float32Array(n);
  const stack = new Int8Array(n); // 1=정배열 2=역배열 0=혼조
  const body = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    distE200[i] = ((rows[i][C] - e200[i]) / e200[i]) * 100;
    stack[i] = e20[i] > e50[i] && e50[i] > e200[i] ? 1 : e20[i] < e50[i] && e50[i] < e200[i] ? -1 : 0;
    const range = rows[i][H] - rows[i][L];
    body[i] = range > 0 ? ((rows[i][C] - rows[i][O]) / range) * 100 : 0;
  }

  const { hour, dow } = clock(rows);
  return {
    rsi: rsi(rows),
    bbPb: pb,
    bbW: bw,
    bbWPct: rollingPct(bw, 200),
    atrPct,
    atrPctile: rollingPct(atrPct, 200),
    e20, e50, e200,
    distE200,
    stack,
    body,
    volR: volRatio(rows),
    dcPos: donchianPos(rows, 96),
    h4: htfAlign(rows, htf?.h4, 4 * 3600_000),
    d1: htfAlign(rows, htf?.d1, 86_400_000),
    hour, dow,
  };
}
