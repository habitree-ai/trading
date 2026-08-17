/**
 * 지표 계산 — 백테스트 시리즈와 동일한 Wilder 계산식.
 *
 * 이 파일은 scripts/backtest/portfolio-sim.mjs 와 값이 일치해야 한다.
 * 화면(앱)·백테스트·봇이 다른 값을 보면 "그때 지표가 이랬다"는 말이 무너진다.
 */

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) gain += ch;
    else loss -= ch;
  }
  gain /= period;
  loss /= period;
  const toRsi = (g, l) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[period] = toRsi(gain, loss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const ch = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(ch, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = toRsi(gain, loss);
  }
  return out;
}

export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = (i) =>
    Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c),
    );
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr(i);
  let value = sum / period;
  out[period] = value;
  for (let i = period + 1; i < candles.length; i += 1) {
    value = (value * (period - 1) + tr(i)) / period;
    out[i] = value;
  }
  return out;
}

export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** EMA — SMA 시드 후 지수 갱신. scripts/backtest/ten-strategies.mjs 와 같은 계산. */
export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  let seed = 0;
  for (let i = 0; i < n; i += 1) seed += values[i];
  out[n - 1] = seed / n;
  const k = 2 / (n + 1);
  for (let i = n; i < values.length; i += 1) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/** MACD(12,26,9) — 시그널은 MACD가 서는 지점부터의 EMA. 기획 10선 검증 회차와 동일. */
export function macd(closes, fast = 12, slow = 26, sig = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const line = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null,
  );
  const start = line.findIndex((v) => v !== null);
  const signal = new Array(closes.length).fill(null);
  if (start >= 0) {
    const seg = ema(line.slice(start), sig);
    for (let i = 0; i < seg.length; i += 1) signal[start + i] = seg[i];
  }
  return { line, signal };
}

/**
 * 결측 건너뛰는 롤링 z-스코어 — 베이시스(스왑−현물 괴리) 표준화용.
 * 창 [i-win+1, i](현재 포함), 유효 표본 90% 미만이면 null. 백테스트(short-tf.mjs)와 동일 수식.
 */
export function rollingZ(vals, win) {
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  let sq = 0;
  let valid = 0;
  for (let i = 0; i < vals.length; i += 1) {
    const v = vals[i];
    if (v !== null) {
      sum += v;
      sq += v * v;
      valid += 1;
    }
    const j = i - win;
    if (j >= 0 && vals[j] !== null) {
      sum -= vals[j];
      sq -= vals[j] * vals[j];
      valid -= 1;
    }
    if (i >= win - 1 && valid >= win * 0.9 && vals[i] !== null) {
      const mean = sum / valid;
      const sd = Math.sqrt(Math.max(0, sq / valid - mean * mean));
      out[i] = sd > 0 ? (vals[i] - mean) / sd : null;
    }
  }
  return out;
}

/** 스왑·현물 캔들(같은 t 격자)에서 베이시스 % 시계열 — 현물 봉이 없으면 null. */
export function basisSeries(swapCandles, spotCandles) {
  const spotByT = new Map(spotCandles.map((c) => [c.t, c.c]));
  return swapCandles.map((c) => {
    const s = spotByT.get(c.t);
    return s ? Math.round(((c.c / s - 1) * 100) * 10000) / 10000 : null;
  });
}

/** 직전 n봉(현재 봉 제외)의 평균 거래량 — 거래량 확장 판정용. */
export function volMA(candles, n = 20) {
  const out = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    if (i >= n) out[i] = sum / n;
    sum += candles[i].v;
    if (i >= n) sum -= candles[i - n].v;
  }
  return out;
}

/** 직전 n봉(현재 봉 제외)의 최저가 — 신저가 이탈 판정용. */
export function rollingLow(candles, n) {
  const out = new Array(candles.length).fill(null);
  for (let i = n; i < candles.length; i += 1) {
    let best = candles[i - n].l;
    for (let k = i - n + 1; k < i; k += 1) {
      if (candles[k].l < best) best = candles[k].l;
    }
    out[i] = best;
  }
  return out;
}
