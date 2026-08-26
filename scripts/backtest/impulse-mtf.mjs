/**
 * IMPULSE-MTF 회차 — 임펄스 시작점의 다중봉(1m·15m·1H·4H·1D·1W) 스냅샷 원장.
 *
 * oneway 회차가 "되돌리지 않고 1% 이상 간 구간이 얼마나 자주 나오는가"를 스캔 봉
 * 하나에서 물었다면, 이 회차는 그 시작 시점에 "다른 봉들은 어떤 모습이었나"를 더한다.
 * 스캔 봉 4개(1m·15m·1H·4H) 각각의 leg 시작점마다 여섯 봉의 지표 스냅샷을 남기고,
 * 스냅샷 시각 이후의 정보는 어떤 형태로도 들여다보지 않는다(미래 참조 없음).
 *
 * 이 회차도 전략 성과를 재지 않는다 — oneway 와 같은 이유로 시장이 준 폭만 잰다.
 *
 * 정본: .backlog/2-active/REQ-0008_feat_active_impulse-mtf-snapshot.md
 *
 * 사용:
 *   node scripts/backtest/oneway-fetch.mjs 1W   → 1W 캔들 수집(최초 1회)
 *   node --max-old-space-size=8192 scripts/backtest/impulse-mtf.mjs run
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { C, H, L, O, T, V, decompose } from "./lib/oneway-core.mjs";
import { WARMUP, computeTa } from "./lib/oneway-ta.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = join(repoRoot, "scripts", "backtest", ".cache");
const OUTDIR = join(repoRoot, "docs", "backtest");

const R = 0.01; // 되돌림 임계 — 요청 정의 그대로 1%
const MIN_ABS = 1; // |이동| >= 1% 만 이벤트로 담는다
const BUCKETS = [1, 2, 3, 5];

const SCAN_TFS = ["1m", "15m", "1H", "4H"];
const SNAP_TFS = ["1m", "15m", "1H", "4H", "1D", "1W"];
const TF_MS = { "1m": 60_000, "15m": 900_000, "1H": 3_600_000, "4H": 14_400_000, "1D": 86_400_000, "1W": 604_800_000 };
const TF_LABEL = { "1m": "1분봉", "15m": "15분봉", "1H": "1시간봉", "4H": "4시간봉", "1D": "일봉", "1W": "주봉" };

const KST = (t) => new Date(t + 9 * 3600_000);
const iso = (t) => new Date(t + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 16);
const q = (arr, p) => {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const pct100 = (v) => Math.max(0, Math.min(100, Math.round(v * 100)));

function loadTf(tf) {
  const p = join(CACHE, `oneway-${tf}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

/* ---------------------------------------------------------------------------
 * oneway.mjs 에서 복사한 것들.
 *
 * oneway.mjs 는 CONDITIONS·legStats 를 export 하지 않는다. import 로 재사용하려면
 * oneway.mjs 자체를 불러와야 하는데, 그 파일 맨 아래에 `if (cmd === "run") cmdRun();`
 * 가 최상위 코드로 있어 이 스크립트도 인자로 "run" 을 쓰는 이상 import 하는 순간
 * oneway 의 cmdRun() 이 함께 실행되는 부작용이 생긴다. 그래서 필요한 만큼만
 * 그대로 옮겨 쓴다 — 로직은 바꾸지 않는다.
 * ------------------------------------------------------------------------- */

/** oneway.mjs CONDITIONS 그대로. */
const CONDITIONS = [
  { key: "bbw-squeeze", group: "변동성", name: "밴드폭 수축 (하위 20%)", test: (ta, i) => ta.bbWPct[i] <= 0.2 },
  { key: "bbw-expand", group: "변동성", name: "밴드폭 확장 (상위 20%)", test: (ta, i) => ta.bbWPct[i] >= 0.8 },
  { key: "atr-quiet", group: "변동성", name: "ATR 하위 20%", test: (ta, i) => ta.atrPctile[i] <= 0.2 },
  { key: "atr-loud", group: "변동성", name: "ATR 상위 20%", test: (ta, i) => ta.atrPctile[i] >= 0.8 },
  { key: "rsi-os", group: "모멘텀", name: "RSI <= 30 (과매도)", test: (ta, i) => ta.rsi[i] <= 30 },
  { key: "rsi-ob", group: "모멘텀", name: "RSI >= 70 (과매수)", test: (ta, i) => ta.rsi[i] >= 70 },
  { key: "rsi-mid", group: "모멘텀", name: "RSI 45~55 (중립)", test: (ta, i) => ta.rsi[i] >= 45 && ta.rsi[i] <= 55 },
  { key: "bb-upper", group: "위치", name: "볼린저 상단 이탈 (%b >= 1)", test: (ta, i) => ta.bbPb[i] >= 1 },
  { key: "bb-lower", group: "위치", name: "볼린저 하단 이탈 (%b <= 0)", test: (ta, i) => ta.bbPb[i] <= 0 },
  { key: "dc-high", group: "위치", name: "1일 채널 상단 (상위 5%)", test: (ta, i) => ta.dcPos[i] >= 0.95 },
  { key: "dc-low", group: "위치", name: "1일 채널 하단 (하위 5%)", test: (ta, i) => ta.dcPos[i] <= 0.05 },
  { key: "ma-up", group: "추세", name: "이평 정배열 (20>50>200)", test: (ta, i) => ta.stack[i] === 1 },
  { key: "ma-dn", group: "추세", name: "이평 역배열 (20<50<200)", test: (ta, i) => ta.stack[i] === -1 },
  { key: "h4-up", group: "추세", name: "4H 상승 정렬", test: (ta, i) => ta.h4[i] === 1 },
  { key: "h4-dn", group: "추세", name: "4H 하락 정렬", test: (ta, i) => ta.h4[i] === -1 },
  { key: "d1-up", group: "추세", name: "1D 상승 정렬", test: (ta, i) => ta.d1[i] === 1 },
  { key: "d1-dn", group: "추세", name: "1D 하락 정렬", test: (ta, i) => ta.d1[i] === -1 },
  { key: "vol-burst", group: "거래량", name: "거래량 2배 이상", test: (ta, i) => ta.volR[i] >= 2 },
  { key: "vol-dry", group: "거래량", name: "거래량 0.5배 이하", test: (ta, i) => ta.volR[i] <= 0.5 },
  { key: "sqz-vol", group: "복합", name: "밴드폭 수축 + 거래량 2배", test: (ta, i) => ta.bbWPct[i] <= 0.2 && ta.volR[i] >= 2 },
  { key: "dchigh-h4up", group: "복합", name: "채널 상단 + 4H 상승", test: (ta, i) => ta.dcPos[i] >= 0.95 && ta.h4[i] === 1 },
  { key: "dclow-h4dn", group: "복합", name: "채널 하단 + 4H 하락", test: (ta, i) => ta.dcPos[i] <= 0.05 && ta.h4[i] === -1 },
  { key: "quiet-edge", group: "복합", name: "ATR 하위 20% + 채널 끝단", test: (ta, i) => ta.atrPctile[i] <= 0.2 && (ta.dcPos[i] >= 0.95 || ta.dcPos[i] <= 0.05) },
  { key: "burst-upper", group: "복합", name: "거래량 2배 + 볼린저 상단 이탈", test: (ta, i) => ta.volR[i] >= 2 && ta.bbPb[i] >= 1 },
  { key: "burst-lower", group: "복합", name: "거래량 2배 + 볼린저 하단 이탈", test: (ta, i) => ta.volR[i] >= 2 && ta.bbPb[i] <= 0 },
];
// 주의: h4-up/h4-dn/d1-up/d1-dn 과 이를 쓰는 두 복합 조건(dchigh-h4up·dclow-h4dn)은
// ta.h4/ta.d1 을 본다. 스캔 봉(1m·15m·1H·4H)의 computeTa 는 oneway 와 같이
// htf={h4:4H 캐시, d1:1D 캐시} 를 넘겨 계산하므로(아래 "스냅샷 지표 계산" 절) 이
// 조건들도 실제로 작동한다. 스냅샷 전용 봉(1D·1W)은 CONDITIONS 를 채점하지 않으므로
// htf 없이 계산해도 결과에 영향이 없다.

/** oneway.mjs legStats 그대로. */
function legStats(legs, spanYears, dirFilter, minAbs) {
  const sel = legs.filter((l) => (dirFilter === 0 || l.dir === dirFilter) && Math.abs(l.movePct) >= minAbs);
  if (!sel.length) return { count: 0, perYear: 0, perMonth: 0 };
  const moves = sel.map((l) => Math.abs(l.movePct));
  const bars = sel.map((l) => l.bars);
  const hours = sel.map((l) => l.ms / 3600_000);
  const maes = sel.map((l) => l.mae);
  const retrs = sel.map((l) => l.retr);
  const speed = sel.map((l) => Math.abs(l.movePct) / Math.max(l.ms / 3600_000, 1e-6));
  let maxMove = 0;
  for (const m of moves) if (m > maxMove) maxMove = m;
  return {
    count: sel.length,
    perYear: r2(sel.length / spanYears),
    perMonth: r2(sel.length / (spanYears * 12)),
    upShare: r2((sel.filter((l) => l.dir === 1).length / sel.length) * 100),
    move: { avg: r2(mean(moves)), p50: r2(q(moves, 0.5)), p90: r2(q(moves, 0.9)), max: r2(maxMove) },
    bars: { avg: r2(mean(bars)), p50: r2(q(bars, 0.5)), p90: r2(q(bars, 0.9)) },
    hours: { avg: r2(mean(hours)), p50: r2(q(hours, 0.5)), p90: r2(q(hours, 0.9)) },
    mae: { avg: r3(mean(maes)), p50: r3(q(maes, 0.5)), p90: r3(q(maes, 0.9)) },
    retr: { avg: r3(mean(retrs)), p50: r3(q(retrs, 0.5)), p90: r3(q(retrs, 0.9)) },
    speed: { avg: r2(mean(speed)), p50: r2(q(speed, 0.5)) },
  };
}

/* ---------------------------------------------------------------------------
 * 스냅샷 — 시작 봉 마감 시각 τ 기준, 각 봉에서 "마감 <= τ" 인 마지막 봉.
 * ------------------------------------------------------------------------- */

/**
 * τ 가 호출마다 단조 증가한다는 전제로 j 를 앞으로만 움직이는 투포인터.
 * 스캔 봉의 leg 들은 si 오름차순으로 나오고(decompose 가 그렇게 만든다),
 * τ = rows[si][T] + scanMs 도 si 를 따라 오름차순이므로 이 전제가 성립한다.
 */
function makeWalker(rows, snapMs) {
  let j = 0;
  return (tau) => {
    while (j + 1 < rows.length && rows[j + 1][T] + snapMs <= tau) j += 1;
    if (rows[j][T] + snapMs <= tau) return j;
    return null; // 이 봉이 τ 이전에 마감된 적이 아직 없다
  };
}

/** dir 은 oneway-ta htfAlign 과 같은 부등식(e20/e50/종가)으로 그 봉에서 직접 판정한다. */
function buildSnapVals(ta, rows, j) {
  const dir = ta.e20[j] > ta.e50[j] && rows[j][C] > ta.e20[j] ? 1 : ta.e20[j] < ta.e50[j] && rows[j][C] < ta.e20[j] ? -1 : 0;
  return [
    dir,
    ta.stack[j],
    r1(ta.rsi[j]),
    r2(ta.bbPb[j]),
    pct100(ta.bbWPct[j]),
    pct100(ta.atrPctile[j]),
    r2(ta.distE200[j]),
    r2(ta.volR[j]),
    pct100(ta.dcPos[j]),
  ];
}

const NULL9 = Object.freeze(Array(9).fill(null));

/* ---------------------------------------------------------------------------
 * 리프트 — 스캔 봉 시작봉 조건 켜진 비율 / 구간 전체 봉 켜진 비율.
 * ------------------------------------------------------------------------- */

function windowIdxBounds(rows, from, to) {
  let lo = -1, hi = -1;
  for (let i = 0; i < rows.length; i += 1) if (rows[i][T] >= from) { lo = i; break; }
  for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i][T] <= to) { hi = i; break; }
  return [lo, hi];
}

function computeBaseCounts(ta, loIdx, hiIdx) {
  const baseN = hiIdx >= loIdx ? hiIdx - loIdx + 1 : 0;
  return CONDITIONS.map((cond) => {
    let c = 0;
    for (let i = loIdx; i <= hiIdx; i += 1) if (cond.test(ta, i)) c += 1;
    return { cond, base: c, basePct: baseN > 0 ? (c / baseN) * 100 : 0 };
  });
}

function computeLift(dirLegs, ta, baseCounts) {
  const n = dirLegs.length;
  if (!n) return [];
  return baseCounts
    .map((b) => {
      let hit = 0;
      for (const l of dirLegs) if (b.cond.test(ta, l.si)) hit += 1;
      const rate = (hit / n) * 100;
      return { key: b.cond.key, rate: r2(rate), base: r2(b.basePct), lift: b.basePct > 0 ? r2(rate / b.basePct) : 0, n: hit };
    })
    .sort((a, b) => b.lift - a.lift);
}

/* ---------------------------------------------------------------------------
 * 프로파일 — ≥1% 이벤트의 스냅 지표 분포(평균·사분위) + dir 분포.
 * ------------------------------------------------------------------------- */

const METRIC_IDX = { rsi: 2, bbPb: 3, bbWPct: 4, atrPctile: 5, distE200: 6, volR: 7, dcPos: 8 };
const METRICS = Object.keys(METRIC_IDX);

function buildProfile(eventsBuilt, dirVal) {
  const sel = eventsBuilt.filter((e) => e.leg.dir === dirVal);
  const out = {};
  for (const s of SNAP_TFS) {
    const tfObj = {};
    for (const m of METRICS) {
      const idx = METRIC_IDX[m];
      const arr = [];
      for (const e of sel) {
        const v = e.snaps[s].vals[idx];
        if (v !== null) arr.push(v);
      }
      tfObj[m] = arr.length
        ? { mean: r2(mean(arr)), p25: r2(q(arr, 0.25)), p50: r2(q(arr, 0.5)), p75: r2(q(arr, 0.75)) }
        : { mean: 0, p25: 0, p50: 0, p75: 0 };
    }
    let up = 0, dn = 0, mix = 0, total = 0;
    for (const e of sel) {
      const d = e.snaps[s].vals[0];
      if (d === null) continue;
      total += 1;
      if (d === 1) up += 1; else if (d === -1) dn += 1; else mix += 1;
    }
    tfObj.dirShare = { up: total ? r2((up / total) * 100) : 0, dn: total ? r2((dn / total) * 100) : 0, mix: total ? r2((mix / total) * 100) : 0, total };
    out[s] = tfObj;
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 샘플 — 스캔 봉 × 방향마다 최대 12건. windows 는 스냅샷 인덱스 기준 앞 96 + 뒤 24.
 * ------------------------------------------------------------------------- */

/**
 * 20봉 롤링 볼린저 상·하단을 직접 계산한다(computeTa 는 %b·밴드폭만 준다).
 *
 * 창 시작 인덱스 from(=j0) 앞의 최대 19봉까지 끌어와 워밍업만 하고, 출력은 [from,to]
 * 범위만 담는다 — 그래야 창 맨 앞줄부터 20봉 SMA 가 온전히 선다. 캐시 맨 앞이라
 * 19봉을 다 못 끌어올 때만(from-19<0) 워밍업이 짧아 창 앞쪽 폭이 좁게 나온다.
 */
function localBollinger(rows, from, to) {
  const period = 20, mult = 2;
  const bbU = [], bbL = [];
  const buf = [];
  let sum = 0, sumSq = 0;
  const computeFrom = Math.max(0, from - (period - 1));
  for (let i = computeFrom; i <= to; i += 1) {
    const c = rows[i][C];
    buf.push(c); sum += c; sumSq += c * c;
    if (buf.length > period) { const o = buf.shift(); sum -= o; sumSq -= o * o; }
    if (i < from) continue; // 워밍업 구간은 출력하지 않는다
    const cnt = buf.length;
    const m = sum / cnt;
    const varr = Math.max(0, sumSq / cnt - m * m);
    const sd = Math.sqrt(varr);
    bbU.push(Math.round(m + mult * sd));
    bbL.push(Math.round(m - mult * sd));
  }
  return { bbU, bbL };
}

function buildSampleWindows(builtEntry, rows6, ta6) {
  const windows = {};
  for (const s of SNAP_TFS) {
    const j = builtEntry.snaps[s].j;
    if (j === null) { windows[s] = null; continue; }
    const rs = rows6[s], taS = ta6[s];
    const from = Math.max(0, j - 96);
    const to = Math.min(rs.length - 1, j + 24);
    const candles = [];
    const e20 = [], e50 = [], e200 = [], rsiArr = [];
    for (let i = from; i <= to; i += 1) {
      candles.push([rs[i][T], Math.round(rs[i][O]), Math.round(rs[i][H]), Math.round(rs[i][L]), Math.round(rs[i][C]), Math.round(rs[i][V])]);
      e20.push(Math.round(taS.e20[i]));
      e50.push(Math.round(taS.e50[i]));
      e200.push(Math.round(taS.e200[i]));
      rsiArr.push(r1(taS.rsi[i]));
    }
    const { bbU, bbL } = localBollinger(rs, from, to);
    windows[s] = { candles, e20, e50, e200, bbU, bbL, rsi: rsiArr };
  }
  return windows;
}

/**
 * 대표 사례 6축 × 2건 = 최대 12건 — oneway samples() 와 같은 결로 고르되, 마지막 축은
 * 이 회차에만 있는 "상위 리프트 조건 대표": 그 방향에서 리프트가 가장 높은 조건 둘을
 * 각각 만족하는 이벤트 중 이동폭이 가장 큰 것을 하나씩 뽑는다(이미 뽑힌 leg 는 건너뜀).
 */
function pickSamples(eventsLegs, builtBySi, rows, ta, dirVal, liftForDir, rows6, ta6) {
  const pool = eventsLegs.filter((l) => l.dir === dirVal);
  if (!pool.length) return [];

  const picked = [];
  const seen = new Set();
  const add = (l, why) => { if (!l || seen.has(l.si)) return; seen.add(l.si); picked.push({ l, why }); };
  const take = (arr, n, why) => arr.slice(0, n).forEach((l) => add(l, why));

  take([...pool].sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct)), 2, "이동폭 최대");
  take([...pool].sort((a, b) => b.bars - a.bars), 2, "가장 오래 간 구간");
  take([...pool].filter((l) => l.bars >= 10).sort((a, b) => a.retr - b.retr), 2, "되돌림이 가장 얕았던 구간");
  take([...pool].sort((a, b) => b.si - a.si), 2, "가장 최근");

  const mMove = q(pool.map((l) => Math.abs(l.movePct)), 0.5);
  const mBars = q(pool.map((l) => l.bars), 0.5);
  take(
    [...pool].sort((a, b) => {
      const da = Math.abs(Math.abs(a.movePct) - mMove) / Math.max(mMove, 1e-9) + Math.abs(a.bars - mBars) / Math.max(mBars, 1);
      const db = Math.abs(Math.abs(b.movePct) - mMove) / Math.max(mMove, 1e-9) + Math.abs(b.bars - mBars) / Math.max(mBars, 1);
      return da - db;
    }),
    2,
    "가장 전형적인 축",
  );

  for (const cond of liftForDir.slice(0, 2)) {
    const def = CONDITIONS.find((c) => c.key === cond.key);
    const matched = pool.filter((l) => def.test(ta, l.si));
    const best = [...matched].sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct))[0];
    add(best, `조건: ${def.name}`);
  }

  return picked.map(({ l, why }) => {
    const entry = builtBySi.get(l.si);
    return {
      why, dir: l.dir,
      t: rows[l.si][T], kst: iso(rows[l.si][T]), tEnd: rows[l.ei][T],
      movePct: r2(l.movePct), bars: l.bars, hours: r2(l.ms / 3600_000), retr: r3(l.retr),
      sp: r2(l.sp), ep: r2(l.ep),
      windows: buildSampleWindows(entry, rows6, ta6),
    };
  });
}

/* ---------------------------------------------------------------------------
 * 실행
 * ------------------------------------------------------------------------- */

function runScan(scanTf, rows6, ta6, window, spanYears) {
  const rows = rows6[scanTf];
  const ta = ta6[scanTf];
  const scanMs = TF_MS[scanTf];

  const legsAll = decompose(rows, R);

  // 불변식 ① — 구간 내 되돌림은 정의상 R 미만이어야 한다.
  const bad = legsAll.filter((l) => l.retr >= R * 100 + 1e-9);
  if (bad.length) {
    console.error(`✗ [${scanTf}] 되돌림이 임계를 넘은 구간 ${bad.length}건 — 중단`);
    process.exit(1);
  }

  const legsWindow = legsAll.filter((l) => rows[l.si][T] >= window.fromMs && rows[l.si][T] <= window.toMs);
  const legsTotal = legsWindow.length;
  const eventsLegs = legsWindow.filter((l) => Math.abs(l.movePct) >= MIN_ABS);

  // 스냅샷 투포인터 — 봉마다 독립, τ 는 이 스캔 봉의 leg 들을 si 오름차순으로 먹이는 동안 단조 증가.
  const walkers = {};
  for (const s of SNAP_TFS) walkers[s] = makeWalker(rows6[s], TF_MS[s]);

  const eventsBuilt = eventsLegs.map((l) => {
    const tau = rows[l.si][T] + scanMs;
    const snaps = {};
    for (const s of SNAP_TFS) {
      const j = walkers[s](tau);
      if (j === null) { snaps[s] = { vals: NULL9, j: null }; continue; }
      // 불변식 ② — 이 봉의 마감이 τ 를 넘지 않아야 하고, 스캔 봉 자신은 정확히 si 여야 한다.
      if (rows6[s][j][T] + TF_MS[s] > tau) {
        console.error(`✗ [${scanTf}] 스냅샷 마감이 τ 를 넘음 (snapTf=${s}, j=${j}) — 중단`);
        process.exit(1);
      }
      if (s === scanTf && j !== l.si) {
        console.error(`✗ [${scanTf}] 자기 스냅샷 인덱스 불일치 (si=${l.si}, j=${j}) — 중단`);
        process.exit(1);
      }
      snaps[s] = { vals: buildSnapVals(ta6[s], rows6[s], j), j };
    }
    const row = [
      rows[l.si][T], l.dir, r2(l.movePct), l.bars, r2(l.ms / 3600_000), r3(l.retr), r3(l.mae),
      ...SNAP_TFS.flatMap((s) => snaps[s].vals),
    ];
    // 불변식 ③ — 이벤트 행 길이 = 7 + 9*6 = 61.
    if (row.length !== 61) {
      console.error(`✗ [${scanTf}] 이벤트 행 길이 ${row.length} (기대 61) — 중단`);
      process.exit(1);
    }
    return { leg: l, row, snaps };
  });

  const builtBySi = new Map(eventsBuilt.map((e) => [e.leg.si, e]));

  const stats = {};
  for (const b of BUCKETS) {
    stats[b] = {
      both: legStats(legsWindow, spanYears, 0, b),
      up: legStats(legsWindow, spanYears, 1, b),
      down: legStats(legsWindow, spanYears, -1, b),
    };
  }

  const histMap = new Map();
  for (const l of legsWindow) {
    const a = Math.abs(l.movePct);
    const k = a < 1 ? "0-1" : a < 2 ? "1-2" : a < 3 ? "2-3" : a < 5 ? "3-5" : a < 10 ? "5-10" : a < 20 ? "10-20" : "20+";
    if (!histMap.has(k)) histMap.set(k, { range: k, up: 0, dn: 0 });
    histMap.get(k)[l.dir === 1 ? "up" : "dn"] += 1;
  }
  const order = ["0-1", "1-2", "2-3", "3-5", "5-10", "10-20", "20+"];
  const hist = order.filter((k) => histMap.has(k)).map((k) => ({ ...histMap.get(k), total: histMap.get(k).up + histMap.get(k).dn }));

  const profile = { up: buildProfile(eventsBuilt, 1), dn: buildProfile(eventsBuilt, -1) };

  const [loIdx, hiIdx] = windowIdxBounds(rows, window.fromMs, window.toMs);
  const baseCounts = computeBaseCounts(ta, loIdx, hiIdx);
  const liftUp = computeLift(eventsLegs.filter((l) => l.dir === 1), ta, baseCounts);
  const liftDn = computeLift(eventsLegs.filter((l) => l.dir === -1), ta, baseCounts);

  const samplesUp = pickSamples(eventsLegs, builtBySi, rows, ta, 1, liftUp, rows6, ta6);
  const samplesDn = pickSamples(eventsLegs, builtBySi, rows, ta, -1, liftDn, rows6, ta6);

  return {
    tf: scanTf, label: TF_LABEL[scanTf], bars: rows.length, legsTotal,
    stats, hist, profile,
    lift: { up: liftUp, dn: liftDn },
    events: eventsBuilt.map((e) => e.row),
    samples: [...samplesUp, ...samplesDn],
  };
}

function cmdRun() {
  console.log("캐시 로드…");
  const rows6 = {};
  for (const s of SNAP_TFS) {
    rows6[s] = loadTf(s);
    if (!rows6[s]) { console.error(`✗ 캐시 없음: ${s} — oneway-fetch.mjs 를 먼저 돌리세요.`); process.exit(1); }
  }

  console.log("스냅샷 지표 계산(6봉 각 전체 캐시)…");
  // 스캔 봉(1m·15m·1H·4H)은 oneway 와 같은 htf={h4,d1}(4H·1D 캐시 전체) 를 넘겨
  // h4-up/h4-dn/d1-up/d1-dn 및 복합 2조건이 실제로 작동하게 한다. 스냅샷 전용 봉
  // (1D·1W) 은 CONDITIONS 를 채점하지 않으므로 htf 없이 계산해도 무방하다. 스캔
  // 봉과 스냅샷 봉이 같은 TF 일 때는 htf 를 넘긴 것 하나를 공유한다 — 스냅샷 9칸
  // (dir·stack·rsi·bbPb·bbWPct·atrPctile·distE200·volR·dcPos) 은 ta.h4/ta.d1 을
  // 쓰지 않으므로 htf 유무가 그 값에 영향을 주지 않는다.
  const htfForScan = { h4: rows6["4H"], d1: rows6["1D"] };
  const ta6 = {};
  for (const s of SNAP_TFS) {
    const t0 = Date.now();
    ta6[s] = computeTa(rows6[s], SCAN_TFS.includes(s) ? htfForScan : {});
    console.log(`  [${s}] ${rows6[s].length.toLocaleString()}봉 · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // 공통 구간 — 1m 캐시(가장 짧다, 540일)가 상한. WARMUP 만큼은 1m 자기 지표가
  // 아직 서지 않은 구간이라 시작점에서 제외한다.
  const rows1m = rows6["1m"];
  const fromMs = rows1m[0][T] + WARMUP * TF_MS["1m"];
  const toMs = rows1m[rows1m.length - 1][T];
  const window = {
    from: iso(fromMs), fromMs,
    to: iso(toMs), toMs,
    days: Math.round((toMs - fromMs) / 86_400_000),
  };
  const spanYears = (toMs - fromMs) / (365.25 * 86_400_000);
  console.log(`\n공통 구간: ${window.from} → ${window.to} (${window.days}일)`);

  const scans = [];
  for (const scanTf of SCAN_TFS) {
    const t0 = Date.now();
    const res = runScan(scanTf, rows6, ta6, window, spanYears);
    scans.push(res);
    console.log(
      `[${scanTf}] leg ${res.legsTotal.toLocaleString()} · >=1% ${res.events.length.toLocaleString()} · ` +
        `up ${res.events.filter((e) => e[1] === 1).length.toLocaleString()} · dn ${res.events.filter((e) => e[1] === -1).length.toLocaleString()} · ` +
        `샘플 ${res.samples.length} · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  }

  const fetchPath = join(CACHE, "oneway-fetch-report.json");
  const fetchReport = existsSync(fetchPath) ? JSON.parse(readFileSync(fetchPath, "utf8")) : [];

  const data = {
    round: "impulse-mtf",
    name: "임펄스 시작점 다중봉 스냅샷",
    generatedAt: new Date().toISOString(),
    inst: "BTC-USDT-SWAP (OKX)",
    question:
      "BTC 가 되돌리지 않고 1% 이상 한 방향으로 가는 구간이 시작될 때, 그 순간 1m·15m·1H·4H·1D·1W 여섯 봉은 각각 어떤 모습이었는가",
    definition: {
      leg: "극값까지 이어지되 그 안의 최대 되돌림이 한 번도 R% 에 닿지 않는, 가장 이른 지점에서 시작하는 구간. 되돌림은 진행 중 갱신된 극값 대비로 잰다. (oneway 와 같은 정의, R=1%)",
      snapshot:
        "스냅샷 시각 τ = 시작 봉의 마감 시각(시작 봉 시각 + 스캔 봉 길이). 각 스냅샷 봉에서 '마감(봉 시작 시각 + 그 봉 길이) <= τ' 인 마지막 봉을 취한다 — 미래 참조 없음. 스캔 봉 자신은 이 규칙으로 정확히 시작 봉(si) 이 나온다. 해당 봉이 τ 이전에 마감된 적이 없으면 스냅샷 9칸은 전부 null.",
      window:
        "공통 구간은 여섯 봉이 모두 존재하는 구간으로, 1m 캐시(540일)가 상한이다. from = 1m 캐시 첫 봉 + WARMUP(260)봉 시각, to = 1m 캐시 마지막 봉 시각. 상위봉 지표는 전체 캐시(최대 2400일)로 계산해 워밍업이 구간을 잠식하지 않게 한다.",
    },
    caveats: [
      "수수료·슬리피지·펀딩·체결 지연이 전혀 들어 있지 않다. 여기 수치는 시장이 준 폭의 상한이지 손익이 아니다.",
      "임펄스의 시작과 끝은 사후에만 확정된다. 스캔 봉과 그보다 짧은 봉의 스냅샷은 시작점이 극값이라 정의상 반대 방향으로 보인다 — 시점에서 읽을 수 있는 것은 상위봉뿐이고, 시점에서 쓸 수 있는 숫자(조건부 도달률)는 oneway 회차에 있다.",
      "지표 리프트는 동시 발생이지 인과가 아니다. 표본이 크면 작은 리프트도 유의해 보이지만 실질적 의미는 별개다.",
      "네 스캔 봉 모두 1m 캐시에 맞춘 540일 공통 구간만 본다. 2025년 이전 시장은 들어 있지 않으며, oneway 회차가 보인 대로 임펄스 빈도는 해마다 크게 달랐다.",
      "1H·4H 에서 R=1% 는 봉 하나의 변동폭보다 작을 때가 많아 leg 가 짧게 잘린다.",
      "96봉 채널은 봉마다 기간이 다르다(1m 의 96봉과 1W 의 96봉은 같은 '96' 이 아니다).",
    ],
    window,
    axes: { scanTfs: SCAN_TFS, snapTfs: SNAP_TFS, r: R, minAbs: MIN_ABS, buckets: BUCKETS },
    fetch: fetchReport,
    snapFields: ["dir", "stack", "rsi", "bbPb", "bbWPct", "atrPctile", "distE200", "volR", "dcPos"],
    conditions: CONDITIONS.map((c) => ({ key: c.key, group: c.group, name: c.name })),
    scans,
  };

  if (!existsSync(OUTDIR)) mkdirSync(OUTDIR, { recursive: true });
  const date = KST(Date.now()).toISOString().slice(0, 10);
  const out = join(OUTDIR, `${date}-impulse-mtf.json`);
  const body = JSON.stringify(data);
  writeFileSync(out, body);
  console.log(`\n→ ${out} (${(Buffer.byteLength(body) / 1024 / 1024).toFixed(2)}MB)`);
}

const cmd = process.argv[2];
if (cmd === "run") cmdRun();
else console.log("사용: node --max-old-space-size=8192 scripts/backtest/impulse-mtf.mjs run");
