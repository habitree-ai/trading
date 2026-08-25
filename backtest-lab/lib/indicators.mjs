/**
 * 지표 라이브러리 — 전부 O(n), 전부 인덱스 정렬(입력 길이 = 출력 길이).
 *
 * 규약 두 가지만 지킨다.
 *  ① 값이 아직 안 서는 구간은 null. 0이 아니다 — 0은 "계산됐고 값이 0"이다.
 *  ② 어떤 함수도 candles[i] 이후를 보지 않는다. 미래 참조는 여기서 막는다.
 */

/* ---------- 기본 이동 ---------- */

export function sma(v, n) {
  const out = new Array(v.length).fill(null);
  let sum = 0;
  for (let i = 0; i < v.length; i += 1) {
    sum += v[i];
    if (i >= n) sum -= v[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(v, n) {
  const out = new Array(v.length).fill(null);
  if (v.length < n) return out;
  let seed = 0;
  for (let i = 0; i < n; i += 1) seed += v[i];
  out[n - 1] = seed / n;
  const k = 2 / (n + 1);
  for (let i = n; i < v.length; i += 1) out[i] = v[i] * k + out[i - 1] * (1 - k);
  return out;
}

/** Wilder 평활 — RSI·ATR·ADX 계열이 공유한다. */
export function wilder(v, n, from = 1) {
  const out = new Array(v.length).fill(null);
  if (v.length < from + n) return out;
  let sum = 0;
  for (let i = from; i < from + n; i += 1) sum += v[i];
  let val = sum / n;
  out[from + n - 1] = val;
  for (let i = from + n; i < v.length; i += 1) {
    val = (val * (n - 1) + v[i]) / n;
    out[i] = val;
  }
  return out;
}

export function stdev(v, n) {
  const out = new Array(v.length).fill(null);
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < v.length; i += 1) {
    sum += v[i];
    sq += v[i] * v[i];
    if (i >= n) {
      sum -= v[i - n];
      sq -= v[i - n] * v[i - n];
    }
    if (i >= n - 1) {
      const m = sum / n;
      out[i] = Math.sqrt(Math.max(0, sq / n - m * m));
    }
  }
  return out;
}

/** 직전 n봉(현재 봉 제외)의 극값 — 단조 데크로 O(n). 자기 확증을 막으려 현재 봉을 뺀다. */
export function rollingExtreme(v, n, isMax) {
  const out = new Array(v.length).fill(null);
  const dq = [];
  for (let i = 0; i < v.length; i += 1) {
    if (i >= 1) {
      const x = v[i - 1];
      while (dq.length && (isMax ? v[dq[dq.length - 1]] <= x : v[dq[dq.length - 1]] >= x)) dq.pop();
      dq.push(i - 1);
    }
    while (dq.length && dq[0] < i - n) dq.shift();
    if (i >= n) out[i] = v[dq[0]];
  }
  return out;
}

/* ---------- 변동성 ---------- */

export function trueRange(c) {
  const out = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i += 1) {
    out[i] = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
  }
  return out;
}

export function atr(c, n = 14) {
  return wilder(trueRange(c), n, 1);
}

export function bollinger(closes, n = 20, k = 2) {
  const mid = sma(closes, n);
  const sd = stdev(closes, n);
  const up = new Array(closes.length).fill(null);
  const lo = new Array(closes.length).fill(null);
  const width = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i += 1) {
    if (mid[i] === null || sd[i] === null) continue;
    up[i] = mid[i] + k * sd[i];
    lo[i] = mid[i] - k * sd[i];
    width[i] = mid[i] > 0 ? ((up[i] - lo[i]) / mid[i]) * 100 : null;
  }
  return { mid, up, lo, width };
}

export function keltner(c, closes, n = 20, mult = 2) {
  const mid = ema(closes, n);
  const a = atr(c, n);
  const up = new Array(c.length).fill(null);
  const lo = new Array(c.length).fill(null);
  for (let i = 0; i < c.length; i += 1) {
    if (mid[i] === null || a[i] === null) continue;
    up[i] = mid[i] + mult * a[i];
    lo[i] = mid[i] - mult * a[i];
  }
  return { mid, up, lo };
}

/* ---------- 모멘텀 ---------- */

export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= n; i += 1) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) g += ch;
    else l -= ch;
  }
  g /= n;
  l /= n;
  const toRsi = (gg, ll) => (ll === 0 ? (gg === 0 ? 50 : 100) : 100 - 100 / (1 + gg / ll));
  out[n] = toRsi(g, l);
  for (let i = n + 1; i < closes.length; i += 1) {
    const ch = closes[i] - closes[i - 1];
    g = (g * (n - 1) + Math.max(ch, 0)) / n;
    l = (l * (n - 1) + Math.max(-ch, 0)) / n;
    out[i] = toRsi(g, l);
  }
  return out;
}

export function macd(closes, f = 12, s = 26, sig = 9) {
  const ef = ema(closes, f);
  const es = ema(closes, s);
  const line = closes.map((_, i) => (ef[i] !== null && es[i] !== null ? ef[i] - es[i] : null));
  const start = line.findIndex((x) => x !== null);
  const signal = new Array(closes.length).fill(null);
  if (start >= 0) {
    const seg = ema(line.slice(start), sig);
    for (let i = 0; i < seg.length; i += 1) signal[start + i] = seg[i];
  }
  return { line, signal };
}

/** StochRSI — RSI를 다시 스토캐스틱화. K는 3봉 평활, D는 K의 3봉 평활. */
export function stochRsi(closes, n = 14, kSm = 3, dSm = 3) {
  const r = rsi(closes, n);
  const raw = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i += 1) {
    if (r[i] === null || i < n * 2) continue;
    let hi = -Infinity;
    let lo = Infinity;
    let ok = true;
    for (let j = i - n + 1; j <= i; j += 1) {
      if (r[j] === null) { ok = false; break; }
      hi = Math.max(hi, r[j]);
      lo = Math.min(lo, r[j]);
    }
    if (!ok) continue;
    raw[i] = hi === lo ? 50 : ((r[i] - lo) / (hi - lo)) * 100;
  }
  const k = smoothNullable(raw, kSm);
  const d = smoothNullable(k, dSm);
  return { k, d };
}

function smoothNullable(v, n) {
  const out = new Array(v.length).fill(null);
  for (let i = n - 1; i < v.length; i += 1) {
    let sum = 0;
    let ok = true;
    for (let j = i - n + 1; j <= i; j += 1) {
      if (v[j] === null) { ok = false; break; }
      sum += v[j];
    }
    if (ok) out[i] = sum / n;
  }
  return out;
}

export function cci(c, n = 20) {
  const tp = c.map((b) => (b.h + b.l + b.c) / 3);
  const m = sma(tp, n);
  const out = new Array(c.length).fill(null);
  for (let i = n - 1; i < c.length; i += 1) {
    if (m[i] === null) continue;
    let md = 0;
    for (let j = i - n + 1; j <= i; j += 1) md += Math.abs(tp[j] - m[i]);
    md /= n;
    out[i] = md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md);
  }
  return out;
}

/** Williams %R — −100(최저) ~ 0(최고). */
export function williamsR(c, n = 14) {
  const out = new Array(c.length).fill(null);
  for (let i = n - 1; i < c.length; i += 1) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n + 1; j <= i; j += 1) {
      hi = Math.max(hi, c[j].h);
      lo = Math.min(lo, c[j].l);
    }
    out[i] = hi === lo ? -50 : ((hi - c[i].c) / (hi - lo)) * -100;
  }
  return out;
}

export function roc(closes, n = 10) {
  const out = new Array(closes.length).fill(null);
  for (let i = n; i < closes.length; i += 1) {
    out[i] = closes[i - n] === 0 ? null : ((closes[i] - closes[i - n]) / closes[i - n]) * 100;
  }
  return out;
}

/** TSI — 이중 평활 모멘텀. 시그널은 EMA(7). */
export function tsi(closes, long = 25, short = 13, sig = 7) {
  const mom = closes.map((v, i) => (i === 0 ? 0 : v - closes[i - 1]));
  const absMom = mom.map(Math.abs);
  const e1 = emaNullable(ema(mom, long), short);
  const e2 = emaNullable(ema(absMom, long), short);
  const line = closes.map((_, i) => (e1[i] !== null && e2[i] !== null && e2[i] !== 0 ? (e1[i] / e2[i]) * 100 : null));
  const signal = emaNullable(line, sig);
  return { line, signal };
}

function emaNullable(v, n) {
  const start = v.findIndex((x) => x !== null);
  const out = new Array(v.length).fill(null);
  if (start < 0) return out;
  const seg = ema(v.slice(start), n);
  for (let i = 0; i < seg.length; i += 1) out[start + i] = seg[i];
  return out;
}

/** Fisher Transform — 가격을 정규분포에 가깝게 변환. 부호 전환이 신호다. */
export function fisher(c, n = 9) {
  const out = new Array(c.length).fill(null);
  let value = 0;
  let prev = 0;
  for (let i = n - 1; i < c.length; i += 1) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n + 1; j <= i; j += 1) {
      const mp = (c[j].h + c[j].l) / 2;
      hi = Math.max(hi, mp);
      lo = Math.min(lo, mp);
    }
    const mid = (c[i].h + c[i].l) / 2;
    const x = hi === lo ? 0 : (2 * (mid - lo)) / (hi - lo) - 1;
    value = 0.66 * x + 0.67 * value;
    value = Math.max(-0.999, Math.min(0.999, value));
    const f = 0.5 * Math.log((1 + value) / (1 - value)) + 0.5 * prev;
    prev = f;
    out[i] = f;
  }
  return out;
}

/** Ultimate Oscillator — 7·14·28 세 창 가중. */
export function ultOsc(c, s = 7, m = 14, l = 28) {
  const bp = new Array(c.length).fill(0);
  const tr = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i += 1) {
    const trueLow = Math.min(c[i].l, c[i - 1].c);
    const trueHigh = Math.max(c[i].h, c[i - 1].c);
    bp[i] = c[i].c - trueLow;
    tr[i] = trueHigh - trueLow;
  }
  const sum = (v, n, i) => {
    let t = 0;
    for (let j = i - n + 1; j <= i; j += 1) t += v[j];
    return t;
  };
  const out = new Array(c.length).fill(null);
  for (let i = l; i < c.length; i += 1) {
    const t7 = sum(tr, s, i);
    const t14 = sum(tr, m, i);
    const t28 = sum(tr, l, i);
    if (t7 === 0 || t14 === 0 || t28 === 0) continue;
    const a = sum(bp, s, i) / t7;
    const b = sum(bp, m, i) / t14;
    const d = sum(bp, l, i) / t28;
    out[i] = ((4 * a + 2 * b + d) / 7) * 100;
  }
  return out;
}

/* ---------- 추세 ---------- */

/** ADX/DMI — Wilder. 반환은 adx·plusDI·minusDI. */
export function adx(c, n = 14) {
  const len = c.length;
  const plusDM = new Array(len).fill(0);
  const minusDM = new Array(len).fill(0);
  for (let i = 1; i < len; i += 1) {
    const up = c[i].h - c[i - 1].h;
    const down = c[i - 1].l - c[i].l;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const trS = wilder(trueRange(c), n, 1);
  const pS = wilder(plusDM, n, 1);
  const mS = wilder(minusDM, n, 1);
  const plusDI = new Array(len).fill(null);
  const minusDI = new Array(len).fill(null);
  const dx = new Array(len).fill(null);
  for (let i = 0; i < len; i += 1) {
    if (trS[i] === null || trS[i] === 0) continue;
    plusDI[i] = (pS[i] / trS[i]) * 100;
    minusDI[i] = (mS[i] / trS[i]) * 100;
    const den = plusDI[i] + minusDI[i];
    dx[i] = den === 0 ? 0 : (Math.abs(plusDI[i] - minusDI[i]) / den) * 100;
  }
  const start = dx.findIndex((x) => x !== null);
  const adxOut = new Array(len).fill(null);
  if (start >= 0) {
    const seg = wilder(dx.slice(start), n, 0);
    for (let i = 0; i < seg.length; i += 1) adxOut[start + i] = seg[i];
  }
  return { adx: adxOut, plusDI, minusDI };
}

/** Supertrend — dir: +1 상승, −1 하락. 밴드는 표준 잠금 규칙을 따른다. */
export function supertrend(c, n = 10, mult = 3) {
  const a = atr(c, n);
  const dir = new Array(c.length).fill(null);
  const line = new Array(c.length).fill(null);
  let upper = null;
  let lower = null;
  let d = 1;
  for (let i = 0; i < c.length; i += 1) {
    if (a[i] === null) continue;
    const mid = (c[i].h + c[i].l) / 2;
    let bUp = mid + mult * a[i];
    let bLo = mid - mult * a[i];
    if (upper !== null) {
      bUp = bUp < upper || c[i - 1].c > upper ? bUp : upper;
      bLo = bLo > lower || c[i - 1].c < lower ? bLo : lower;
    }
    if (upper === null) d = c[i].c > bUp ? 1 : -1;
    else if (d === 1 && c[i].c < bLo) d = -1;
    else if (d === -1 && c[i].c > bUp) d = 1;
    upper = bUp;
    lower = bLo;
    dir[i] = d;
    line[i] = d === 1 ? bLo : bUp;
  }
  return { dir, line };
}

/** Parabolic SAR — dir: +1 상승, −1 하락. */
export function psar(c, step = 0.02, max = 0.2) {
  const dir = new Array(c.length).fill(null);
  const sar = new Array(c.length).fill(null);
  if (c.length < 3) return { dir, sar };
  let d = c[1].c > c[0].c ? 1 : -1;
  let af = step;
  let ep = d === 1 ? c[1].h : c[1].l;
  let s = d === 1 ? c[0].l : c[0].h;
  for (let i = 2; i < c.length; i += 1) {
    s += af * (ep - s);
    if (d === 1) {
      s = Math.min(s, c[i - 1].l, c[i - 2].l);
      if (c[i].l < s) {
        d = -1;
        s = ep;
        ep = c[i].l;
        af = step;
      } else if (c[i].h > ep) {
        ep = c[i].h;
        af = Math.min(max, af + step);
      }
    } else {
      s = Math.max(s, c[i - 1].h, c[i - 2].h);
      if (c[i].h > s) {
        d = 1;
        s = ep;
        ep = c[i].h;
        af = step;
      } else if (c[i].l < ep) {
        ep = c[i].l;
        af = Math.min(max, af + step);
      }
    }
    dir[i] = d;
    sar[i] = s;
  }
  return { dir, sar };
}

/**
 * Ichimoku — 전환·기준·선행A/B.
 * 구름은 26봉 앞으로 밀려 그려지지만, 판정 시점 i에서 쓰는 구름은
 * 26봉 전에 계산된 값이다. 미래 참조가 아니다.
 */
export function ichimoku(c, tenkanN = 9, kijunN = 26, senkouN = 52, shift = 26) {
  const len = c.length;
  const hl = (n, i) => {
    if (i < n - 1) return null;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n + 1; j <= i; j += 1) {
      hi = Math.max(hi, c[j].h);
      lo = Math.min(lo, c[j].l);
    }
    return (hi + lo) / 2;
  };
  const tenkan = new Array(len).fill(null);
  const kijun = new Array(len).fill(null);
  const spanA = new Array(len).fill(null);
  const spanB = new Array(len).fill(null);
  for (let i = 0; i < len; i += 1) {
    tenkan[i] = hl(tenkanN, i);
    kijun[i] = hl(kijunN, i);
  }
  for (let i = 0; i < len; i += 1) {
    const src = i - shift;
    if (src < 0) continue;
    spanA[i] = tenkan[src] !== null && kijun[src] !== null ? (tenkan[src] + kijun[src]) / 2 : null;
    spanB[i] = hl(senkouN, src);
  }
  return { tenkan, kijun, spanA, spanB };
}

export function aroon(c, n = 25) {
  const up = new Array(c.length).fill(null);
  const down = new Array(c.length).fill(null);
  for (let i = n; i < c.length; i += 1) {
    let hiIdx = i;
    let loIdx = i;
    for (let j = i - n; j <= i; j += 1) {
      if (c[j].h >= c[hiIdx].h) hiIdx = j;
      if (c[j].l <= c[loIdx].l) loIdx = j;
    }
    up[i] = ((n - (i - hiIdx)) / n) * 100;
    down[i] = ((n - (i - loIdx)) / n) * 100;
  }
  return { up, down };
}

/** Vortex — VI+ / VI−. 교차가 추세 전환 신호. */
export function vortex(c, n = 14) {
  const len = c.length;
  const vmP = new Array(len).fill(0);
  const vmM = new Array(len).fill(0);
  const tr = trueRange(c);
  for (let i = 1; i < len; i += 1) {
    vmP[i] = Math.abs(c[i].h - c[i - 1].l);
    vmM[i] = Math.abs(c[i].l - c[i - 1].h);
  }
  const plus = new Array(len).fill(null);
  const minus = new Array(len).fill(null);
  for (let i = n; i < len; i += 1) {
    let sp = 0;
    let sm = 0;
    let st = 0;
    for (let j = i - n + 1; j <= i; j += 1) {
      sp += vmP[j];
      sm += vmM[j];
      st += tr[j];
    }
    if (st === 0) continue;
    plus[i] = sp / st;
    minus[i] = sm / st;
  }
  return { plus, minus };
}

/* ---------- 거래량 ---------- */

export function obv(c) {
  const out = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i += 1) {
    const d = c[i].c > c[i - 1].c ? 1 : c[i].c < c[i - 1].c ? -1 : 0;
    out[i] = out[i - 1] + d * c[i].v;
  }
  return out;
}

export function mfi(c, n = 14) {
  const out = new Array(c.length).fill(null);
  const tp = c.map((b) => (b.h + b.l + b.c) / 3);
  for (let i = n; i < c.length; i += 1) {
    let pos = 0;
    let neg = 0;
    for (let j = i - n + 1; j <= i; j += 1) {
      const flow = tp[j] * c[j].v;
      if (tp[j] > tp[j - 1]) pos += flow;
      else if (tp[j] < tp[j - 1]) neg += flow;
    }
    out[i] = neg === 0 ? (pos === 0 ? 50 : 100) : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

/** Chaikin Money Flow — 봉 내 종가 위치 × 거래량의 n봉 합. */
export function cmf(c, n = 20) {
  const out = new Array(c.length).fill(null);
  const mfv = c.map((b) => {
    const range = b.h - b.l;
    return range === 0 ? 0 : (((b.c - b.l) - (b.h - b.c)) / range) * b.v;
  });
  let sv = 0;
  let sf = 0;
  for (let i = 0; i < c.length; i += 1) {
    sv += c[i].v;
    sf += mfv[i];
    if (i >= n) {
      sv -= c[i - n].v;
      sf -= mfv[i - n];
    }
    if (i >= n - 1) out[i] = sv === 0 ? 0 : sf / sv;
  }
  return out;
}

/** 롤링 VWAP — 세션 리셋 대신 n봉 창. 24시간 시장이라 세션 경계가 임의적이다. */
export function rollingVwap(c, n) {
  const out = new Array(c.length).fill(null);
  let pv = 0;
  let vv = 0;
  for (let i = 0; i < c.length; i += 1) {
    const tp = (c[i].h + c[i].l + c[i].c) / 3;
    pv += tp * c[i].v;
    vv += c[i].v;
    if (i >= n) {
      const j = i - n;
      const tj = (c[j].h + c[j].l + c[j].c) / 3;
      pv -= tj * c[j].v;
      vv -= c[j].v;
    }
    if (i >= n - 1) out[i] = vv === 0 ? null : pv / vv;
  }
  return out;
}

/** 롤링 z-스코어 — 창 [i−n+1, i], 현재 봉 포함(BB 관례와 동일). */
export function rollingZ(v, n) {
  const m = sma(v, n);
  const s = stdev(v, n);
  const out = new Array(v.length).fill(null);
  for (let i = 0; i < v.length; i += 1) {
    if (m[i] === null || s[i] === null || s[i] === 0) continue;
    out[i] = (v[i] - m[i]) / s[i];
  }
  return out;
}

/** 하위봉 i → 그 시점에 이미 마감된 상위봉 인덱스. 마감 전 봉을 보면 미래 참조다. */
export function htfIndexMap(candles, htf, htfMs) {
  const out = new Array(candles.length).fill(-1);
  let d = -1;
  for (let i = 0; i < candles.length; i += 1) {
    while (d + 1 < htf.length && htf[d + 1].t + htfMs <= candles[i].t) d += 1;
    out[i] = d;
  }
  return out;
}
