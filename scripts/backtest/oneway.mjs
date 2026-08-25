/**
 * ONEWAY 회차 — BTC 단기봉에서 "되돌리지 않고 한 방향으로 간 구간"의 전수 원장.
 *
 * 묻는 것: 1%·2%·3% 이상을 한 방향으로 가되 도중 되돌림이 없는 구간이 얼마나 자주
 * 나오는가, 그때 차트는 어떤 모습이었는가, 그 모습으로 미리 알아볼 수 있는가.
 *
 * 이 회차는 전략 성과를 재지 않는다. 수수료·슬리피지·체결 가정이 없다 — 시장이
 * 어떻게 움직였나만 센다. 그래서 여기 나온 빈도는 "얻을 수 있었던 것"의 상한이지
 * 기대 수익이 아니다. 그 선을 넘는 순간 다른 회차가 된다.
 *
 * 축(사전 등록):
 *   봉      1m(540일) · 5m(2400일) · 15m(2400일)
 *   되돌림  R = 0.3% · 0.5% · 1.0%   (요청 정의는 R=1.0%)
 *   크기    |이동| >= 1% · 2% · 3% · 5% · 10%
 *
 * 사용:
 *   node scripts/backtest/oneway-fetch.mjs            → 캔들 수집
 *   node --max-old-space-size=8192 scripts/backtest/oneway.mjs run [tf...]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { C, H, L, O, T, V, decompose, reachScan } from "./lib/oneway-core.mjs";
import { WARMUP, computeTa } from "./lib/oneway-ta.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = join(repoRoot, "scripts", "backtest", ".cache");
const OUTDIR = join(repoRoot, "docs", "backtest");

/** cap = 진입 시점 스캔의 앞보기 한도. 이보다 오래 끄는 구간은 실무에서 다른 이야기다. */
const TFS = {
  "1m": { ms: 60_000, cap: 2880, label: "1분봉" },
  "5m": { ms: 300_000, cap: 2016, label: "5분봉" },
  "15m": { ms: 900_000, cap: 672, label: "15분봉" },
};
const RS = [0.003, 0.005, 0.01];
const BUCKETS = [1, 2, 3, 5, 10];
const TARGETS = [1, 2, 3, 5];

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
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

function loadTf(tf) {
  const p = join(CACHE, `oneway-${tf}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

/* ---------- 지표 조건 — leg 시작 봉이 어떤 상태였나를 이름 붙은 칸으로 나눈다 ---------- */

/**
 * 조건은 서로 배타적이지 않다. 목적이 "무엇과 함께 나타나는가"를 세는 것이지
 * 분류가 아니기 때문이다. 각 조건은 그 봉에서 이미 확정된 값만 본다 — 사후에만
 * 알 수 있는 것(예: 그 봉이 임펄스의 시작이었는지)은 조건이 될 수 없다.
 */
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

const SESSIONS = [
  { key: "asia", name: "아시아 (KST 08~16)" },
  { key: "eu", name: "유럽 (KST 16~22)" },
  { key: "us", name: "미국 (KST 22~05)" },
  { key: "dawn", name: "새벽 (KST 05~08)" },
];
const sessionOf = (h) => (h >= 8 && h < 16 ? "asia" : h >= 16 && h < 22 ? "eu" : h >= 5 && h < 8 ? "dawn" : "us");

/* ---------- 집계 ---------- */

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

/**
 * leg 시작 봉의 지표 프로파일 — 조건이 켜진 비율을 전체 봉과 비교한다.
 *
 * 리프트 = (leg 시작 봉 중 조건 켜진 비율) / (전체 봉 중 조건 켜진 비율).
 * 1보다 크면 그 조건 아래에서 큰 임펄스가 더 자주 시작됐다는 뜻이다. 동시 발생이지
 * 인과가 아니고, 시작점은 사후에만 확정된다 — 이 표만으로는 매매할 수 없다.
 */
function conditionBase(ta, n) {
  const baseN = n - WARMUP;
  return CONDITIONS.map((cond) => {
    let base = 0;
    for (let i = WARMUP; i < n; i += 1) if (cond.test(ta, i)) base += 1;
    return { cond, base, basePct: (base / baseN) * 100 };
  });
}

function taProfile(legs, ta, base, minAbs) {
  const sel = legs.filter((l) => Math.abs(l.movePct) >= minAbs && l.si >= WARMUP);
  if (sel.length < 30) return [];
  return base.map((b) => {
    let hitUp = 0, hitDn = 0;
    for (const l of sel) if (b.cond.test(ta, l.si)) { if (l.dir === 1) hitUp += 1; else hitDn += 1; }
    const hit = hitUp + hitDn;
    const legPct = (hit / sel.length) * 100;
    return {
      key: b.cond.key, group: b.cond.group, name: b.cond.name,
      basePct: r2(b.basePct), legPct: r2(legPct),
      lift: b.basePct > 0 ? r2(legPct / b.basePct) : 0,
      n: hit, nUp: hitUp, nDn: hitDn,
    };
  }).sort((a, b) => b.lift - a.lift);
}

/**
 * 조건부 도달률 — 조건이 켜진 봉에서 출발했을 때 R% 역행 전에 X% 를 갔는가.
 *
 * 프로파일이 "임펄스가 시작된 곳의 모습"이라면 이쪽은 그 뒤집힌 질문이다. 조건이
 * 켜졌다고 임펄스가 오는 것은 아니므로, 시점에서 실제로 쓸 수 있는 숫자는 이쪽뿐이다.
 */
function conditionalReach(ta, reach, n) {
  const out = [];
  const baseN = n - WARMUP;
  const baseline = { key: "__all", group: "기준", name: "전체 봉 (기준선)", n: baseN };
  for (const x of TARGETS) {
    let u = 0, d = 0;
    for (let i = WARMUP; i < n; i += 1) { if (reach.up[i] >= x) u += 1; if (reach.dn[i] >= x) d += 1; }
    baseline[`up${x}`] = r2((u / baseN) * 100);
    baseline[`dn${x}`] = r2((d / baseN) * 100);
  }
  out.push(baseline);

  for (const cond of CONDITIONS) {
    const idx = [];
    for (let i = WARMUP; i < n; i += 1) if (cond.test(ta, i)) idx.push(i);
    if (idx.length < 200) continue;
    const row = { key: cond.key, group: cond.group, name: cond.name, n: idx.length };
    for (const x of TARGETS) {
      let u = 0, d = 0;
      for (const i of idx) { if (reach.up[i] >= x) u += 1; if (reach.dn[i] >= x) d += 1; }
      row[`up${x}`] = r2((u / idx.length) * 100);
      row[`dn${x}`] = r2((d / idx.length) * 100);
      row[`upLift${x}`] = baseline[`up${x}`] > 0 ? r2(row[`up${x}`] / baseline[`up${x}`]) : 0;
      row[`dnLift${x}`] = baseline[`dn${x}`] > 0 ? r2(row[`dn${x}`] / baseline[`dn${x}`]) : 0;
    }
    out.push(row);
  }
  return out;
}

/**
 * 시간대별 봉 수 — 임계·크기와 무관하므로 봉마다 한 번만 센다.
 *
 * 이걸 timeBuckets 안에 두면 5m 69만 봉을 15회(임계 3 × 크기 5) 다시 훑으며 그때마다
 * Date 를 만든다. 나눗셈으로 시·요일을 직접 구해 객체 생성 자체를 없앤다.
 */
function barClock(rows) {
  const byHour = new Array(24).fill(0);
  const byDow = new Array(7).fill(0);
  for (const row of rows) {
    const kst = row[T] + 9 * 3600_000;
    byHour[Math.floor(kst / 3600_000) % 24] += 1;
    byDow[Math.floor(kst / 86_400_000 + 4) % 7] += 1;
  }
  return { byHour, byDow };
}

function timeBuckets(legs, rows, minAbs, barsClock) {
  const sel = legs.filter((l) => Math.abs(l.movePct) >= minAbs);
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, up: 0, dn: 0 }));
  const byDow = Array.from({ length: 7 }, (_, d) => ({ dow: d, up: 0, dn: 0 }));
  const byYear = new Map();
  const byMonth = new Map();
  const bySession = new Map(SESSIONS.map((s) => [s.key, { up: 0, dn: 0 }]));

  // 시간대별 빈도는 봉 수로 나눠야 한다 — 결측이나 구간 차이로 시간대마다 봉 수가 같지 않다.
  const barsByHour = barsClock.byHour;
  const barsByDow = barsClock.byDow;

  for (const l of sel) {
    const k = KST(rows[l.si][T]);
    const h = k.getUTCHours(), d = k.getUTCDay();
    const key = l.dir === 1 ? "up" : "dn";
    byHour[h][key] += 1;
    byDow[d][key] += 1;
    bySession.get(sessionOf(h))[key] += 1;
    const y = k.getUTCFullYear();
    const m = `${y}-${String(k.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!byYear.has(y)) byYear.set(y, { year: y, up: 0, dn: 0 });
    byYear.get(y)[key] += 1;
    if (!byMonth.has(m)) byMonth.set(m, { month: m, up: 0, dn: 0 });
    byMonth.get(m)[key] += 1;
  }

  const total = rows.length;
  const n = sel.length || 1;
  return {
    total: sel.length,
    byHour: byHour.map((r, h) => ({
      ...r, total: r.up + r.dn,
      lift: barsByHour[h] > 0 ? r2(((r.up + r.dn) / n) / (barsByHour[h] / total)) : 0,
    })),
    byDow: byDow.map((r, d) => ({
      ...r, total: r.up + r.dn,
      lift: barsByDow[d] > 0 ? r2(((r.up + r.dn) / n) / (barsByDow[d] / total)) : 0,
    })),
    bySession: SESSIONS.map((s) => {
      const v = bySession.get(s.key);
      return { ...s, ...v, total: v.up + v.dn };
    }),
    byYear: [...byYear.values()].sort((a, b) => a.year - b.year).map((r) => ({ ...r, total: r.up + r.dn })),
    byMonth: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map((r) => ({ ...r, total: r.up + r.dn })),
  };
}

/**
 * 캔들 스니펫 — 구간이 길면 봉을 묶어 압축한다.
 *
 * 지속 상위 구간은 수천 봉짜리도 나온다. 그대로 담으면 리포트가 수십 MB가 되고,
 * 화면에서도 1픽셀 미만의 막대는 읽히지 않는다. 묶을 때 시가는 첫 봉, 종가는 끝 봉,
 * 고·저는 구간 전체의 극값을 쓴다 — 캔들 집계의 표준형이다.
 */
function snippet(rows, from, to, si, ei, maxBars) {
  const total = to - from + 1;
  const step = Math.max(1, Math.ceil(total / maxBars));
  const candles = [];
  for (let i = from; i <= to; i += step) {
    const j = Math.min(to, i + step - 1);
    let hi = rows[i][H], lo = rows[i][L], vol = 0;
    for (let k = i; k <= j; k += 1) {
      if (rows[k][H] > hi) hi = rows[k][H];
      if (rows[k][L] < lo) lo = rows[k][L];
      vol += rows[k][V];
    }
    candles.push([rows[i][T], r2(rows[i][O]), r2(hi), r2(lo), r2(rows[j][C]), Math.round(vol)]);
  }
  return { candles, si: Math.floor((si - from) / step), ei: Math.floor((ei - from) / step), step };
}

/**
 * 대표 사례 — 이동폭 상위만 뽑으면 플래시 크래시류만 남는다.
 *
 * 2020-03-13 의 15분봉 한 대에서 +42% 같은 것은 실재하는 사건이지만, "그때 차트가
 * 어떤 모습이었나"에는 답하지 못한다. 그래서 축을 넷으로 나눠 뽑는다: 가장 큰 것,
 * 가장 오래 간 것, 가장 깔끔했던 것, 그리고 가장 흔한 축에 가까운 것.
 */
function samples(legs, rows, ta, tf, r, minAbs) {
  const pool = legs.filter((l) => Math.abs(l.movePct) >= minAbs && l.si >= WARMUP);
  if (!pool.length) return [];

  const picked = [];
  const seen = new Set();
  const add = (l, why) => {
    if (!l || seen.has(l.si)) return;
    seen.add(l.si);
    picked.push({ l, why });
  };
  const take = (arr, n, why) => arr.slice(0, n).forEach((l) => add(l, why));

  take([...pool].sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct)), 4, "이동폭 최대");
  take([...pool].sort((a, b) => b.bars - a.bars), 4, "가장 오래 간 구간");
  take([...pool].filter((l) => l.bars >= 10).sort((a, b) => a.retr - b.retr), 3, "되돌림이 가장 얕았던 구간");
  take([...pool].sort((a, b) => b.si - a.si), 4, "가장 최근");

  // 전형 — 이동폭·봉수 중앙값에서의 거리로 고른다. 극단만 보고 상을 잡지 않게.
  const mMove = q(pool.map((l) => Math.abs(l.movePct)), 0.5);
  const mBars = q(pool.map((l) => l.bars), 0.5);
  take(
    [...pool].sort((a, b) => {
      const da = Math.abs(Math.abs(a.movePct) - mMove) / mMove + Math.abs(a.bars - mBars) / Math.max(mBars, 1);
      const db = Math.abs(Math.abs(b.movePct) - mMove) / mMove + Math.abs(b.bars - mBars) / Math.max(mBars, 1);
      return da - db;
    }),
    3,
    "가장 전형적인 축",
  );

  return picked.map(({ l, why }) => {
    const pad = Math.max(20, Math.round(l.bars * 0.35));
    const from = Math.max(0, l.si - pad);
    const to = Math.min(rows.length - 1, l.ei + Math.round(pad * 0.6));
    const sn = snippet(rows, from, to, l.si, l.ei, 180);
    return {
      tf, r, why,
      dir: l.dir, movePct: r2(l.movePct), bars: l.bars, hours: r2(l.ms / 3600_000),
      maePct: r3(l.mae), retrPct: r3(l.retr),
      startLabel: iso(rows[l.si][T]), endLabel: iso(rows[l.ei][T]),
      sp: r2(l.sp), ep: r2(l.ep),
      si: sn.si, ei: sn.ei, step: sn.step,
      ta: {
        rsi: r2(ta.rsi[l.si]), bbPb: r3(ta.bbPb[l.si]), bbWPct: r3(ta.bbWPct[l.si]),
        atrPct: r3(ta.atrPct[l.si]), atrPctile: r3(ta.atrPctile[l.si]),
        stack: ta.stack[l.si], h4: ta.h4[l.si], d1: ta.d1[l.si],
        volR: r2(ta.volR[l.si]), dcPos: r3(ta.dcPos[l.si]), distE200: r2(ta.distE200[l.si]),
        hourKst: ta.hour[l.si], dow: ta.dow[l.si],
      },
      candles: sn.candles,
    };
  });
}

/* ---------- 실행 ---------- */

function runTf(tf, htf) {
  const rows = loadTf(tf);
  if (!rows) { console.log(`  [${tf}] 캐시 없음 — 건너뜀`); return null; }
  const cfg = TFS[tf];
  const spanMs = rows[rows.length - 1][T] - rows[0][T];
  const spanYears = spanMs / (365.25 * 86_400_000);
  console.log(`\n[${tf}] ${rows.length.toLocaleString()}봉 · ${(spanMs / 86_400_000).toFixed(0)}일`);

  process.stdout.write("  지표 계산… ");
  const t1 = Date.now();
  const ta = computeTa(rows, htf);
  // 조건별 전체 봉 카운트는 임계·크기와 무관하다 — 한 번만 세고 15조합이 나눠 쓴다.
  const condBase = conditionBase(ta, rows.length);
  const barsClock = barClock(rows);
  console.log(`${((Date.now() - t1) / 1000).toFixed(1)}s`);

  const out = {
    tf, label: cfg.label, bars: rows.length,
    spanDays: Math.round(spanMs / 86_400_000), spanYears: r2(spanYears),
    from: iso(rows[0][T]), to: iso(rows[rows.length - 1][T]),
    byR: {},
  };

  for (const r of RS) {
    const t0 = Date.now();
    const legs = decompose(rows, r);
    const reach = reachScan(rows, r, cfg.cap);
    const rk = String(r);

    // 불변식 — 구간 안의 되돌림은 정의상 R 미만이어야 한다. 여기가 깨지면 이 회차의
    // 모든 숫자가 무의미하므로 집계로 넘어가지 않고 멈춘다.
    const bad = legs.filter((l) => l.retr >= r * 100 + 1e-9);
    if (bad.length) {
      console.error(`  ✗ R=${r}: 되돌림이 임계를 넘은 구간 ${bad.length}건 — 중단`);
      console.error(`    예: ${iso(rows[bad[0].si][T])} retr=${bad[0].retr.toFixed(3)}%`);
      process.exit(1);
    }

    const buckets = BUCKETS.map((b) => ({
      bucket: b,
      both: legStats(legs, spanYears, 0, b),
      up: legStats(legs, spanYears, 1, b),
      down: legStats(legs, spanYears, -1, b),
    }));

    const hist = new Map();
    for (const l of legs) {
      const a = Math.abs(l.movePct);
      const k = a < 1 ? "0-1" : a < 2 ? "1-2" : a < 3 ? "2-3" : a < 5 ? "3-5" : a < 10 ? "5-10" : a < 20 ? "10-20" : "20+";
      if (!hist.has(k)) hist.set(k, { range: k, up: 0, dn: 0 });
      hist.get(k)[l.dir === 1 ? "up" : "dn"] += 1;
    }
    const order = ["0-1", "1-2", "2-3", "3-5", "5-10", "10-20", "20+"];

    // 시간 분포와 지표 프로파일은 크기 버킷마다 다르다 — ≥1% 가 몰리는 시간과
    // ≥5% 가 몰리는 시간이 같다는 보장이 없어서, 화면에서 고른 버킷 그대로 보여 준다.
    const time = {}, profile = {};
    for (const b of BUCKETS) {
      time[b] = timeBuckets(legs, rows, b, barsClock);
      profile[b] = taProfile(legs, ta, condBase, b);
    }

    out.byR[rk] = {
      r,
      legs: legs.length,
      buckets,
      hist: order.filter((k) => hist.has(k)).map((k) => ({ ...hist.get(k), total: hist.get(k).up + hist.get(k).dn })),
      time,
      profile,
      conditional: conditionalReach(ta, reach, rows.length),
      samples: samples(legs, rows, ta, tf, r, 3),
    };
    const b = out.byR[rk].buckets;
    console.log(
      `  R=${(r * 100).toFixed(1)}% · leg ${legs.length.toLocaleString()} · ` +
        `>=1% ${b[0].both.count.toLocaleString()} · >=2% ${b[1].both.count.toLocaleString()} · ` +
        `>=3% ${b[2].both.count.toLocaleString()} · >=5% ${b[3].both.count.toLocaleString()} · ` +
        `>=10% ${b[4].both.count.toLocaleString()} · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  }
  return out;
}

/**
 * 겹치는 구간으로 맞춘 비교.
 *
 * 1m 은 540일, 5m·15m 은 2400일이다. 연 환산으로 견주면 해상도의 효과와 시기의 효과가
 * 섞여 어느 쪽 때문인지 말할 수 없다 — 최근 1년 반은 임펄스가 특히 마른 구간이라 더 그렇다.
 * 그래서 가장 짧은 봉의 구간에 나머지를 맞춰 한 번 더 센다. 여기서 갈리는 만큼이
 * 해상도의 몫이다.
 */
function alignedCompare(targets, from) {
  const rows = [];
  for (const tf of targets) {
    const all = loadTf(tf);
    if (!all) continue;
    const cut = all.filter((r) => r[T] >= from);
    if (cut.length < 1000) continue;
    const spanYears = (cut[cut.length - 1][T] - cut[0][T]) / (365.25 * 86_400_000);
    for (const r of RS) {
      const legs = decompose(cut, r);
      for (const b of BUCKETS) {
        const s = legStats(legs, spanYears, 0, b);
        rows.push({
          tf, r, bucket: b, count: s.count, perYear: s.perYear,
          medBars: s.bars ? s.bars.p50 : 0, medHours: s.hours ? s.hours.p50 : 0,
        });
      }
    }
    console.log(`  ${tf}: ${cut.length.toLocaleString()}봉 (${iso(cut[0][T]).slice(0, 10)} →)`);
  }
  return rows;
}

function cmdRun() {
  const htf = { h4: loadTf("4H"), d1: loadTf("1D") };
  if (!htf.h4 || !htf.d1) {
    console.error("상위봉 캐시(4H·1D)가 없습니다 — oneway-fetch.mjs 를 먼저 돌리세요.");
    process.exit(1);
  }

  const want = process.argv.slice(3).filter((a) => TFS[a]);
  const targets = want.length ? want : Object.keys(TFS);
  const tfs = [];
  for (const tf of targets) {
    const res = runTf(tf, htf);
    if (res) tfs.push(res);
  }
  if (!tfs.length) { console.error("분석할 봉이 없습니다."); process.exit(1); }

  // 가장 늦게 시작하는 봉에 전부 맞춘다 — 보통 1m 이다.
  let alignFrom = 0;
  for (const tf of targets) {
    const rows = loadTf(tf);
    if (rows && rows[0][T] > alignFrom) alignFrom = rows[0][T];
  }
  let aligned = null;
  if (targets.length > 1) {
    console.log(`\n[정렬 비교] ${iso(alignFrom).slice(0, 10)} 이후 공통 구간`);
    aligned = { from: iso(alignFrom), rows: alignedCompare(targets, alignFrom) };
  }

  const fetchPath = join(CACHE, "oneway-fetch-report.json");
  const fetchReport = existsSync(fetchPath) ? JSON.parse(readFileSync(fetchPath, "utf8")) : [];

  const data = {
    round: "oneway",
    name: "일방향 임펄스 원장",
    generatedAt: new Date().toISOString(),
    inst: "BTC-USDT-SWAP (OKX)",
    question:
      "BTC 단기봉에서 도중 되돌리지 않고 1%·2%·3% 이상 한 방향으로 가는 구간이 얼마나 자주 나오며, 그 시작점의 차트는 어떤 모습이었는가",
    definition: {
      leg: "극값까지 이어지되 그 안의 최대 되돌림이 한 번도 R% 에 닿지 않는, 가장 이른 지점에서 시작하는 구간. 되돌림은 진행 중 갱신된 극값 대비로 잰다.",
      exclusion:
        "요청 정의 그대로 — 1% 올랐어도 도중 고점 대비 1% 되밀린 구간은 하나의 1% 임펄스로 세지 않는다. 되밀린 저점부터 새 구간이 시작된다. 전 구간에서 이 불변식(구간 내 되돌림 < R)을 검사하고, 어긋나면 집계로 넘어가지 않는다.",
      intrabar:
        "한 봉 안에서 고가·저가 중 무엇이 먼저인지 데이터는 말하지 않는다. 항상 되돌림이 먼저 온 것으로 판정한다 — 구간을 길게 보이게 하는 쪽이 아니라 짧게 보이게 하는 쪽으로 틀린다.",
      overlap:
        "구간은 서로 겹치지 않는다. 다만 이어 붙지도 않는다 — 사이의 틈은 방향이 확실하지 않았던 자리이고, 어느 임펄스에도 속하지 않는다.",
      reach: "조건부 도달률은 각 봉 종가에서 출발해 R% 역행이 나오기 전 도달한 최대 순행 폭으로 잰다.",
    },
    caveats: [
      "수수료·슬리피지·펀딩·체결 지연이 전혀 들어 있지 않다. 여기 수치는 시장이 준 폭의 상한이지 손익이 아니다.",
      "임펄스의 시작과 끝은 사후에만 확정된다. 시점에서 쓸 수 있는 숫자는 조건부 도달률뿐이다.",
      "지표 리프트는 동시 발생이지 인과가 아니다. 표본이 크면 작은 리프트도 유의해 보이지만 실질적 의미는 별개다.",
      "1m 은 540일, 5m·15m 은 2400일 구간이다. 봉 사이를 곧바로 견주면 해상도의 효과와 시기의 효과가 섞이므로, 공통 구간으로 맞춘 표를 따로 두었다.",
    ],
    axes: { tfs: Object.keys(TFS), retracements: RS, buckets: BUCKETS, targets: TARGETS },
    fetch: fetchReport,
    conditions: CONDITIONS.map((c) => ({ key: c.key, group: c.group, name: c.name })),
    sessions: SESSIONS,
    aligned,
    tfs,
  };

  if (!existsSync(OUTDIR)) mkdirSync(OUTDIR, { recursive: true });
  const date = KST(Date.now()).toISOString().slice(0, 10);
  const out = join(OUTDIR, `${date}-oneway.json`);
  const body = JSON.stringify(data);
  writeFileSync(out, body);
  console.log(`\n→ ${out} (${(Buffer.byteLength(body) / 1024 / 1024).toFixed(2)}MB)`);
}

const cmd = process.argv[2];
if (cmd === "run") cmdRun();
else console.log("사용: node --max-old-space-size=8192 scripts/backtest/oneway.mjs run [1m|5m|15m ...]");
