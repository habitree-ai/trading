/**
 * 숏 타임프레임 재도전 — 15m·1H 전용, 신호군 교체 × 청산 기하 4단계 × 비용 2시나리오.
 *
 * 직전 회차(기획 10선 검증)에서 15m·1H는 손절 1×ATR 기하·테이커 비용에서 전 조합
 * 기각됐다. 이번 회차는 실패 원인을 바꾼다: ① 청산 기하를 넓혀 보유를 길게(비용 상각)
 * ② 테이커 0.1% / 메이커 진입 0.07% 를 병행 계산("메이커면 살아나는가"에 답한다)
 * ③ 단타봉 특화 신호(스퀴즈·z-스코어·일중 채널·상위봉 정렬).
 *
 * 판정 게이트(사전 등록): 테이커 0.1% 기준 기대값>0 · PF≥1.1 · 3구간 중 2+ 플러스,
 * 표본 15m ≥300 · 1H ≥200 (미달 시 파일럿). 레버리지는 기준선 1× + 2/5/10/20×.
 *
 * 사용:
 *   node scripts/backtest/short-tf.mjs fetch    → 15m 730일 수집 + 기존 캐시(1H·4H·1D) 병합
 *   node scripts/backtest/short-tf.mjs run --strategy <key> | --all
 *   node scripts/backtest/short-tf.mjs merge    → docs/backtest/<KST>-short-tf.json
 *   node scripts/backtest/short-tf.mjs report   → docs/backtest/short-tf-report.html
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://www.okx.com/api/v5";
const INST = "BTC-USDT-SWAP";
const PAGE = 100;
const FEES = { taker: 0.1, maker: 0.07 }; // 왕복 % — 메이커는 진입 지정가(0.02)+청산 시장가(0.05) 가정.
const GATE_FEE = "taker"; // 판정은 테이커 기준 — 메이커는 구제 여부 측정용.
const WARMUP = 260; // 스퀴즈 백분위(200+BB20)·SMA200이 서는 자리.
const MAINT_PCT = 0.5;
const LEVERS = [1, 2, 5, 10, 20];
const START_EQ = 100;
const RUIN_EQ = 1;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE_TEN = join(repoRoot, "scripts", "backtest", ".cache", "ten-candles.json");
const CACHE = join(repoRoot, "scripts", "backtest", ".cache", "short-tf-candles.json");
const CACHE_SPOT = join(repoRoot, "scripts", "backtest", ".cache", "spot-candles.json");
// --round <name> 이면 설정·출력을 그 라운드 경로로 분리 — 기본은 15m·1H 재도전 회차 경로 그대로.
const roundIdx = process.argv.indexOf("--round");
const ROUND = roundIdx >= 0 ? process.argv[roundIdx + 1] : null;
const CONFIG = ROUND
  ? join(repoRoot, "scripts", "backtest", `${ROUND}.config.json`)
  : join(repoRoot, "scripts", "backtest", "short-tf.config.json");
const OUTDIR = ROUND ? join(repoRoot, "docs", "backtest", ROUND) : join(repoRoot, "docs", "backtest", "short");
const MERGE_TAG = ROUND ?? "short-tf";

/** 대상 봉 — 일중 채널 룩백(bars/day)과 보유 시한이 봉마다 다르다. */
const TFS = {
  "15m": { bar: "15m", ms: 15 * 60_000, days: 730, maxHold: 288, dayBars: 96 }, // 시한 3일
  "1H": { bar: "1H", ms: 3600_000, days: 1200, maxHold: 120, dayBars: 24 }, // 시한 5일
  "4H": { bar: "4H", ms: 4 * 3600_000, days: 1800, maxHold: 60, dayBars: 6 }, // 시한 10일 — 베이시스 회차부터
};

/** 청산 기하 4단계 — 폭 자체가 축이다. 넓을수록 보유가 길어져 비용이 상각된다. */
const EXITS = [
  { key: "g1", name: "타이트 손절1×·목표1×", rr: 1, sl: 1, tp: 1 },
  { key: "g2", name: "중간 손절1.5×·목표3×", rr: 2, sl: 1.5, tp: 3 },
  { key: "g3", name: "와이드 손절2×·목표6×", rr: 3, sl: 2, tp: 6 },
  { key: "g4", name: "엑스와이드 손절3×·목표9×", rr: 3, sl: 3, tp: 9 },
];

/* ---------- 데이터 수집 — 15m만 새로, 나머지는 기존 캐시 재사용 ---------- */

async function fetchPage(bar, after, attempt = 0, inst = INST) {
  const url = `${BASE}/market/history-candles?instId=${inst}&bar=${bar}&after=${after}&limit=${PAGE}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 429 && attempt < 6) {
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    return fetchPage(bar, after, attempt + 1, inst);
  }
  if (!res.ok) throw new Error(`OKX ${res.status}`);
  const json = await res.json();
  if (json.code !== "0") throw new Error(`OKX: ${json.msg || json.code}`);
  return json.data;
}

async function fetchCandles(bar, ms, days, inst = INST) {
  const to = Math.floor(Date.now() / ms) * ms;
  const from = to - days * 24 * 3600_000;
  const span = ms * PAGE;
  const pages = Math.ceil((to - from) / span);
  const cursors = Array.from({ length: pages }, (_, i) => to - i * span);
  const out = new Map();
  for (let i = 0; i < cursors.length; i += 8) {
    const batch = await Promise.all(cursors.slice(i, i + 8).map((c) => fetchPage(bar, c, 0, inst)));
    for (const rows of batch) {
      for (const row of rows) {
        const t = Number(row[0]);
        if (t >= from && t < to && row[8] === "1") {
          out.set(t, { t, o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[5]) });
        }
      }
    }
    if (i + 8 < cursors.length) await new Promise((r) => setTimeout(r, 1600));
    process.stdout.write(`\r${bar}: ${Math.min(i + 8, cursors.length)}/${cursors.length} 페이지`);
  }
  process.stdout.write("\n");
  return [...out.values()].sort((a, b) => a.t - b.t);
}

async function cmdFetch() {
  if (!existsSync(CACHE_TEN)) {
    console.error(`기존 캐시가 없다: ${CACHE_TEN} — 먼저 ten-strategies.mjs fetch 를 실행하라.`);
    process.exit(1);
  }
  const ten = JSON.parse(readFileSync(CACHE_TEN, "utf8"));
  // 재사용 캐시 검증 — 키 부재는 조용한 0거래로, 노후는 HTF 국면 동결로 이어진다.
  for (const tf of ["1H", "4H", "1D"]) {
    if (!ten.data?.[tf]?.length) {
      console.error(`기존 캐시에 ${tf} 데이터가 없다 — ten-strategies.mjs fetch 를 먼저 실행하라.`);
      process.exit(1);
    }
  }
  const ageH = (Date.now() - ten.fetchedAt) / 3600_000;
  if (ageH > 6) {
    console.error(`기존 캐시가 ${Math.round(ageH)}시간 전 수집본이다 — 15m과 창 끝이 어긋난다. ten-strategies.mjs fetch 로 갱신 후 재실행하라.`);
    process.exit(1);
  }
  const m15 = await fetchCandles("15m", TFS["15m"].ms, TFS["15m"].days);
  const data = { "15m": m15, "1H": ten.data["1H"], "4H": ten.data["4H"], "1D": ten.data["1D"] };
  const tfFetchedAt = { "15m": Date.now(), "1H": ten.fetchedAt, "4H": ten.fetchedAt, "1D": ten.fetchedAt };
  for (const [tf, c] of Object.entries(data)) {
    const span = c.length ? Math.round((c[c.length - 1].t - c[0].t) / 86400_000) : 0;
    console.log(`${tf}: 캔들 ${c.length}개, 실제 ${span}일${tf === "15m" ? " (신규 수집)" : " (기존 캐시)"}`);
  }
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify({ fetchedAt: Date.now(), tfFetchedAt, symbol: INST, data }));
  console.log(`저장: ${CACHE}`);
}

/** 현물(BTC-USDT) 캔들 수집 — 베이시스(스왑−현물 괴리) 계산용. 스왑 캐시 창과 같은 길이. */
async function cmdFetchSpot() {
  const data = {};
  for (const tf of ["1H", "4H"]) {
    data[tf] = await fetchCandles(TFS[tf].bar, TFS[tf].ms, TFS[tf].days, "BTC-USDT");
    const span = data[tf].length ? Math.round((data[tf][data[tf].length - 1].t - data[tf][0].t) / 86400_000) : 0;
    console.log(`현물 ${tf}: 캔들 ${data[tf].length}개, 실제 ${span}일`);
  }
  mkdirSync(dirname(CACHE_SPOT), { recursive: true });
  writeFileSync(CACHE_SPOT, JSON.stringify({ fetchedAt: Date.now(), symbol: "BTC-USDT", data }));
  console.log(`저장: ${CACHE_SPOT}`);
}

/* ---------- 지표 — 시리즈 공통(Wilder) + 이번 회차 신규 ---------- */

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
  // O(n) 이동합 — 70k 봉에서 창별 재합산은 느리다.
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    sq += values[i] * values[i];
    if (i >= n) {
      sum -= values[i - n];
      sq -= values[i - n] * values[i - n];
    }
    if (i >= n - 1) {
      const mean = sum / n;
      out[i] = Math.sqrt(Math.max(0, sq / n - mean * mean));
    }
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

/** 직전 n봉(현재 봉 제외)의 최고/최저 — 단조 데크로 O(n). 70k봉 × 96룩백 대비. */
function rollingExtreme(candles, n, pick, isMax) {
  const out = new Array(candles.length).fill(null);
  const deque = []; // 인덱스, 값은 pick — 앞이 극값.
  for (let i = 0; i < candles.length; i += 1) {
    // 창은 [i-n, i-1] — 현재 봉이 판정에 들어가면 자기 확증이 된다.
    if (i >= 1) {
      const v = pick(candles[i - 1]);
      while (deque.length && (isMax ? pick(candles[deque[deque.length - 1]]) <= v : pick(candles[deque[deque.length - 1]]) >= v)) {
        deque.pop();
      }
      deque.push(i - 1);
    }
    while (deque.length && deque[0] < i - n) deque.shift();
    if (i >= n) out[i] = pick(candles[deque[0]]);
  }
  return out;
}

/**
 * BB 폭 백분위 스퀴즈 — bbw[i-1]이 직전 200봉(자기 제외) 하위 20%면 수축 상태.
 * 창을 정렬 유지 없이 매번 세면 느리다 — 카운트만 세는 O(n×200)으로 충분.
 */
function squeezeFlags(bbw, win = 200, pctl = 0.2) {
  const out = new Array(bbw.length).fill(false);
  for (let i = win + 1; i < bbw.length; i += 1) {
    const x = bbw[i - 1];
    if (x === null) continue;
    let below = 0;
    let valid = 0;
    for (let k = i - 1 - win; k < i - 1; k += 1) {
      if (bbw[k] === null) continue;
      valid += 1;
      if (bbw[k] < x) below += 1;
    }
    if (valid >= win * 0.9) out[i] = below / valid <= pctl;
  }
  return out;
}

/**
 * 베이시스 z-스코어 — 결측(현물 봉 부재)을 건너뛰는 롤링 표준화.
 * 창 내 유효 표본이 90% 미만이면 null. 창은 [i-win+1, i] (현재 봉 포함 — BB 관례).
 */
function rollingZ(vals, win) {
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

/** 하위봉 i → 그 시점에 마감 완료된 상위봉 인덱스 (상위봉 마감시각 ≤ 하위봉 시가시각). */
function htfIndexMap(candles, htf, htfMs) {
  const out = new Array(candles.length).fill(-1);
  let d = -1;
  for (let i = 0; i < candles.length; i += 1) {
    while (d + 1 < htf.length && htf[d + 1].t + htfMs <= candles[i].t) d += 1;
    out[i] = d;
  }
  return out;
}

/* ---------- 진입 블록 메뉴 ---------- */

const BASES = {
  "golden-cross": {
    name: "골든크로스 (SMA20↗SMA50)",
    side: "long",
    rule: "SMA20이 SMA50을 상향 돌파 마감",
    fn: (i, c) => c.sma20[i - 1] !== null && c.sma50[i - 1] !== null && c.sma20[i - 1] <= c.sma50[i - 1] && c.sma20[i] > c.sma50[i],
  },
  "rsi-oversold-bounce": {
    name: "RSI 과매도 반등",
    side: "long",
    rule: "RSI(14)가 30 아래로 갔다가 30 위로 복귀 마감",
    fn: (i, c) => c.rsi[i - 1] !== null && c.rsi[i - 1] < 30 && c.rsi[i] >= 30,
  },
  "rsi-40-bounce": {
    name: "RSI 40 눌림 반등",
    side: "long",
    rule: "RSI(14)가 40 아래로 갔다가 40 위로 복귀 마감 (얕은 눌림)",
    fn: (i, c) => c.rsi[i - 1] !== null && c.rsi[i - 1] < 40 && c.rsi[i] >= 40,
  },
  "ma-pullback": {
    name: "상승 추세 눌림목",
    side: "long",
    rule: "SMA20>SMA50, 종가>SMA200에서 저가가 SMA20 터치 후 종가는 위로 마감",
    fn: (i, c) =>
      c.sma200[i] !== null && c.sma20[i] > c.sma50[i] && c.candles[i].c > c.sma200[i] &&
      c.candles[i].l <= c.sma20[i] && c.candles[i].c > c.sma20[i],
  },
  "macd-cross-up": {
    name: "MACD 골든 교차",
    side: "long",
    rule: "MACD(12,26,9) 라인이 시그널을 상향 교차 마감",
    fn: (i, c) => c.macdSig[i - 1] !== null && c.macdLine[i - 1] <= c.macdSig[i - 1] && c.macdLine[i] > c.macdSig[i],
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
  "big-bar-continuation": {
    name: "장대양봉 추종",
    side: "long",
    rule: "범위 ≥ 2.5×ATR, 몸통 ≥ 70% 양봉, 종가가 직전 봉 고가 위",
    fn: (i, c) => {
      if (c.atr[i] === null) return false;
      const b = c.candles[i];
      const range = b.h - b.l;
      return range >= 2.5 * c.atr[i] && b.c > b.o && range > 0 &&
        (b.c - b.o) / range >= 0.7 && b.c > c.candles[i - 1].h;
    },
  },
  "squeeze-breakout": {
    name: "스퀴즈 상방 돌파",
    side: "long",
    rule: "BB(20,2σ) 폭이 직전 200봉 하위 20%로 수축한 뒤 종가가 상단 밖 마감",
    fn: (i, c) => c.squeeze[i] && c.bbUp[i] !== null && c.candles[i].c > c.bbUp[i],
  },
  "donchian-day-breakout": {
    name: "일중 채널 상방 돌파",
    side: "long",
    rule: "종가가 직전 1일치 봉(15m=96·1H=24)의 최고가 위로 마감",
    fn: (i, c) => c.hhDay[i] !== null && c.candles[i].c > c.hhDay[i],
  },
  "zscore-revert-long": {
    name: "z-스코어 과이격 반등",
    side: "long",
    rule: "종가 z(48봉) < −2 이탈 후 −2 위로 복귀 마감",
    fn: (i, c) => c.z[i - 1] !== null && c.z[i] !== null && c.z[i - 1] < -2 && c.z[i] >= -2,
  },
  "three-bar-reversal": {
    name: "쓰리바 리버설",
    side: "long",
    rule: "종가>SMA50에서 2연속 음봉 후 양봉이 직전 봉 고가 돌파 마감",
    fn: (i, c) => {
      if (i < 2 || c.sma50[i] === null) return false;
      const [a, b, d] = [c.candles[i - 2], c.candles[i - 1], c.candles[i]];
      return d.c > c.sma50[i] && a.c < a.o && b.c < b.o && d.c > d.o && d.c > b.h;
    },
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
    fn: (i, c) => c.macdSig[i - 1] !== null && c.macdLine[i - 1] >= c.macdSig[i - 1] && c.macdLine[i] < c.macdSig[i],
  },
  "squeeze-breakdown": {
    name: "스퀴즈 하방 이탈 숏",
    side: "short",
    rule: "BB(20,2σ) 폭이 직전 200봉 하위 20%로 수축한 뒤 종가가 하단 밖 마감",
    fn: (i, c) => c.squeeze[i] && c.bbLow[i] !== null && c.candles[i].c < c.bbLow[i],
  },
  "donchian-day-breakdown": {
    name: "일중 채널 하방 이탈 숏",
    side: "short",
    rule: "종가가 직전 1일치 봉의 최저가 아래로 마감",
    fn: (i, c) => c.llDay[i] !== null && c.candles[i].c < c.llDay[i],
  },
  "zscore-fade-short": {
    name: "z-스코어 과이격 반락 숏",
    side: "short",
    rule: "종가 z(48봉) > +2 이탈 후 +2 아래로 복귀 마감",
    fn: (i, c) => c.z[i - 1] !== null && c.z[i] !== null && c.z[i - 1] > 2 && c.z[i] <= 2,
  },
  "big-bar-breakdown": {
    name: "장대음봉 추종 숏",
    side: "short",
    rule: "범위 ≥ 2.5×ATR, 몸통 ≥ 70% 음봉, 종가가 직전 봉 저가 아래",
    fn: (i, c) => {
      if (c.atr[i] === null) return false;
      const b = c.candles[i];
      const range = b.h - b.l;
      return range >= 2.5 * c.atr[i] && b.c < b.o && range > 0 &&
        (b.o - b.c) / range >= 0.7 && b.c < c.candles[i - 1].l;
    },
  },
  "inside-bar-breakdown": {
    name: "인사이드바 하방 이탈 숏",
    side: "short",
    rule: "인사이드바 형성 후 종가가 모봉 저가 아래로 마감",
    fn: (i, c) =>
      i >= 2 &&
      c.candles[i - 1].h < c.candles[i - 2].h && c.candles[i - 1].l > c.candles[i - 2].l &&
      c.candles[i].c < c.candles[i - 2].l,
  },
  /* 베이시스(스왑−현물 괴리) 계열 — 파생 회차 신규. z 창은 30일(1H=720봉·4H=180봉). */
  "basis-rich-fade": {
    name: "베이시스 과열 복귀 숏",
    side: "short",
    rule: "베이시스 z(30일) +2 이탈 후 +2 아래 복귀 마감 — 과밀 롱 프리미엄의 소멸",
    fn: (i, c) => c.basisZ[i - 1] !== null && c.basisZ[i] !== null && c.basisZ[i - 1] >= 2 && c.basisZ[i] < 2,
  },
  "basis-cheap-long": {
    name: "베이시스 공포 복귀 롱",
    side: "long",
    rule: "베이시스 z(30일) −2 이탈 후 −2 위 복귀 마감 — 공포 디스카운트의 해소",
    fn: (i, c) => c.basisZ[i - 1] !== null && c.basisZ[i] !== null && c.basisZ[i - 1] <= -2 && c.basisZ[i] > -2,
  },
  "basis-flip-short": {
    name: "베이시스 부호 전환 숏",
    side: "short",
    rule: "베이시스가 프리미엄(+)에서 디스카운트(−)로 전환 마감",
    fn: (i, c) => c.basis[i - 1] !== null && c.basis[i] !== null && c.basis[i - 1] > 0 && c.basis[i] <= 0,
  },
  "basis-flip-long": {
    name: "베이시스 부호 전환 롱",
    side: "long",
    rule: "베이시스가 디스카운트(−)에서 프리미엄(+)으로 전환 마감",
    fn: (i, c) => c.basis[i - 1] !== null && c.basis[i] !== null && c.basis[i - 1] < 0 && c.basis[i] >= 0,
  },
  "basis-rich-breakdown": {
    name: "과열 프리미엄 + 채널 붕괴 숏",
    side: "short",
    rule: "베이시스 z ≥ +1.5 상태에서 종가가 직전 1일 채널 최저가 아래로 마감",
    fn: (i, c) => c.basisZ[i] !== null && c.basisZ[i] >= 1.5 && c.llDay[i] !== null && c.candles[i].c < c.llDay[i],
  },
  "basis-cheap-bounce": {
    name: "공포 디스카운트 + RSI 반등 롱",
    side: "long",
    rule: "베이시스 z ≤ −1.5 상태에서 RSI(14) 30 복귀 마감",
    fn: (i, c) =>
      c.basisZ[i] !== null && c.basisZ[i] <= -1.5 &&
      c.rsi[i - 1] !== null && c.rsi[i - 1] < 30 && c.rsi[i] >= 30,
  },
};

const FILTERS = {
  "htf4h-up": {
    name: "4H SMA20>SMA50",
    fn: (i, c) => {
      const d = c.htf4hIdx[i];
      return d >= 0 && c.h4Sma20[d] !== null && c.h4Sma50[d] !== null && c.h4Sma20[d] > c.h4Sma50[d];
    },
  },
  "htf4h-down": {
    name: "4H SMA20<SMA50",
    fn: (i, c) => {
      const d = c.htf4hIdx[i];
      return d >= 0 && c.h4Sma20[d] !== null && c.h4Sma50[d] !== null && c.h4Sma20[d] < c.h4Sma50[d];
    },
  },
  "htf1d-up": {
    name: "일봉>일봉SMA50",
    fn: (i, c) => {
      const d = c.htf1dIdx[i];
      return d >= 0 && c.dailySma50[d] !== null && c.daily[d].c > c.dailySma50[d];
    },
  },
  "htf1d-down": {
    name: "일봉<일봉SMA50",
    fn: (i, c) => {
      const d = c.htf1dIdx[i];
      return d >= 0 && c.dailySma50[d] !== null && c.daily[d].c < c.dailySma50[d];
    },
  },
  "vol-expand": { name: "거래량≥1.5×평균", fn: (i, c) => c.volMA[i] !== null && c.candles[i].v >= 1.5 * c.volMA[i] },
  "rsi-mid": { name: "RSI 35~65", fn: (i, c) => c.rsi[i] !== null && c.rsi[i] >= 35 && c.rsi[i] <= 65 },
  "atr-quiet": {
    name: "저변동 국면 (ATR<100봉 평균)",
    fn: (i, c) => c.atr[i] !== null && c.atrMA100[i] !== null && c.atr[i] < c.atrMA100[i],
  },
};

/* ---------- 체결 — 시리즈 공통 규칙 + MAE 추적 ---------- */

function walkExit(candles, entryIdx, entry, side, exit, atrSig, maxHold) {
  const dir = side === "long" ? 1 : -1;
  const slDist = exit.sl * atrSig;
  const tpDist = exit.tp * atrSig;
  const stop = entry - dir * slDist;
  const target = entry + dir * tpDist;

  let exitIdx = Math.min(entryIdx + maxHold - 1, candles.length - 1);
  let exitPrice = candles[exitIdx].c;
  let exitType = "time";
  let maeAdvPct = 0;
  const barAdv = (bar) => (dir === 1 ? ((entry - bar.l) / entry) * 100 : ((bar.h - entry) / entry) * 100);
  const openAdv = (bar) => (dir === 1 ? ((entry - bar.o) / entry) * 100 : ((bar.o - entry) / entry) * 100);
  for (let j = entryIdx; j <= exitIdx; j += 1) {
    const bar = candles[j];
    const hitSl = dir === 1 ? bar.l <= stop : bar.h >= stop;
    const hitTp = dir === 1 ? bar.h >= target : bar.l <= target;
    // 같은 봉에서 둘 다 걸리면 손절로 본다 — 봉 내부 경로를 모르니 보수적으로.
    if (hitSl) {
      exitIdx = j;
      exitPrice = dir === 1 ? Math.min(stop, bar.o) : Math.max(stop, bar.o);
      exitType = "sl";
      maeAdvPct = Math.max(maeAdvPct, (slDist / entry) * 100, j > entryIdx ? openAdv(bar) : 0);
      break;
    }
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
    slDistPct: (slDist / entry) * 100,
    maeAdvPct,
    grossPct: gross,
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
      entryAt: candles[entryIdx].t,
      exitAt: candles[x.exitIdx].t,
      entry,
      exit: x.exitPrice,
      exitType: x.exitType,
      holdBars: x.exitIdx - entryIdx + 1,
      slDistPct: Math.round(x.slDistPct * 1000) / 1000,
      maeAdvPct: Math.round(x.maeAdvPct * 1000) / 1000,
      grossPct: Math.round(x.grossPct * 1000) / 1000,
    });
    openUntil = x.exitIdx;
  }
  return trades;
}

/* ---------- 통계 — 비용 시나리오 파라미터화 ---------- */

function wilsonLow(wins, n, z = 1.96) {
  if (n === 0) return null;
  const p = wins / n;
  const den = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return ((center - margin) / den) * 100;
}

function stats(allTrades, periodEdges, feePct) {
  const trades = allTrades
    .filter((t) => t.exitType !== "open")
    .map((t) => ({ ...t, pnl: Math.round((t.grossPct - feePct) * 1000) / 1000 }))
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

  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const beWinRate = avgWin - avgLoss > 0 ? (-avgLoss / (avgWin - avgLoss)) * 100 : null;
  const winRateLow95 = wilsonLow(wins.length, n);

  const grossBeforeFee = trades.reduce((s, t) => s + Math.max(t.grossPct, 0), 0);
  const feeShare = grossBeforeFee > 0 ? ((n * feePct) / grossBeforeFee) * 100 : null;

  const periods = periodEdges.slice(0, -1).map((from, k) => {
    const to = periodEdges[k + 1];
    const ts = trades.filter((t) => t.entryAt >= from && t.entryAt < to);
    const sum = ts.reduce((s, t) => s + t.pnl, 0);
    return { n: ts.length, pnl: Math.round(sum * 1000) / 1000 };
  });

  const r = (x) => (x === null ? null : Math.round(x * 1000) / 1000);
  const spanDays = (periodEdges[periodEdges.length - 1] - periodEdges[0]) / 86400_000;
  return {
    fee: feePct,
    trades: n,
    perWeek: r(n / (spanDays / 7)),
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

/* ---------- 레버리지 — 테이커 비용 기준, $100 전액 격리 복리 ---------- */

function leverageRun(allTrades, lev, feePct) {
  const trades = allTrades
    .filter((t) => t.exitType !== "open")
    .slice()
    .sort((a, b) => a.exitAt - b.exitAt || a.entryAt - b.entryAt);
  const liqThr = 100 / lev - MAINT_PCT;
  let eq = START_EQ;
  let peak = START_EQ;
  let mdd = 0;
  let ruin = false;
  let liqEvents = 0;
  let worstTrade = 0;
  const curve = [{ at: trades[0]?.entryAt ?? 0, eq: START_EQ }];
  for (const t of trades) {
    const retRaw = lev * (t.grossPct - feePct);
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
    riskPerTradeHint: null, // runStrategy에서 채운다.
    curve: sampled,
  };
}

/* ---------- 실행 ---------- */

function loadCache() {
  if (!existsSync(CACHE)) {
    console.error(`캔들 캐시가 없다: ${CACHE}\n먼저 실행: node scripts/backtest/short-tf.mjs fetch`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(CACHE, "utf8"));
}

function buildCtx(candles, tfKey, h4, daily, spot = null) {
  const closes = candles.map((c) => c.c);
  const { line, signal } = macd(closes);
  const sma20v = sma(closes, 20);
  const sd20 = stdev(closes, 20);
  const bbUp = closes.map((_, i) => (sma20v[i] !== null && sd20[i] !== null ? sma20v[i] + 2 * sd20[i] : null));
  const bbLow = closes.map((_, i) => (sma20v[i] !== null && sd20[i] !== null ? sma20v[i] - 2 * sd20[i] : null));
  const bbw = closes.map((_, i) =>
    bbUp[i] !== null && sma20v[i] ? (bbUp[i] - bbLow[i]) / sma20v[i] : null,
  );
  const sma48v = sma(closes, 48);
  const sd48 = stdev(closes, 48);
  const atrArr = atr(candles);
  const dayBars = TFS[tfKey].dayBars;
  const ctx = {
    candles,
    rsi: rsi(closes),
    atr: atrArr,
    atrMA100: sma(atrArr.map((v) => v ?? 0), 100),
    volMA: volMA(candles),
    sma20: sma20v,
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    macdLine: line,
    macdSig: signal,
    bbUp,
    bbLow,
    squeeze: squeezeFlags(bbw),
    z: closes.map((c, i) => (sma48v[i] !== null && sd48[i] ? (c - sma48v[i]) / sd48[i] : null)),
    hhDay: rollingExtreme(candles, dayBars, (c) => c.h, true),
    llDay: rollingExtreme(candles, dayBars, (c) => c.l, false),
    daily,
    dailySma50: sma(daily.map((c) => c.c), 50),
    htf1dIdx: htfIndexMap(candles, daily, 86400_000),
    h4Sma20: sma(h4.map((c) => c.c), 20),
    h4Sma50: sma(h4.map((c) => c.c), 50),
    htf4hIdx: htfIndexMap(candles, h4, 4 * 3600_000),
  };
  // atrMA100은 atr null 구간(앞 14봉)을 0으로 섞으므로 초기 100봉은 무효 처리.
  for (let i = 0; i < Math.min(114, ctx.atrMA100.length); i += 1) ctx.atrMA100[i] = null;
  // 베이시스 — 같은 시가 시각의 현물 종가 대비 스왑 종가 괴리(%). 현물 봉이 없으면 null.
  // 두 종가 모두 봉 i 마감 시점에 확정되는 값이라 미래 참조가 없다. z 창 = 30일.
  if (spot) {
    const spotByT = new Map(spot.map((c) => [c.t, c.c]));
    ctx.basis = candles.map((c) => {
      const s = spotByT.get(c.t);
      return s ? Math.round(((c.c / s - 1) * 100) * 10000) / 10000 : null;
    });
    const zWin = tfKey === "1H" ? 720 : 180;
    ctx.basisZ = rollingZ(ctx.basis, zWin);
  } else {
    ctx.basis = new Array(candles.length).fill(null);
    ctx.basisZ = new Array(candles.length).fill(null);
  }
  return ctx;
}

function runStrategy(strat, cache) {
  const candles = cache.data[strat.tf];
  if (!candles || candles.length <= WARMUP + 1) {
    throw new Error(`캔들 부족: ${strat.tf} — ${candles?.length ?? 0}개 (워밍업 ${WARMUP} 초과 필요). fetch를 다시 실행하라.`);
  }
  // 베이시스 계열이면 현물 캐시 필수 — 없으면 조용한 0거래가 아니라 명확히 죽는다.
  const needsBasis = strat.base.startsWith("basis-");
  let spot = null;
  if (needsBasis) {
    if (!existsSync(CACHE_SPOT)) {
      throw new Error(`베이시스 전략(${strat.key})에는 현물 캐시가 필요하다 — 먼저 실행: node scripts/backtest/short-tf.mjs fetch-spot`);
    }
    const spotCache = JSON.parse(readFileSync(CACHE_SPOT, "utf8"));
    // 수집 시각 교차 가드 — 스왑·현물 창이 어긋나면 최근 표본이 조용히 빠진다(검증 에이전트 지적).
    const cacheGapH = Math.abs((spotCache.fetchedAt ?? 0) - (cache.fetchedAt ?? 0)) / 3600_000;
    if (cacheGapH > 6) {
      throw new Error(`스왑·현물 캐시 수집 시각이 ${Math.round(cacheGapH)}시간 어긋난다 — fetch와 fetch-spot을 같은 날 다시 실행하라.`);
    }
    spot = spotCache.data[strat.tf];
    if (!spot?.length) throw new Error(`현물 캐시에 ${strat.tf} 데이터가 없다 — fetch-spot을 다시 실행하라.`);
  }
  const ctx = buildCtx(candles, strat.tf, cache.data["4H"] ?? [], cache.data["1D"] ?? [], spot);
  const t0 = candles[WARMUP].t;
  const t1 = candles[candles.length - 1].t;
  const periodEdges = [t0, t0 + (t1 - t0) / 3, t0 + (2 * (t1 - t0)) / 3, t1 + 1];
  const maxHold = TFS[strat.tf].maxHold;

  const byExit = EXITS.map((exit) => {
    const trades = simulate(candles, ctx, strat, exit, maxHold);
    const st = { taker: stats(trades, periodEdges, FEES.taker), maker: stats(trades, periodEdges, FEES.maker) };
    const levers = LEVERS.map((L) => {
      const run = leverageRun(trades, L, FEES.taker);
      const closedN = st.taker.trades;
      const avgSl = closedN
        ? trades.filter((t) => t.exitType !== "open").reduce((s, t) => s + t.slDistPct, 0) / closedN
        : 0;
      run.riskPerTradeHint = Math.round(L * (avgSl + FEES.taker) * 100) / 100;
      return run;
    });
    return { exit: exit.key, exitName: exit.name, rr: exit.rr, sl: exit.sl, tp: exit.tp, stats: st, levers, trades };
  });

  // 저장 크기 관리 — 테이커 t값 최고 기하의 거래만 최근 400건.
  const best = byExit.slice().sort((a, b) => (b.stats.taker.tstat ?? -9) - (a.stats.taker.tstat ?? -9))[0];
  for (const e of byExit) {
    if (e === best) {
      e.trades = e.trades.slice(-400).map((t) => ({
        entryAt: t.entryAt, exitAt: t.exitAt, entry: t.entry, exit: t.exit,
        exitType: t.exitType, holdBars: t.holdBars, grossPct: t.grossPct, maeAdvPct: t.maeAdvPct,
      }));
      e.tradesNote = "테이커 t값 최고 기하만 최근 400건 저장 (pnl = grossPct − 수수료)";
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
      const t = e.stats.taker;
      const m = e.stats.maker;
      console.log(
        `${e.exitName.padEnd(16)} ${String(t.trades).padStart(4)}건 승률 ${t.winRate}% 기대값 ${t.avgPnl}% t=${t.tstat} PF ${t.profitFactor}` +
        ` 구간 ${t.positivePeriods}/3 잠식 ${t.feeShare}% | 메이커: 기대값 ${m.avgPnl}% t=${m.tstat}`,
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
      fees: FEES,
      gateFee: GATE_FEE,
      warmup: WARMUP,
      maintPct: MAINT_PCT,
      levers: LEVERS,
      exits: EXITS,
      startEq: START_EQ,
      tfs: Object.fromEntries(Object.entries(TFS).map(([k, v]) => [k, { days: v.days, maxHold: v.maxHold, dayBars: v.dayBars }])),
      sampleGate: { "15m": 300, "1H": 200, "4H": 100 },
      rules: {
        entry: "신호 봉 마감 → 다음 봉 시가 진입",
        exit: "청산 기하 4단계: 손절/목표 = 1/1 · 1.5/3 · 2/6 · 3/9 ×ATR(14) — 보유 시한 도달 시 종가 청산",
        fee: `왕복 테이커 ${FEES.taker}% / 메이커 진입 ${FEES.maker}% × 레버리지 (펀딩비 제외) — 판정은 테이커 기준`,
        conflict: "같은 봉에서 목표·손절 동시 도달 시 손절로 집계(보수적)",
        gap: "시가가 손절 너머 갭이면 시가 체결, 보유 중 역행 극값(MAE)이 청산 문턱(100/L−0.5%)을 넘으면 증거금 전액 소실",
        lock: "보유 중 새 신호 무시 — 전략당 한 포지션",
        leverage: "$100 전액 격리·복리, 명목 = 자산 × L (테이커 비용 기준)",
      },
      dataFetchedAt: cache.fetchedAt,
      // 봉별 실제 수집 시각 — 1H/4H/1D는 같은 날 기존 캐시 재사용(15m과 최대 1시간 차).
      tfFetchedAt: cache.tfFetchedAt ?? null,
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
  const out = join(repoRoot, "docs", "backtest", `${kstDay}-${MERGE_TAG}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(merged));
  console.log(`전략 ${merged.strategies.length}개 병합 → ${out}`);
}

function cmdReport() {
  const dir = join(repoRoot, "docs", "backtest");
  const rounds = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-short-tf\.json$/.test(f)).sort();
  if (!rounds.length) {
    console.error("종합 JSON이 없다 — 먼저 merge를 실행하라.");
    process.exit(1);
  }
  const jsonName = rounds[rounds.length - 1];
  const html = readFileSync(join(repoRoot, "scripts", "backtest", "short-tf-template.html"), "utf8")
    .replace("__DATA_JSON__", readFileSync(join(dir, jsonName), "utf8"))
    .replace("__DATA_PATH__", `docs/backtest/${jsonName}`);
  const out = join(dir, "short-tf-report.html");
  writeFileSync(out, html);
  console.log(`${jsonName} → ${out}`);
}

const cmd = process.argv[2];
if (cmd === "fetch") await cmdFetch();
else if (cmd === "fetch-spot") await cmdFetchSpot();
else if (cmd === "run") cmdRun(process.argv.slice(3));
else if (cmd === "merge") cmdMerge();
else if (cmd === "report") cmdReport();
else {
  console.log("사용: node scripts/backtest/short-tf.mjs <fetch|run|merge|report>");
  process.exit(1);
}
