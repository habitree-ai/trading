/**
 * BTC 시스템트레이딩 기획 10선 검증 — 4봉(15m·1H·4H·1D) × 손익비 4단계 × 레버리지 4단계.
 *
 * 역할 분담: 이 스크립트가 모든 수치를 결정적으로 계산한다. 에이전트는 실행·해석만 한다.
 * 손익비(청산 구조)가 바뀌면 거래 자체가 달라지므로 손익비 4단계는 각각 재시뮬레이션하고,
 * 레버리지는 같은 거래 목록에 분석적으로 적용한다(수수료 비례 확대 + 갭 청산 체크).
 *
 * 사용:
 *   node scripts/backtest/ten-strategies.mjs fetch
 *     → 캔들 수집: scripts/backtest/.cache/ten-candles.json (봉별 최대 히스토리)
 *   node scripts/backtest/ten-strategies.mjs run --strategy <key>
 *   node scripts/backtest/ten-strategies.mjs run --all
 *     → 전략 정의: scripts/backtest/ten-strategies.config.json
 *     → 결과: docs/backtest/ten/<key>.json (전략당 1개)
 *   node scripts/backtest/ten-strategies.mjs merge
 *     → 종합: docs/backtest/<KST 오늘>-ten-strategies.json
 *       (docs/backtest/ten/review.json 이 있으면 에이전트 분석·기획서를 review로 포함)
 *   node scripts/backtest/ten-strategies.mjs report
 *     → 최신 *-ten-strategies.json + ten-strategies-template.html
 *       → docs/backtest/ten-strategies-report.html (항상 같은 파일 — 아티팩트 URL 유지)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://www.okx.com/api/v5";
const INST = "BTC-USDT-SWAP";
const PAGE = 100;
const FEE_PCT = 0.1; // 왕복 (수수료+슬리피지), 명목 기준 — 레버리지에 비례 확대된다.
const WARMUP = 220; // SMA200 + 여유 — 모든 신호가 같은 출발선.
const MAINT_PCT = 0.5; // 유지증거금 가정 — 청산 문턱 = 100/L − 0.5 (%).
const LEVERS = [1, 2, 5, 10, 20]; // 1×는 무레버리지 기준선 — 복리 생존의 바닥값.
const START_EQ = 100;
const RUIN_EQ = 1; // $100 → $1 미만이면 파산으로 본다.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = join(repoRoot, "scripts", "backtest", ".cache", "ten-candles.json");
const CONFIG = join(repoRoot, "scripts", "backtest", "ten-strategies.config.json");
const OUTDIR = join(repoRoot, "docs", "backtest", "ten");

/** 봉별 수집 기간·보유 시한 — 표본을 최대로 늘리되 봉 성격에 맞는 시한. */
const TFS = {
  "15m": { bar: "15m", ms: 15 * 60_000, days: 365, maxHold: 96 }, // 1일
  "1H": { bar: "1H", ms: 3600_000, days: 1200, maxHold: 72 }, // 3일
  "4H": { bar: "4H", ms: 4 * 3600_000, days: 1800, maxHold: 60 }, // 10일
  "1D": { bar: "1D", ms: 24 * 3600_000, days: 2400, maxHold: 20 }, // 20일
};

/** 손익비 4단계 — 손절 1×ATR 고정(직전 검토 최적), 목표만 바꿔 손익비를 분리 검증. */
const EXITS = [
  { key: "rr1", name: "손절1×ATR·목표1×", rr: 1, sl: 1, tp: 1 },
  { key: "rr1.5", name: "손절1×ATR·목표1.5×", rr: 1.5, sl: 1, tp: 1.5 },
  { key: "rr2", name: "손절1×ATR·목표2×", rr: 2, sl: 1, tp: 2 },
  { key: "rr3", name: "손절1×ATR·목표3×", rr: 3, sl: 1, tp: 3 },
];

/* ---------- 데이터 수집 ---------- */

async function fetchPage(bar, after, attempt = 0) {
  const url = `${BASE}/market/history-candles?instId=${INST}&bar=${bar}&after=${after}&limit=${PAGE}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  // 한도(429)는 실패가 아니라 속도 신호다 — 물러났다가 다시 간다.
  if (res.status === 429 && attempt < 6) {
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    return fetchPage(bar, after, attempt + 1);
  }
  if (!res.ok) throw new Error(`OKX ${res.status}`);
  const json = await res.json();
  if (json.code !== "0") throw new Error(`OKX: ${json.msg || json.code}`);
  return json.data;
}

async function fetchCandles(tfKey) {
  const { bar, ms, days } = TFS[tfKey];
  const to = Math.floor(Date.now() / ms) * ms;
  const from = to - days * 24 * 3600_000;
  const span = ms * PAGE;
  const pages = Math.ceil((to - from) / span);
  const cursors = Array.from({ length: pages }, (_, i) => to - i * span);

  const out = new Map();
  for (let i = 0; i < cursors.length; i += 8) {
    const batch = await Promise.all(cursors.slice(i, i + 8).map((c) => fetchPage(bar, c)));
    for (const rows of batch) {
      for (const row of rows) {
        const t = Number(row[0]);
        if (t >= from && t < to && row[8] === "1") {
          out.set(t, {
            t,
            o: Number(row[1]),
            h: Number(row[2]),
            l: Number(row[3]),
            c: Number(row[4]),
            v: Number(row[5]),
          });
        }
      }
    }
    if (i + 8 < cursors.length) await new Promise((r) => setTimeout(r, 1600));
    process.stdout.write(`\r${tfKey}: ${Math.min(i + 8, cursors.length)}/${cursors.length} 페이지`);
  }
  process.stdout.write("\n");
  return [...out.values()].sort((a, b) => a.t - b.t);
}

async function cmdFetch() {
  const data = {};
  for (const tf of Object.keys(TFS)) {
    const candles = await fetchCandles(tf);
    data[tf] = candles;
    const span = candles.length
      ? Math.round((candles[candles.length - 1].t - candles[0].t) / 86400_000)
      : 0;
    console.log(`${tf}: 캔들 ${candles.length}개, 실제 ${span}일`);
  }
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify({ fetchedAt: Date.now(), symbol: INST, data }));
  console.log(`저장: ${CACHE}`);
}

/* ---------- 지표 — 원장과 같은 Wilder 계산 + 이동평균·밴드·돌파선 ---------- */

function rsi(closes, period = 14) {
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

function atr(candles, period = 14) {
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

function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function ema(values, n, startIdx = 0) {
  const out = new Array(values.length).fill(null);
  if (values.length - startIdx < n) return out;
  let seed = 0;
  for (let i = startIdx; i < startIdx + n; i += 1) seed += values[i];
  seed /= n;
  out[startIdx + n - 1] = seed;
  const k = 2 / (n + 1);
  for (let i = startIdx + n; i < values.length; i += 1) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, sig = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const line = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null,
  );
  // 시그널은 MACD가 서는 지점부터의 EMA — null 구간을 잘라 계산 후 되돌린다.
  const start = line.findIndex((v) => v !== null);
  const signal = new Array(closes.length).fill(null);
  if (start >= 0) {
    const seg = ema(line.slice(start), sig);
    for (let i = 0; i < seg.length; i += 1) signal[start + i] = seg[i];
  }
  return { line, signal };
}

function stdev(values, n) {
  const out = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i += 1) {
    let sum = 0;
    for (let k = i - n + 1; k <= i; k += 1) sum += values[k];
    const mean = sum / n;
    let sq = 0;
    for (let k = i - n + 1; k <= i; k += 1) sq += (values[k] - mean) ** 2;
    out[i] = Math.sqrt(sq / n);
  }
  return out;
}

function volMA(candles, n = 20) {
  const out = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    if (i >= n) out[i] = sum / n;
    sum += candles[i].v;
    if (i >= n) sum -= candles[i - n].v;
  }
  return out;
}

/** 직전 n봉(현재 봉 제외)의 최고가·최저가 — 돌파 판정용. */
function rolling(candles, n, pick, cmp) {
  const out = new Array(candles.length).fill(null);
  for (let i = n; i < candles.length; i += 1) {
    let best = pick(candles[i - n]);
    for (let k = i - n + 1; k < i; k += 1) {
      const v = pick(candles[k]);
      if (cmp(v, best)) best = v;
    }
    out[i] = best;
  }
  return out;
}

function findDivergences(candles, rsiArr) {
  const W = 3;
  const at = new Map();
  const pivots = [];
  for (let p = W; p < candles.length - W; p += 1) {
    let ok = true;
    for (let k = 1; k <= W; k += 1) {
      if (candles[p].l >= candles[p - k].l || candles[p].l >= candles[p + k].l) ok = false;
    }
    if (!ok || rsiArr[p] === null) continue;
    const prev = pivots.findLast(
      (q) => p - q.p >= 5 && p - q.p <= 40 && candles[p].l < candles[q.p].l && rsiArr[p] > rsiArr[q.p] && rsiArr[q.p] < 40,
    );
    pivots.push({ p });
    if (prev) at.set(p + W, { from: prev.p, to: p });
  }
  return at;
}

/** 하위봉 i → 그 시점에 "마감 완료된" 최신 일봉 인덱스. 진행 중 일봉을 보면 미래 참조다. */
function htfIndexMap(candles, daily) {
  const out = new Array(candles.length).fill(-1);
  let d = -1;
  for (let i = 0; i < candles.length; i += 1) {
    while (d + 1 < daily.length && daily[d + 1].t + 86400_000 <= candles[i].t) d += 1;
    out[i] = d;
  }
  return out;
}

/* ---------- 진입 블록 메뉴 — 기획 에이전트가 조합하는 단위 ---------- */

const BASES = {
  "golden-cross": {
    name: "골든크로스 (SMA20↗SMA50)",
    side: "long",
    rule: "SMA20이 SMA50을 상향 돌파 마감",
    fn: (i, c) => c.sma20[i - 1] !== null && c.sma20[i - 1] <= c.sma50[i - 1] && c.sma20[i] > c.sma50[i],
  },
  "donchian20-breakout": {
    name: "20봉 신고가 돌파",
    side: "long",
    rule: "종가가 직전 20봉 최고가 위로 마감",
    fn: (i, c) => c.hh20[i] !== null && c.candles[i].c > c.hh20[i],
  },
  "donchian55-breakout": {
    name: "55봉 신고가 돌파 (터틀)",
    side: "long",
    rule: "종가가 직전 55봉 최고가 위로 마감",
    fn: (i, c) => c.hh55[i] !== null && c.candles[i].c > c.hh55[i],
  },
  "ma-pullback": {
    name: "상승 추세 눌림목",
    side: "long",
    rule: "SMA20>SMA50, 종가>SMA200에서 저가가 SMA20 터치 후 종가는 위로 마감",
    fn: (i, c) =>
      c.sma200[i] !== null && c.sma20[i] > c.sma50[i] && c.candles[i].c > c.sma200[i] &&
      c.candles[i].l <= c.sma20[i] && c.candles[i].c > c.sma20[i],
  },
  "rsi-oversold-bounce": {
    name: "RSI 과매도 반등",
    side: "long",
    rule: "RSI(14)가 30 아래로 갔다가 30 위로 복귀 마감",
    fn: (i, c) => c.rsi[i - 1] !== null && c.rsi[i - 1] < 30 && c.rsi[i] >= 30,
  },
  "rsi-50-volume": {
    name: "RSI 50 돌파 + 거래량 확장",
    side: "long",
    rule: "RSI(14)가 50 상향 돌파 마감, 거래량 ≥ 1.5×20봉 평균",
    fn: (i, c) =>
      c.rsi[i - 1] !== null && c.volMA[i] !== null &&
      c.rsi[i - 1] < 50 && c.rsi[i] >= 50 && c.candles[i].v >= 1.5 * c.volMA[i],
  },
  "macd-cross-up": {
    name: "MACD 골든 교차",
    side: "long",
    rule: "MACD(12,26,9) 라인이 시그널을 상향 교차 마감",
    fn: (i, c) =>
      c.macdSig[i - 1] !== null && c.macdLine[i - 1] <= c.macdSig[i - 1] && c.macdLine[i] > c.macdSig[i],
  },
  "bb-revert-long": {
    name: "볼린저 하단 복귀",
    side: "long",
    rule: "직전 봉 종가가 볼린저(20,2σ) 하단 밖, 이번 봉 종가가 밴드 안 복귀",
    fn: (i, c) =>
      c.bbLow[i - 1] !== null && c.candles[i - 1].c < c.bbLow[i - 1] && c.candles[i].c > c.bbLow[i],
  },
  "inside-bar-breakout": {
    name: "인사이드바 상방 돌파",
    side: "long",
    rule: "인사이드바 형성 후 종가가 모봉 고가 돌파 마감",
    fn: (i, c) =>
      i >= 2 &&
      c.candles[i - 1].h < c.candles[i - 2].h && c.candles[i - 1].l > c.candles[i - 2].l &&
      c.candles[i].c > c.candles[i - 2].h,
  },
  "volume-spike-breakout": {
    name: "거래량 스파이크 장대양봉",
    side: "long",
    rule: "거래량 ≥ 2배, 몸통 ≥ 봉 범위 60%인 양봉, 종가가 직전 봉 고가 위",
    fn: (i, c) => {
      if (c.volMA[i] === null) return false;
      const b = c.candles[i];
      const range = b.h - b.l;
      return b.v >= 2 * c.volMA[i] && b.c > b.o && range > 0 &&
        (b.c - b.o) / range >= 0.6 && b.c > c.candles[i - 1].h;
    },
  },
  "rsi-bull-divergence": {
    name: "RSI 상승 다이버전스",
    side: "long",
    rule: "가격 신저점·RSI 저점 상승 (피벗 좌우 3봉, 간격 5~40봉, 이전 피벗 RSI<40)",
    fn: (i, c) => c.divergenceAt.has(i),
  },
  "three-white-soldiers": {
    name: "3연속 양봉",
    side: "long",
    rule: "3연속 양봉 + 종가 연속 상승 마감",
    fn: (i, c) => {
      if (i < 2) return false;
      const [a, b, d] = [c.candles[i - 2], c.candles[i - 1], c.candles[i]];
      return a.c > a.o && b.c > b.o && d.c > d.o && d.c > b.c && b.c > a.c;
    },
  },
  "death-cross": {
    name: "데드크로스 (SMA20↘SMA50) 숏",
    side: "short",
    rule: "SMA20이 SMA50을 하향 돌파 마감",
    fn: (i, c) => c.sma20[i - 1] !== null && c.sma20[i - 1] >= c.sma50[i - 1] && c.sma20[i] < c.sma50[i],
  },
  "donchian20-breakdown": {
    name: "20봉 신저가 이탈 숏",
    side: "short",
    rule: "종가가 직전 20봉 최저가 아래로 마감",
    fn: (i, c) => c.ll20[i] !== null && c.candles[i].c < c.ll20[i],
  },
  "rsi-overbought-fade": {
    name: "RSI 과매수 반락 숏",
    side: "short",
    rule: "RSI(14)가 70 위로 갔다가 70 아래로 복귀 마감",
    fn: (i, c) => c.rsi[i - 1] !== null && c.rsi[i - 1] > 70 && c.rsi[i] <= 70,
  },
  "macd-cross-down": {
    name: "MACD 데드 교차 숏",
    side: "short",
    rule: "MACD(12,26,9) 라인이 시그널을 하향 교차 마감",
    fn: (i, c) =>
      c.macdSig[i - 1] !== null && c.macdLine[i - 1] >= c.macdSig[i - 1] && c.macdLine[i] < c.macdSig[i],
  },
  "bb-revert-short": {
    name: "볼린저 상단 복귀 숏",
    side: "short",
    rule: "직전 봉 종가가 볼린저(20,2σ) 상단 밖, 이번 봉 종가가 밴드 안 복귀",
    fn: (i, c) =>
      c.bbUp[i - 1] !== null && c.candles[i - 1].c > c.bbUp[i - 1] && c.candles[i].c < c.bbUp[i],
  },
};

const FILTERS = {
  "trend-up": { name: "종가>SMA200", fn: (i, c) => c.sma200[i] !== null && c.candles[i].c > c.sma200[i] },
  "trend-down": { name: "종가<SMA200", fn: (i, c) => c.sma200[i] !== null && c.candles[i].c < c.sma200[i] },
  "vol-expand": { name: "거래량≥1.5×평균", fn: (i, c) => c.volMA[i] !== null && c.candles[i].v >= 1.5 * c.volMA[i] },
  "htf-up": {
    name: "일봉>일봉SMA50",
    fn: (i, c) => {
      const d = c.htfIdx[i];
      return d >= 0 && c.dailySma50[d] !== null && c.daily[d].c > c.dailySma50[d];
    },
  },
  "htf-down": {
    name: "일봉<일봉SMA50",
    fn: (i, c) => {
      const d = c.htfIdx[i];
      return d >= 0 && c.dailySma50[d] !== null && c.daily[d].c < c.dailySma50[d];
    },
  },
  "rsi-mid": { name: "RSI 35~65", fn: (i, c) => c.rsi[i] !== null && c.rsi[i] >= 35 && c.rsi[i] <= 65 },
};

/* ---------- 체결 — 신호 봉 마감 → 다음 봉 시가 진입, 보수적 동시도달 처리 ---------- */

function walkExit(candles, entryIdx, entry, side, exit, atrSig, maxHold) {
  const dir = side === "long" ? 1 : -1;
  const slDist = exit.sl * atrSig;
  const tpDist = exit.tp * atrSig;
  const stop = entry - dir * slDist;
  const target = entry + dir * tpDist;

  let exitIdx = Math.min(entryIdx + maxHold - 1, candles.length - 1);
  let exitPrice = candles[exitIdx].c;
  let exitType = "time";
  // 보유 중 진입가 대비 최대 역행(%) — 레버리지 청산 판정용. 봉 극값 기준(시가 갭 포함).
  // 손절 청산 봉에서는 손절 체결 순간 포지션이 닫히므로 손절 너머 극값은 세지 않는다.
  let maeAdvPct = 0;
  const barAdv = (bar) =>
    dir === 1 ? ((entry - bar.l) / entry) * 100 : ((bar.h - entry) / entry) * 100;
  const openAdv = (bar) =>
    dir === 1 ? ((entry - bar.o) / entry) * 100 : ((bar.o - entry) / entry) * 100;
  for (let j = entryIdx; j <= exitIdx; j += 1) {
    const bar = candles[j];
    const hitSl = dir === 1 ? bar.l <= stop : bar.h >= stop;
    const hitTp = dir === 1 ? bar.h >= target : bar.l <= target;
    // 같은 봉에서 둘 다 걸리면 손절로 본다 — 봉 내부 경로를 모르니 보수적으로.
    if (hitSl) {
      exitIdx = j;
      // 시가가 손절 너머로 갭 출발하면 손절가 체결은 낙관 — 시가 체결로 본다.
      exitPrice = dir === 1 ? Math.min(stop, bar.o) : Math.max(stop, bar.o);
      exitType = "sl";
      // 손절까지의 확실한 역행만 반영: 손절 거리와 갭 시가 중 큰 쪽.
      maeAdvPct = Math.max(maeAdvPct, (slDist / entry) * 100, j > entryIdx ? openAdv(bar) : 0);
      break;
    }
    // 목표 청산 봉의 역행 극값은 순서를 모르니 보수적으로 전부 센다(청산 우선 철학).
    maeAdvPct = Math.max(maeAdvPct, barAdv(bar));
    if (hitTp) {
      exitIdx = j;
      exitPrice = target;
      exitType = "tp";
      break;
    }
  }
  if (exitType === "time" && exitIdx === candles.length - 1 && exitIdx - entryIdx + 1 < maxHold) {
    exitType = "open";
  }
  const gross = ((exitPrice - entry) / entry) * dir * 100;
  return {
    exitIdx,
    exitPrice,
    exitType,
    stop,
    target,
    slDistPct: (slDist / entry) * 100,
    maeAdvPct,
    grossPct: gross,
    pnl: Math.round((gross - FEE_PCT) * 1000) / 1000,
  };
}

function simulate(candles, ctx, strat, exit, maxHold) {
  const base = BASES[strat.base];
  const filters = (strat.filters ?? []).map((f) => FILTERS[f]);
  const trades = [];
  let openUntil = -1;
  for (let i = WARMUP; i < candles.length - 1; i += 1) {
    if (i < openUntil) continue;
    if (ctx.atr[i] === null) continue;
    if (!base.fn(i, ctx)) continue;
    if (!filters.every((f) => f.fn(i, ctx))) continue;
    const entryIdx = i + 1;
    const entry = candles[entryIdx].o;
    const x = walkExit(candles, entryIdx, entry, base.side, exit, ctx.atr[i], maxHold);
    trades.push({
      signalIdx: i,
      entryIdx,
      exitIdx: x.exitIdx,
      entryAt: candles[entryIdx].t,
      exitAt: candles[x.exitIdx].t,
      entry,
      exit: x.exitPrice,
      stop: x.stop,
      target: x.target,
      exitType: x.exitType,
      holdBars: x.exitIdx - entryIdx + 1,
      slDistPct: Math.round(x.slDistPct * 1000) / 1000,
      maeAdvPct: Math.round(x.maeAdvPct * 1000) / 1000,
      grossPct: Math.round(x.grossPct * 1000) / 1000,
      pnl: x.pnl,
    });
    openUntil = x.exitIdx;
  }
  return trades;
}

/* ---------- 통계 — 1× 기준 (명목 %) + 3구간 강건성 + 손익분기 승률 ---------- */

function wilsonLow(wins, n, z = 1.96) {
  if (n === 0) return null;
  const p = wins / n;
  const den = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return ((center - margin) / den) * 100;
}

function stats(allTrades, periodEdges) {
  const trades = allTrades
    .filter((t) => t.exitType !== "open")
    .slice()
    .sort((a, b) => a.exitAt - b.exitAt || a.entryAt - b.entryAt);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.pnl, 0);

  let peak = 0, equity = 0, mdd = 0, streak = 0, maxWinStreak = 0, maxLossStreak = 0;
  for (const t of trades) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    mdd = Math.min(mdd, equity - peak);
    streak = t.pnl > 0 ? Math.max(streak, 0) + 1 : Math.min(streak, 0) - 1;
    maxWinStreak = Math.max(maxWinStreak, streak);
    maxLossStreak = Math.max(maxLossStreak, -streak);
  }

  const n = trades.length;
  const mean = n ? equity / n : 0;
  const sd = n > 1 ? Math.sqrt(trades.reduce((s, t) => s + (t.pnl - mean) ** 2, 0) / (n - 1)) : 0;
  const tstat = n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;

  // 손익분기 승률 — 실현 평균 손익폭 기준. 윌슨 하한이 이 위면 통계적으로 단단한 편.
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const beWinRate = avgWin - avgLoss > 0 ? (-avgLoss / (avgWin - avgLoss)) * 100 : null;
  const winRateLow95 = wilsonLow(wins.length, n);

  // 수수료 잠식 — 비용 차감 전 총이익 대비 총비용.
  const grossBeforeFee = trades.reduce((s, t) => s + Math.max(t.grossPct, 0), 0);
  const feeShare = grossBeforeFee > 0 ? ((n * FEE_PCT) / grossBeforeFee) * 100 : null;

  const periods = periodEdges.slice(0, -1).map((from, k) => {
    const to = periodEdges[k + 1];
    const ts = trades.filter((t) => t.entryAt >= from && t.entryAt < to);
    const sum = ts.reduce((s, t) => s + t.pnl, 0);
    return { n: ts.length, pnl: Math.round(sum * 1000) / 1000 };
  });

  const r = (x) => (x === null ? null : Math.round(x * 1000) / 1000);
  return {
    trades: n,
    wins: wins.length,
    winRate: n ? r((wins.length / n) * 100) : null,
    winRateLow95: r(winRateLow95),
    beWinRate: r(beWinRate),
    totalPnl: r(equity),
    profitFactor: grossLoss !== 0 ? r(grossProfit / -grossLoss) : null,
    avgPnl: n ? r(mean) : null,
    sd: r(sd),
    tstat: r(tstat),
    feeShare: r(feeShare),
    avgHoldBars: n ? r(trades.reduce((s, t) => s + t.holdBars, 0) / n) : null,
    maxWinStreak,
    maxLossStreak,
    mdd: r(mdd),
    exits: {
      tp: trades.filter((t) => t.exitType === "tp").length,
      sl: trades.filter((t) => t.exitType === "sl").length,
      time: trades.filter((t) => t.exitType === "time").length,
    },
    periods,
    positivePeriods: periods.filter((p) => p.n > 0 && p.pnl > 0).length,
  };
}

/* ---------- 레버리지 — 같은 거래에 분석적 적용 ($100 전액 격리·복리) ---------- */

function leverageRun(allTrades, lev) {
  const trades = allTrades
    .filter((t) => t.exitType !== "open")
    .slice()
    .sort((a, b) => a.exitAt - b.exitAt || a.entryAt - b.entryAt);
  const liqThr = 100 / lev - MAINT_PCT; // 진입가 대비 역행 % — 격리 증거금 소진 지점.
  let eq = START_EQ;
  let peak = START_EQ;
  let mdd = 0;
  let ruin = false;
  let liqEvents = 0;
  let worstTrade = 0;
  const curve = [{ at: trades[0]?.entryAt ?? 0, eq: START_EQ }];
  for (const t of trades) {
    // 보유 중 역행 극값(봉 극값·시가 갭 포함)이 청산 문턱을 넘으면 증거금 전액 소실.
    const retRaw = lev * (t.grossPct - FEE_PCT);
    if (t.maeAdvPct >= liqThr || retRaw <= -100) {
      eq = 0;
      liqEvents += 1;
      if (worstTrade > -100) worstTrade = -100;
    } else {
      if (retRaw < worstTrade) worstTrade = retRaw;
      eq *= 1 + retRaw / 100;
    }
    if (eq < 0) eq = 0;
    curve.push({ at: t.exitAt, eq: Math.round(eq * 100) / 100 });
    peak = Math.max(peak, eq);
    const dd = peak > 0 ? ((eq - peak) / peak) * 100 : -100;
    mdd = Math.min(mdd, dd);
    if (eq < RUIN_EQ) {
      ruin = true;
      break;
    }
  }
  // 곡선 다운샘플 — 리포트 파일 크기 관리.
  const MAXPTS = 160;
  const sampled =
    curve.length <= MAXPTS
      ? curve
      : curve.filter((_, i) => i % Math.ceil(curve.length / MAXPTS) === 0 || i === curve.length - 1);
  const r = (x) => Math.round(x * 100) / 100;
  return {
    lev,
    liqThrPct: r(liqThr),
    finalEq: r(eq),
    retPct: r(((eq - START_EQ) / START_EQ) * 100),
    mddPct: r(mdd),
    ruin,
    liqEvents,
    worstTradePct: r(worstTrade),
    riskPerTradeHint: null, // 전략별 평균 손절폭 × 레버 — runStrategy에서 채운다.
    curve: sampled,
  };
}

/* ---------- 실행 ---------- */

function loadCache() {
  if (!existsSync(CACHE)) {
    console.error(`캔들 캐시가 없다: ${CACHE}\n먼저 실행: node scripts/backtest/ten-strategies.mjs fetch`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(CACHE, "utf8"));
}

function buildCtx(candles, daily) {
  const closes = candles.map((c) => c.c);
  const { line, signal } = macd(closes);
  const sma20v = sma(closes, 20);
  const sd20 = stdev(closes, 20);
  const ctx = {
    candles,
    rsi: rsi(closes),
    atr: atr(candles),
    volMA: volMA(candles),
    sma20: sma20v,
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    macdLine: line,
    macdSig: signal,
    bbUp: closes.map((_, i) => (sma20v[i] !== null && sd20[i] !== null ? sma20v[i] + 2 * sd20[i] : null)),
    bbLow: closes.map((_, i) => (sma20v[i] !== null && sd20[i] !== null ? sma20v[i] - 2 * sd20[i] : null)),
    hh20: rolling(candles, 20, (c) => c.h, (a, b) => a > b),
    hh55: rolling(candles, 55, (c) => c.h, (a, b) => a > b),
    ll20: rolling(candles, 20, (c) => c.l, (a, b) => a < b),
    daily,
    dailySma50: sma(daily.map((c) => c.c), 50),
    htfIdx: htfIndexMap(candles, daily),
  };
  ctx.divergenceAt = findDivergences(candles, ctx.rsi);
  return ctx;
}

function runStrategy(strat, cache) {
  const candles = cache.data[strat.tf];
  if (!candles || candles.length <= WARMUP + 1) {
    throw new Error(`캔들 부족: ${strat.tf} — ${candles?.length ?? 0}개 (워밍업 ${WARMUP} 초과 필요). fetch를 다시 실행하라.`);
  }
  const daily = cache.data["1D"] ?? [];
  const ctx = buildCtx(candles, daily);
  const t0 = candles[WARMUP].t;
  const t1 = candles[candles.length - 1].t;
  const periodEdges = [t0, t0 + (t1 - t0) / 3, t0 + (2 * (t1 - t0)) / 3, t1 + 1];
  const maxHold = TFS[strat.tf].maxHold;

  const byExit = EXITS.map((exit) => {
    const trades = simulate(candles, ctx, strat, exit, maxHold);
    const st = stats(trades, periodEdges);
    const levers = LEVERS.map((L) => {
      const run = leverageRun(trades, L);
      const avgSl = st.trades
        ? trades.filter((t) => t.exitType !== "open").reduce((s, t) => s + t.slDistPct, 0) / st.trades
        : 0;
      run.riskPerTradeHint = Math.round(L * (avgSl + FEE_PCT) * 100) / 100;
      return run;
    });
    return { exit: exit.key, exitName: exit.name, rr: exit.rr, stats: st, levers, trades };
  });

  // 저장 크기 관리 — 최고 t값 손익비의 거래만 최근 400건 남긴다.
  const best = byExit.slice().sort((a, b) => (b.stats.tstat ?? -9) - (a.stats.tstat ?? -9))[0];
  for (const e of byExit) {
    if (e === best) {
      e.trades = e.trades.slice(-400).map((t) => ({
        entryAt: t.entryAt, exitAt: t.exitAt, entry: t.entry, exit: t.exit,
        exitType: t.exitType, holdBars: t.holdBars, pnl: t.pnl, maeAdvPct: t.maeAdvPct,
      }));
      e.tradesNote = "최고 t값 손익비만 최근 400건 저장";
    } else {
      delete e.trades;
    }
  }

  const last = candles.length - 1;
  return {
    strategy: strat,
    baseName: BASES[strat.base].name,
    baseRule: BASES[strat.base].rule,
    side: BASES[strat.base].side,
    filterNames: (strat.filters ?? []).map((f) => FILTERS[f].name),
    frame: {
      tf: strat.tf,
      candles: candles.length,
      from: candles[0].t,
      warmupFrom: t0,
      to: t1,
      atrPct: Math.round((ctx.atr[last] / candles[last].c) * 100 * 1000) / 1000,
      maxHold,
      periodEdges: periodEdges.slice(0, 3).concat(t1),
      periodReturns: periodEdges.slice(0, -1).map((from, k) => {
        const to = periodEdges[k + 1];
        const inRange = candles.filter((c) => c.t >= from && c.t < to);
        const a = inRange[0]?.c, b = inRange[inRange.length - 1]?.c;
        return a && b ? Math.round(((b - a) / a) * 100 * 10) / 10 : null;
      }),
    },
    byExit,
  };
}

function cmdRun(args) {
  const cache = loadCache();
  const config = JSON.parse(readFileSync(CONFIG, "utf8"));
  const all = args.includes("--all");
  const keyIdx = args.indexOf("--strategy");
  const only = keyIdx >= 0 ? args[keyIdx + 1] : null;
  const targets = config.strategies.filter((s) => all || s.key === only);
  if (!targets.length) {
    console.error(`전략을 찾을 수 없다: ${only ?? "(--strategy <key> 또는 --all)"}`);
    console.error(`가능한 키: ${config.strategies.map((s) => s.key).join(", ")}`);
    process.exit(1);
  }
  for (const s of targets) {
    const badFilter = (s.filters ?? []).find((f) => !FILTERS[f]);
    if (!TFS[s.tf] || !BASES[s.base] || badFilter) {
      console.error(
        `설정 오류(${s.key}): tf=${s.tf} base=${s.base} filters=${(s.filters ?? []).join(",")}\n` +
        `가능한 tf: ${Object.keys(TFS).join(", ")}\n가능한 base: ${Object.keys(BASES).join(", ")}\n` +
        `가능한 filter: ${Object.keys(FILTERS).join(", ")}`,
      );
      process.exit(1);
    }
  }
  mkdirSync(OUTDIR, { recursive: true });
  for (const strat of targets) {
    const result = runStrategy(strat, cache);
    const out = join(OUTDIR, `${strat.key}.json`);
    writeFileSync(out, JSON.stringify(result));
    console.log(`\n=== ${strat.key} — ${strat.name} [${strat.tf}] (${result.side}) ===`);
    for (const e of result.byExit) {
      const s = e.stats;
      console.log(
        `${e.exitName.padEnd(14)} ${String(s.trades).padStart(4)}건 승률 ${s.winRate}% (하한 ${s.winRateLow95}% / 분기 ${s.beWinRate}%)` +
        ` 기대값 ${s.avgPnl}% t=${s.tstat} PF ${s.profitFactor} 구간 ${s.positivePeriods}/3`,
      );
      console.log(
        `  레버: ${e.levers.map((l) => `${l.lev}× → $${l.finalEq}${l.ruin ? " 파산" : ""} (MDD ${l.mddPct}%)`).join(" | ")}`,
      );
    }
    console.log(`저장: ${out}`);
  }
}

function cmdMerge() {
  const config = JSON.parse(readFileSync(CONFIG, "utf8"));
  const cache = loadCache();
  const merged = {
    meta: {
      generatedAt: Date.now(),
      symbol: INST,
      fee: FEE_PCT,
      warmup: WARMUP,
      maintPct: MAINT_PCT,
      levers: LEVERS,
      exits: EXITS,
      startEq: START_EQ,
      tfs: Object.fromEntries(Object.entries(TFS).map(([k, v]) => [k, { days: v.days, maxHold: v.maxHold }])),
      rules: {
        entry: "신호 봉 마감 → 다음 봉 시가 진입",
        exit: "손절 1×ATR(14) 고정, 목표 1×/1.5×/2×/3×ATR — 보유 시한 도달 시 종가 청산",
        fee: `왕복 ${FEE_PCT}% × 레버리지 (펀딩비 제외)`,
        conflict: "같은 봉에서 목표·손절 동시 도달 시 손절로 집계(보수적)",
        gap: "시가가 손절 너머 갭이면 시가 체결, 보유 중 역행 극값(MAE)이 청산 문턱(100/L−0.5%)을 넘으면 증거금 전액 소실",
        lock: "보유 중 새 신호 무시 — 전략당 한 포지션",
        leverage: "$100 전액 격리·복리, 명목 = 자산 × L",
      },
      dataFetchedAt: cache.fetchedAt,
    },
    strategies: [],
  };
  for (const strat of config.strategies) {
    const p = join(OUTDIR, `${strat.key}.json`);
    if (!existsSync(p)) {
      console.error(`결과 없음(건너뜀): ${p}`);
      continue;
    }
    merged.strategies.push(JSON.parse(readFileSync(p, "utf8")));
  }
  if (!merged.strategies.length) {
    console.error("병합할 결과가 하나도 없다 — 먼저 run을 실행하라.");
    process.exit(1);
  }
  const reviewPath = join(OUTDIR, "review.json");
  if (existsSync(reviewPath)) {
    merged.review = JSON.parse(readFileSync(reviewPath, "utf8"));
    console.log("review.json 포함");
  }
  const kstDay = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const out = join(repoRoot, "docs", "backtest", `${kstDay}-ten-strategies.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(merged));
  console.log(`전략 ${merged.strategies.length}개 병합 → ${out}`);
}

function cmdReport() {
  const dir = join(repoRoot, "docs", "backtest");
  const rounds = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-ten-strategies\.json$/.test(f)).sort();
  if (!rounds.length) {
    console.error("종합 JSON이 없다 — 먼저 merge를 실행하라.");
    process.exit(1);
  }
  const jsonName = rounds[rounds.length - 1];
  const html = readFileSync(join(repoRoot, "scripts", "backtest", "ten-strategies-template.html"), "utf8")
    .replace("__DATA_JSON__", readFileSync(join(dir, jsonName), "utf8"))
    .replace("__DATA_PATH__", `docs/backtest/${jsonName}`);
  const out = join(dir, "ten-strategies-report.html");
  writeFileSync(out, html);
  console.log(`${jsonName} → ${out}`);
}

const cmd = process.argv[2];
if (cmd === "fetch") await cmdFetch();
else if (cmd === "run") cmdRun(process.argv.slice(3));
else if (cmd === "merge") cmdMerge();
else if (cmd === "report") cmdReport();
else {
  console.log("사용: node scripts/backtest/ten-strategies.mjs <fetch|run|merge|report>");
  process.exit(1);
}
