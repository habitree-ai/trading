/**
 * 선배님 체크리스트 회차 — "꼼꼼히 봤던 구간"이 BTC 에서 실제로 몇 번 있었고 그 뒤에 뭐가 있었나.
 *
 * 원문(선배님 블로그):
 *   전고점, 전저점을 깰때 ( 30,60,90,120 일 ) 의 모습 / 이평 돌파시의 모습 / 그리고 눌림 /
 *   그리고 갭 / 장대봉 그 이후 모습 / 캔들패턴의 유효성
 *
 * 이 회차는 전략을 만들지 않는다. 사실 원장이다 — 여섯 항목을 1D·4H 전 구간에 전수 대조해
 * 발생 건수·그때의 모습·그 뒤 성과를 남기고, 기준선(아무 봉이나 잡았을 때)을 넘는 것만
 * "유효"라고 부른다. BTC 는 전 구간 상승이라 수익률 플러스는 유효성의 증거가 아니다.
 *
 * 정의는 결과를 보기 전에 고정했다 — .backlog/2-active/REQ-0051…md 의 「사전 등록」.
 * 요약하면:
 *   - 30·60·90·120 은 봉이 아니라 **일수**다. 4H 에서는 180·360·540·720봉으로 환산한다.
 *   - 신호는 종가 확정, 진입은 다음 봉 시가. 같은 봉 종가 진입은 미래참조다.
 *   - 주 판정은 fwd(5봉) 방향 적중률 하나. 이항검정 + Benjamini-Hochberg FDR 5%.
 *     사건 종류가 수십 개라 보정 없이는 우연이 반드시 섞인다.
 *   - 표본 n<30 은 수치는 내되 판정에서 뺀다.
 *
 * 사용: node scripts/backtest/senior-checklist.mjs
 *   → docs/backtest/2026-09-07-senior-checklist.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const T = 0, O = 1, H = 2, L = 3, C = 4, V = 5;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = join(repoRoot, "scripts", "backtest", ".cache");
const OUT = join(repoRoot, "docs", "backtest");

/** 봉별 설정. barsPerDay 로 "30일"을 봉 수로 옮긴다 — 원문의 단위는 일이다. */
const TFS = {
  "1D": { barsPerDay: 1, pullbackWin: 20, name: "일봉" },
  "4H": { barsPerDay: 6, pullbackWin: 60, name: "4시간봉" },
};
const DAYS = [30, 60, 90, 120];
const KS = [1, 3, 5, 10, 20]; // 전방 성과 지평(봉)
const JUDGE_K = 5; // 주 판정 지평 — 사전 등록으로 하나만 쓴다
const MFE_WIN = 20;
const MIN_N = 30;
const FDR_Q = 0.05;

/* ────────────────────────── 수치 도구 ────────────────────────── */

/** 직전 N봉(현재 봉 제외)의 극값. 단조 덱으로 O(N). */
function prevExtreme(arr, n, N, isMax) {
  const out = new Float64Array(n).fill(NaN);
  const dq = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i += 1) {
    while (head < tail && dq[head] < i - N) head += 1;
    out[i] = head < tail ? arr[dq[head]] : NaN;
    while (head < tail && (isMax ? arr[dq[tail - 1]] <= arr[i] : arr[dq[tail - 1]] >= arr[i])) tail -= 1;
    dq[tail] = i; tail += 1;
  }
  return out;
}

function sma(arr, n, P) {
  const out = new Float64Array(n).fill(NaN);
  let s = 0;
  for (let i = 0; i < n; i += 1) {
    s += arr[i];
    if (i >= P) s -= arr[i - P];
    if (i >= P - 1) out[i] = s / P;
  }
  return out;
}

/** ATR(14) — Wilder. oneway-ta 와 같은 식을 쓴다. */
function atr(rows, n, P = 14) {
  const out = new Float64Array(n);
  let a = 0;
  for (let i = 0; i < n; i += 1) {
    const tr = i === 0
      ? rows[0][H] - rows[0][L]
      : Math.max(rows[i][H] - rows[i][L], Math.abs(rows[i][H] - rows[i - 1][C]), Math.abs(rows[i][L] - rows[i - 1][C]));
    a = i === 0 ? tr : (a * (P - 1) + tr) / P;
    out[i] = a;
  }
  return out;
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return quantile(s, 0.5);
};
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);

/** 로그감마 (Lanczos) — 이항검정을 정확히 합산하기 위해. */
const LG_C = [
  76.18009172947146, -86.50532032941677, 24.01409824083091,
  -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
];
function logGamma(x) {
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) ser += LG_C[j] / (y += 1);
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
const logChoose = (n, k) => logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);

/**
 * 이항검정 단측 p — n 번 중 x 번 이상 맞을 확률(귀무: 성공확률 p0).
 * n 이 수천이라 직접 합산해도 충분히 빠르고, 정규근사보다 꼬리에서 정확하다.
 */
function binomUpperP(x, n, p0) {
  if (n === 0) return 1;
  if (p0 <= 0) return x > 0 ? 0 : 1;
  if (p0 >= 1) return 1;
  const lp = Math.log(p0), lq = Math.log(1 - p0);
  let sum = 0;
  for (let k = x; k <= n; k += 1) sum += Math.exp(logChoose(n, k) + k * lp + (n - k) * lq);
  return Math.min(1, sum);
}

/* ────────────────────────── 성과 측정 틀 ────────────────────────── */

/**
 * 사건 봉 i 의 성과 — 진입은 i+1 시가, 청산은 i+k 종가.
 * dir 을 곱해 방향 사건으로 정규화한다(하방 사건은 하락이 이익).
 */
function makePerf(rows, n) {
  const maxK = Math.max(...KS, MFE_WIN);
  return function perf(i, dir) {
    if (i + 1 >= n) return null;
    const entry = rows[i + 1][O];
    if (!(entry > 0)) return null;
    const fwd = {};
    for (const k of KS) {
      const j = i + k;
      fwd[k] = j < n ? ((rows[j][C] - entry) / entry) * 100 * (dir || 1) : null;
    }
    let mfe = 0, mae = 0;
    const end = Math.min(n - 1, i + MFE_WIN);
    for (let j = i + 1; j <= end; j += 1) {
      const up = ((rows[j][H] - entry) / entry) * 100;
      const dn = ((rows[j][L] - entry) / entry) * 100;
      const fav = dir >= 0 ? up : -dn;
      const adv = dir >= 0 ? -dn : up;
      if (fav > mfe) mfe = fav;
      if (adv > mae) mae = adv;
    }
    return { fwd, mfe, mae, hasFull: i + maxK < n };
  };
}

/* ────────────────────────── 봉 하나 훑기 ────────────────────────── */

function analyseTf(tf, rows) {
  const cfg = TFS[tf];
  const n = rows.length;
  const bpd = cfg.barsPerDay;
  const wins = DAYS.map((d) => ({ days: d, bars: d * bpd }));
  const maxWin = Math.max(...wins.map((w) => w.bars));
  const warmup = maxWin + 25; // 최장 창 + ATR/거래량 평균이 서는 자리

  const highs = Float64Array.from(rows, (r) => r[H]);
  const lows = Float64Array.from(rows, (r) => r[L]);
  const closes = Float64Array.from(rows, (r) => r[C]);
  const vols = Float64Array.from(rows, (r) => r[V]);

  const atr14 = atr(rows, n);
  const vol20 = sma(vols, n, 20);
  const smas = new Map(wins.map((w) => [w.days, sma(closes, n, w.bars)]));
  const prevHi = new Map(wins.map((w) => [w.days, prevExtreme(highs, n, w.bars, true)]));
  const prevLo = new Map(wins.map((w) => [w.days, prevExtreme(lows, n, w.bars, false)]));

  const perf = makePerf(rows, n);

  /** 봉의 "모습" — 원문의 '그 모습'을 숫자로. */
  function shape(i) {
    const r = rows[i];
    const rng = r[H] - r[L];
    const body = Math.abs(r[C] - r[O]);
    return {
      bodyPct: rng > 0 ? (body / rng) * 100 : 0,
      volX: vol20[i] > 0 ? vols[i] / vol20[i] : null,
      atrX: atr14[i] > 0 ? rng / atr14[i] : null,
      closePos: rng > 0 ? ((r[C] - r[L]) / rng) * 100 : 50,
    };
  }

  /** 직전 5봉 방향 — 반전 패턴의 컨텍스트. */
  const trend5 = new Int8Array(n);
  for (let i = 6; i < n; i += 1) trend5[i] = closes[i - 1] > closes[i - 6] ? 1 : -1;
  const sma60 = smas.get(60);

  const classes = []; // {section, key, label, dir, group, note, ev:[]}
  const byKey = new Map();
  function cls(section, key, label, dir, group, note) {
    if (byKey.has(key)) return byKey.get(key);
    const c = { section, key, label, dir, group, note: note ?? "", ev: [] };
    classes.push(c); byKey.set(key, c);
    return c;
  }
  function fire(c, i, extra) {
    const p = perf(i, c.dir === 0 ? 1 : c.dir);
    if (!p) return null;
    const s = shape(i);
    const e = { i, t: rows[i][T], p, s, extra: extra ?? {} };
    c.ev.push(e);
    return e;
  }

  /* ── A. 전고점·전저점 돌파 ─────────────────────────────────────── */
  const brkUpFlags = new Map();  // days -> Uint8Array (전체 돌파)
  const firstUpIdx = new Map();  // days -> [i…] (첫 돌파)
  for (const w of wins) {
    const ph = prevHi.get(w.days), pl = prevLo.get(w.days);
    const up = new Uint8Array(n), dn = new Uint8Array(n);
    for (let i = warmup; i < n; i += 1) {
      if (Number.isFinite(ph[i]) && closes[i] > ph[i]) up[i] = 1;
      if (Number.isFinite(pl[i]) && closes[i] < pl[i]) dn[i] = 1;
    }
    brkUpFlags.set(w.days, up);
    // 첫 돌파 = 직전 N봉 안에 같은 방향 돌파가 없던 것. 추세장에서는 매봉이 신고가라
    // 전체를 세면 "깰 때"라는 말의 뜻이 아니게 된다.
    const pre = (flag) => { const s = new Int32Array(n + 1); for (let i = 0; i < n; i += 1) s[i + 1] = s[i] + flag[i]; return s; };
    const su = pre(up), sd = pre(dn);
    const firsts = [];
    for (const [flag, sums, dir, dirLab] of [[up, su, 1, "up"], [dn, sd, -1, "dn"]]) {
      const cAll = cls("brk", `brk:${dirLab}:${w.days}:all`, `${w.days}일 ${dir === 1 ? "전고점" : "전저점"} 돌파(전체)`, dir, `${w.days}일`, "돌파 상태가 이어지는 봉을 전부 셈");
      const cFirst = cls("brk", `brk:${dirLab}:${w.days}:first`, `${w.days}일 ${dir === 1 ? "전고점" : "전저점"} 돌파(첫 봉)`, dir, `${w.days}일`, "직전 N봉 안에 같은 방향 돌파가 없던 것만");
      for (let i = warmup; i < n; i += 1) {
        if (!flag[i]) continue;
        const lo = Math.max(0, i - w.bars);
        const prior = sums[i] - sums[lo];
        const level = dir === 1 ? prevHi.get(w.days)[i] : prevLo.get(w.days)[i];
        const brkPct = ((closes[i] - level) / level) * 100 * dir;
        // 속임수 판정 — K봉 안에 종가가 기준선 반대편으로 되돌아오면 실패.
        const K = Math.max(3, Math.round(w.bars / 4));
        let failed = 0;
        for (let j = i + 1; j <= Math.min(n - 1, i + K); j += 1) {
          if (dir === 1 ? closes[j] < level : closes[j] > level) { failed = 1; break; }
        }
        const extra = { level: r2(level), brkPct: r2(brkPct), failed };
        fire(cAll, i, extra);
        if (prior === 0) { fire(cFirst, i, extra); if (dir === 1) firsts.push({ i, level }); }
      }
    }
    firstUpIdx.set(w.days, firsts);
  }

  /* ── B. 이평 돌파 ──────────────────────────────────────────────── */
  for (const w of wins) {
    const m = smas.get(w.days);
    const slopeLag = 20 * bpd; // 기울기는 20"일" 전 대비 — 창과 같은 단위(일)로 맞춘다
    for (let i = warmup; i < n; i += 1) {
      if (!Number.isFinite(m[i]) || !Number.isFinite(m[i - 1])) continue;
      const upCross = closes[i - 1] <= m[i - 1] && closes[i] > m[i];
      const dnCross = closes[i - 1] >= m[i - 1] && closes[i] < m[i];
      if (!upCross && !dnCross) continue;
      const dir = upCross ? 1 : -1;
      const rising = Number.isFinite(m[i - slopeLag]) ? m[i] > m[i - slopeLag] : null;
      const dirLab = upCross ? "up" : "dn";
      const base = cls("ma", `ma:${dirLab}:${w.days}:all`, `SMA${w.days}일 ${upCross ? "상향" : "하향"} 돌파`, dir, `${w.days}일`, "");
      const extra = { rising: rising === null ? null : rising ? 1 : 0, distPct: r2(((closes[i] - m[i]) / m[i]) * 100) };
      fire(base, i, extra);
      if (rising !== null) {
        const sk = rising ? "rise" : "fall";
        const sl = cls("ma", `ma:${dirLab}:${w.days}:${sk}`, `SMA${w.days}일 ${upCross ? "상향" : "하향"} 돌파 · 이평 ${rising ? "상승" : "하락"} 중`, dir, `${w.days}일`, "이평 기울기 = 20봉 전 대비");
        fire(sl, i, extra);
      }
    }
  }

  /* ── C. 눌림 ───────────────────────────────────────────────────── */
  const W = cfg.pullbackWin;
  const pullEvents = [];
  for (const w of wins) {
    const cDirect = cls("pull", `pull:${w.days}:direct`, `${w.days}일 돌파 후 눌림 없이 직행`, 1, `${w.days}일`, `${W}봉 안에 기준선 되터치 없음`);
    const cHold = cls("pull", `pull:${w.days}:hold`, `${w.days}일 돌파 후 눌림 → 회복(눌림 확인 봉 기준)`, 1, `${w.days}일`, "되터치 뒤 종가가 기준선 위로 회복한 첫 봉");
    const cBreak = cls("pull", `pull:${w.days}:fail`, `${w.days}일 돌파 후 눌림 → 회복 실패`, 1, `${w.days}일`, "되터치 뒤 창 안에 회복 못 함 — 돌파 봉 기준");
    const cEntryBrk = cls("pull", `pull:${w.days}:entry-break`, `${w.days}일 돌파 봉에서 진입(눌림 온 건들만)`, 1, `${w.days}일`, "눌림 진입과 같은 표본에서의 대조군");
    for (const { i, level } of firstUpIdx.get(w.days)) {
      let touch = -1, hold = -1;
      const end = Math.min(n - 1, i + W);
      for (let j = i + 1; j <= end; j += 1) {
        if (touch < 0) { if (lows[j] <= level) touch = j; continue; }
        if (closes[j] > level) { hold = j; break; }
      }
      if (touch < 0) { fire(cDirect, i, { level: r2(level) }); continue; }
      const depth = ((closes[i] - lows[touch]) / closes[i]) * 100;
      if (hold < 0) { fire(cBreak, i, { level: r2(level), touchBars: touch - i, depthPct: r2(depth) }); continue; }
      fire(cEntryBrk, i, { level: r2(level) });
      const e = fire(cHold, hold, { level: r2(level), brkIdx: i, brkT: rows[i][T], touchBars: touch - i, holdBars: hold - i, depthPct: r2(depth) });
      if (e) pullEvents.push({ days: w.days, brkT: rows[i][T], touchT: rows[touch][T], holdT: rows[hold][T], depthPct: r2(depth), holdBars: hold - i });
    }
  }

  /* ── D. 갭 ─────────────────────────────────────────────────────── */
  const gaps = new Float64Array(n);
  const absGaps = [];
  for (let i = 1; i < n; i += 1) {
    gaps[i] = ((rows[i][O] - closes[i - 1]) / closes[i - 1]) * 100;
    if (i >= warmup) absGaps.push(Math.abs(gaps[i]));
  }
  absGaps.sort((a, b) => a - b);
  const gapThr = { p99: quantile(absGaps, 0.99), p995: quantile(absGaps, 0.995) };
  const gapStat = {
    thrP99: r4(gapThr.p99), thrP995: r4(gapThr.p995),
    median: r4(quantile(absGaps, 0.5)), p90: r4(quantile(absGaps, 0.9)),
    max: r4(absGaps[absGaps.length - 1]),
    over05: absGaps.filter((x) => x >= 0.5).length,
    over1: absGaps.filter((x) => x >= 1).length,
    n: absGaps.length,
  };
  for (const [lab, thr] of [["p99", gapThr.p99], ["p995", gapThr.p995]]) {
    for (const dir of [1, -1]) {
      const dirLab = dir === 1 ? "up" : "dn";
      const c = cls("gap", `gap:${dirLab}:${lab}`, `${dir === 1 ? "상방" : "하방"} 갭 (|갭| 상위 ${lab === "p99" ? "1%" : "0.5%"} = ${(lab === "p99" ? gapThr.p99 : gapThr.p995).toFixed(3)}% 이상)`, dir, lab === "p99" ? "상위 1%" : "상위 0.5%", "지속 가설 검정 — 메움률은 별도");
      for (let i = warmup; i < n; i += 1) {
        const g = gaps[i];
        if (Math.abs(g) < thr || Math.sign(g) !== dir) continue;
        // 메움 = 20봉 안에 직전 종가를 되터치
        const pc = closes[i - 1];
        let fill = 0, fillBars = null;
        for (let j = i; j <= Math.min(n - 1, i + MFE_WIN); j += 1) {
          if (dir === 1 ? lows[j] <= pc : highs[j] >= pc) { fill = 1; fillBars = j - i; break; }
        }
        fire(c, i, { gapPct: r4(g), fill, fillBars });
      }
    }
  }

  /* ── E. 장대봉 ─────────────────────────────────────────────────── */
  const bodies = [];
  for (let i = warmup; i < n; i += 1) bodies.push(Math.abs(rows[i][C] - rows[i][O]) / (atr14[i] || 1));
  bodies.sort((a, b) => a - b);
  const bodyP99 = quantile(bodies, 0.99);
  for (const [lab, thr, labKo] of [["atr2", 2, "몸통 ≥ 2×ATR14"], ["p99", bodyP99, `몸통 상위 1% (${bodyP99.toFixed(2)}×ATR14)`]]) {
    for (const dir of [1, -1]) {
      const dirLab = dir === 1 ? "bull" : "bear";
      const c = cls("big", `big:${dirLab}:${lab}`, `${dir === 1 ? "양" : "음"} 장대봉 · ${labKo}`, dir, labKo, "사후 = 지속 가설(같은 방향)");
      for (let i = warmup; i < n; i += 1) {
        const body = rows[i][C] - rows[i][O];
        if (Math.sign(body) !== dir) continue;
        if (Math.abs(body) / (atr14[i] || 1) < thr) continue;
        // 지속 = 20봉 안에 봉의 극값을 방향대로 넘음 / 되메움 = 봉 시가로 종가 회귀
        let ext = 0, fillBack = 0;
        for (let j = i + 1; j <= Math.min(n - 1, i + MFE_WIN); j += 1) {
          if (!ext && (dir === 1 ? highs[j] > rows[i][H] : lows[j] < rows[i][L])) ext = 1;
          if (!fillBack && (dir === 1 ? closes[j] < rows[i][O] : closes[j] > rows[i][O])) fillBack = 1;
        }
        const alsoBrk = wins.some((w) => brkUpFlags.get(w.days)[i] === 1);
        fire(c, i, {
          bodyAtr: r2(Math.abs(body) / (atr14[i] || 1)), ext, fillBack,
          alsoBrk: dir === 1 && alsoBrk ? 1 : 0,
        });
      }
    }
  }

  /* ── F. 캔들패턴 ───────────────────────────────────────────────── */
  // 모양은 표준 정의만 쓴다. 망치와 교수형은 모양이 같고 직전 추세만 다르므로,
  // 모양을 잡은 뒤 컨텍스트(직전 5봉 방향)로 가른다 — 그게 곧 "유효성" 질문이다.
  const g = (i) => {
    const r = rows[i];
    const rng = r[H] - r[L];
    const body = Math.abs(r[C] - r[O]);
    return {
      rng, body,
      up: r[H] - Math.max(r[O], r[C]),
      lo: Math.min(r[O], r[C]) - r[L],
      bull: r[C] > r[O], bear: r[C] < r[O],
      o: r[O], c: r[C], h: r[H], l: r[L],
    };
  };
  const patDefs = [
    { key: "hammer", ko: "망치형(아래꼬리)", test: (i) => { const a = g(i); return a.rng > 0 && a.lo >= 2 * a.body && a.up <= 0.15 * a.rng && a.body <= 0.4 * a.rng; }, rev: true },
    { key: "invhammer", ko: "역망치형(위꼬리)", test: (i) => { const a = g(i); return a.rng > 0 && a.up >= 2 * a.body && a.lo <= 0.15 * a.rng && a.body <= 0.4 * a.rng; }, rev: true },
    { key: "engulf-bull", ko: "상승장악형", test: (i) => { const a = g(i), b = g(i - 1); return b.bear && a.bull && a.o <= b.c && a.c >= b.o && a.body > b.body; }, dir: 1 },
    { key: "engulf-bear", ko: "하락장악형", test: (i) => { const a = g(i), b = g(i - 1); return b.bull && a.bear && a.o >= b.c && a.c <= b.o && a.body > b.body; }, dir: -1 },
    { key: "doji", ko: "도지", test: (i) => { const a = g(i); return a.rng > 0 && a.body <= 0.1 * a.rng; }, dir: 0 },
    { key: "piercing", ko: "관통형", test: (i) => { const a = g(i), b = g(i - 1); return b.bear && a.bull && a.o < b.c && a.c > (b.o + b.c) / 2 && a.c < b.o; }, dir: 1 },
    { key: "darkcloud", ko: "흑운형", test: (i) => { const a = g(i), b = g(i - 1); return b.bull && a.bear && a.o > b.c && a.c < (b.o + b.c) / 2 && a.c > b.o; }, dir: -1 },
    { key: "morningstar", ko: "아침샛별", test: (i) => { const a = g(i), b = g(i - 1), z = g(i - 2); return z.bear && z.body > 0 && b.body <= 0.35 * z.body && a.bull && a.c > (z.o + z.c) / 2; }, dir: 1 },
    { key: "eveningstar", ko: "저녁샛별", test: (i) => { const a = g(i), b = g(i - 1), z = g(i - 2); return z.bull && z.body > 0 && b.body <= 0.35 * z.body && a.bear && a.c < (z.o + z.c) / 2; }, dir: -1 },
    { key: "harami-bull", ko: "상승내포형", test: (i) => { const a = g(i), b = g(i - 1); return b.bear && a.bull && a.o > b.c && a.c < b.o && a.body <= 0.6 * b.body; }, dir: 1 },
    { key: "harami-bear", ko: "하락내포형", test: (i) => { const a = g(i), b = g(i - 1); return b.bull && a.bear && a.o < b.c && a.c > b.o && a.body <= 0.6 * b.body; }, dir: -1 },
  ];
  // 관통·흑운의 교과서 정의는 "직전 봉 저가/고가 밖에서 시가" 다. 24/7 시장은 갭이 거의
  // 없어 그 정의로는 표본이 0 에 가깝다 — 그래서 "직전 종가 밖" 으로 완화했고, 그 사실을
  // 리포트에 명시한다. D(갭) 절이 이 완화의 근거다.
  const relaxNote = "24/7 시장이라 교과서의 '직전 봉 고·저가 밖 시가' 조건은 표본이 0 에 가깝다 — 직전 종가 기준으로 완화";

  for (const p of patDefs) {
    for (let i = warmup; i < n; i += 1) {
      if (!p.test(i)) continue;
      const ctxUp = trend5[i] === 1;
      const ctx = ctxUp ? "상승 뒤" : "하락 뒤";
      const above = Number.isFinite(sma60[i]) ? closes[i] > sma60[i] : null;
      const extra = { ctxUp: ctxUp ? 1 : 0, aboveSma60: above === null ? null : above ? 1 : 0 };
      if (p.rev) {
        // 모양 하나가 컨텍스트로 두 이름이 된다 — 망치/교수형, 역망치/유성.
        const nameMap = p.key === "hammer"
          ? { down: "망치형(하락 뒤 · 반전 롱)", up: "교수형(상승 뒤 · 반전 숏)" }
          : { down: "역망치형(하락 뒤 · 반전 롱)", up: "유성형(상승 뒤 · 반전 숏)" };
        const dir = ctxUp ? -1 : 1;
        const c = cls("cdl", `cdl:${p.key}:${ctxUp ? "up" : "down"}`, ctxUp ? nameMap.up : nameMap.down, dir, p.ko, "직전 5봉 방향으로 가른 것");
        fire(c, i, extra);
        const cAll = cls("cdl", `cdl:${p.key}:all`, `${p.ko} — 모양만(컨텍스트 무시)`, 1, p.ko, "반전 방향을 정하지 않고 롱 기준으로만 잰 대조군");
        fire(cAll, i, extra);
      } else {
        const c = cls("cdl", `cdl:${p.key}:all`, p.ko, p.dir, p.ko, p.key === "piercing" || p.key === "darkcloud" ? relaxNote : "");
        fire(c, i, extra);
        const cc = cls("cdl", `cdl:${p.key}:${ctxUp ? "up" : "down"}`, `${p.ko} · ${ctx}`, p.dir, p.ko, "직전 5봉 방향으로 가른 것");
        fire(cc, i, extra);
      }
    }
  }

  /* ── 기준선 ────────────────────────────────────────────────────── */
  // 워밍업 이후 모든 봉에서 같은 방식으로 잰 값. 사건의 수치는 여기서 뺀 만큼만 엣지다.
  const baseline = { n: 0, hit: {}, meanFwd: {}, absFwd: {}, revRate: null };
  const baseHit = Object.fromEntries(KS.map((k) => [k, { up: 0, dn: 0, tot: 0, sumUp: 0, sumAbs: 0 }]));
  let revHit = 0, revTot = 0;
  for (let i = warmup; i < n; i += 1) {
    const p = perf(i, 1);
    if (!p) continue;
    baseline.n += 1;
    for (const k of KS) {
      const f = p.fwd[k];
      if (f === null) continue;
      baseHit[k].tot += 1;
      if (f > 0) baseHit[k].up += 1; else baseHit[k].dn += 1;
      baseHit[k].sumUp += f;
      baseHit[k].sumAbs += Math.abs(f);
    }
    const f5 = p.fwd[JUDGE_K];
    if (f5 !== null && trend5[i] !== 0) { revTot += 1; if (Math.sign(f5) !== trend5[i]) revHit += 1; }
  }
  for (const k of KS) {
    const b = baseHit[k];
    baseline.hit[k] = { up: b.tot ? b.up / b.tot : null, dn: b.tot ? b.dn / b.tot : null, n: b.tot };
    baseline.meanFwd[k] = b.tot ? b.sumUp / b.tot : null;
    baseline.absFwd[k] = b.tot ? b.sumAbs / b.tot : null;
  }
  baseline.revRate = revTot ? revHit / revTot : null;

  /* ── 집계 ──────────────────────────────────────────────────────── */
  const rows_out = [];
  for (const c of classes) {
    const ev = c.ev;
    if (!ev.length) continue;
    const stat = { section: c.section, key: c.key, label: c.label, dir: c.dir, group: c.group, note: c.note, n: ev.length };

    // 방향 사건: 적중 = dir 방향으로 움직임. 도지처럼 방향이 없는 것(dir 0)은
    // "직전 5봉 방향의 반대로 갔는가"(반전률)를 대신 검정한다.
    const useRev = c.dir === 0;
    const fwdBy = {};
    for (const k of KS) {
      const vals = ev.map((e) => e.p.fwd[k]).filter((x) => x !== null);
      const signed = c.dir === 0 ? vals : vals.map((x) => x * 1); // fire 에서 이미 dir 곱함
      fwdBy[k] = {
        n: signed.length,
        mean: r4(mean(signed)),
        median: r4(median(signed)),
        hit: signed.length ? signed.filter((x) => x > 0).length / signed.length : null,
      };
    }
    stat.fwd = fwdBy;
    stat.mfe = r2(mean(ev.map((e) => e.p.mfe)));
    stat.mae = r2(mean(ev.map((e) => e.p.mae)));
    stat.shape = {
      bodyPct: r2(mean(ev.map((e) => e.s.bodyPct))),
      volX: r2(mean(ev.map((e) => e.s.volX).filter(Number.isFinite))),
      atrX: r2(mean(ev.map((e) => e.s.atrX).filter(Number.isFinite))),
      closePos: r2(mean(ev.map((e) => e.s.closePos))),
    };

    // 주 판정 — fwd(5) 하나. 사전 등록대로.
    let x = 0, m = 0, p0;
    if (useRev) {
      for (const e of ev) {
        const f = e.p.fwd[JUDGE_K];
        const tr = trend5[e.i];
        if (f === null || tr === 0) continue;
        m += 1; if (Math.sign(f) !== tr) x += 1;
      }
      p0 = baseline.revRate;
      stat.judge = { kind: "반전률", base: r4(p0) };
    } else {
      for (const e of ev) {
        const f = e.p.fwd[JUDGE_K];
        if (f === null) continue;
        m += 1; if (f > 0) x += 1;
      }
      p0 = c.dir >= 0 ? baseline.hit[JUDGE_K].up : baseline.hit[JUDGE_K].dn;
      stat.judge = { kind: "적중률", base: r4(p0) };
    }
    stat.judge.n = m;
    stat.judge.hit = m ? r4(x / m) : null;
    stat.judge.edgePp = m && p0 !== null ? r2((x / m - p0) * 100) : null;
    stat.judge.p = m >= MIN_N && p0 !== null ? binomUpperP(x, m, p0) : null;
    stat.judge.tested = m >= MIN_N && p0 !== null;

    // 절별 부가 수치
    if (c.section === "brk") stat.failRate = r4(mean(ev.map((e) => e.extra.failed)));
    if (c.section === "brk") stat.brkPct = r2(mean(ev.map((e) => e.extra.brkPct)));
    if (c.section === "gap") {
      stat.fillRate = r4(mean(ev.map((e) => e.extra.fill)));
      stat.fillBars = r2(mean(ev.map((e) => e.extra.fillBars).filter((x2) => x2 !== null)));
      stat.gapPct = r4(mean(ev.map((e) => Math.abs(e.extra.gapPct))));
    }
    if (c.section === "big") {
      stat.extRate = r4(mean(ev.map((e) => e.extra.ext)));
      stat.fillBackRate = r4(mean(ev.map((e) => e.extra.fillBack)));
      stat.bodyAtr = r2(mean(ev.map((e) => e.extra.bodyAtr)));
    }
    if (c.section === "pull") {
      const d = ev.map((e) => e.extra.depthPct).filter(Number.isFinite);
      if (d.length) { stat.depthPct = r2(mean(d)); stat.holdBars = r2(mean(ev.map((e) => e.extra.holdBars).filter(Number.isFinite))); }
    }

    // 이긴 사건과 진 사건의 "모습" 차이 — 원문의 '그 모습'이 결과를 가르는지.
    const win = ev.filter((e) => e.p.fwd[JUDGE_K] !== null && e.p.fwd[JUDGE_K] > 0);
    const lose = ev.filter((e) => e.p.fwd[JUDGE_K] !== null && e.p.fwd[JUDGE_K] <= 0);
    const shapeOf = (arr) => ({
      n: arr.length,
      volX: r2(mean(arr.map((e) => e.s.volX).filter(Number.isFinite))),
      atrX: r2(mean(arr.map((e) => e.s.atrX).filter(Number.isFinite))),
      bodyPct: r2(mean(arr.map((e) => e.s.bodyPct))),
      closePos: r2(mean(arr.map((e) => e.s.closePos))),
    });
    stat.winShape = shapeOf(win);
    stat.loseShape = shapeOf(lose);

    stat.first = ev[0].t;
    stat.last = ev[ev.length - 1].t;
    rows_out.push(stat);
  }

  // 사건 목록 — 「모두 찾아서」 이므로 전부 싣는다. 자리를 아끼려고 배열로 담는다.
  const eventSchema = ["t", "fwd1", "fwd5", "fwd20", "mfe", "mae", "volX", "atrX", "closePos"];
  const events = {};
  for (const c of classes) {
    if (!c.ev.length) continue;
    events[c.key] = c.ev.map((e) => [
      e.t, r2(e.p.fwd[1]), r2(e.p.fwd[5]), r2(e.p.fwd[20]), r2(e.p.mfe), r2(e.p.mae),
      r2(e.s.volX), r2(e.s.atrX), r2(e.s.closePos),
    ]);
  }

  return {
    tf,
    name: cfg.name,
    bars: n,
    from: rows[0][T],
    to: rows[n - 1][T],
    warmup,
    scanned: n - warmup,
    windows: wins,
    baseline: {
      n: baseline.n,
      hit: Object.fromEntries(KS.map((k) => [k, { up: r4(baseline.hit[k].up), dn: r4(baseline.hit[k].dn), n: baseline.hit[k].n }])),
      meanFwd: Object.fromEntries(KS.map((k) => [k, r4(baseline.meanFwd[k])])),
      absFwd: Object.fromEntries(KS.map((k) => [k, r4(baseline.absFwd[k])])),
      revRate: r4(baseline.revRate),
    },
    gapStat,
    bodyP99: r2(bodyP99),
    stats: rows_out,
    events,
    eventSchema,
    pullSamples: pullEvents,
  };
}

/* ────────────────────────── 실행 ────────────────────────── */

function loadTf(tf) {
  const p = join(CACHE, `oneway-${tf}.json`);
  if (!existsSync(p)) {
    console.error(`캐시 없음: ${p} — 먼저 oneway-fetch.mjs ${tf} 를 돌리세요.`);
    process.exit(1);
  }
  const rows = JSON.parse(readFileSync(p, "utf8"));
  // 게이트 — 단조 증가·간격 일정. 하나라도 어긋나면 여기서 멈춘다.
  const ms = tf === "1D" ? 86_400_000 : 14_400_000;
  let nonMono = 0, gapBars = 0;
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i][0] <= rows[i - 1][0]) nonMono += 1;
    if (rows[i][0] - rows[i - 1][0] !== ms) gapBars += 1;
  }
  if (nonMono || gapBars) {
    console.error(`✗ ${tf}: 단조위반 ${nonMono} · 간격불일치 ${gapBars} — 중단`);
    process.exit(1);
  }
  return rows;
}

function main() {
  const out = { meta: {}, tfs: {} };
  for (const tf of Object.keys(TFS)) {
    const rows = loadTf(tf);
    console.log(`[${tf}] ${rows.length.toLocaleString()}봉 · ${new Date(rows[0][0]).toISOString().slice(0, 10)} → ${new Date(rows[rows.length - 1][0]).toISOString().slice(0, 10)}`);
    const res = analyseTf(tf, rows);
    out.tfs[tf] = res;
    console.log(`  사건군 ${res.stats.length}개 · 스캔 ${res.scanned.toLocaleString()}봉 · 기준선 롱적중(5봉) ${(res.baseline.hit[5].up * 100).toFixed(1)}%`);
  }

  // BH FDR — 검정에 들어간 것만 모아 한 번에 보정한다. 봉을 가로질러 같이 보정한다:
  // 1D 와 4H 는 같은 가설을 두 해상도로 물은 것이므로 검정 가족이 하나다.
  const tests = [];
  for (const tf of Object.keys(out.tfs)) {
    for (const s of out.tfs[tf].stats) if (s.judge.tested && s.judge.p !== null) tests.push({ tf, key: s.key, p: s.judge.p, s });
  }
  tests.sort((a, b) => a.p - b.p);
  const m = tests.length;
  let cutoff = -1;
  for (let i = 0; i < m; i += 1) if (tests[i].p <= ((i + 1) / m) * FDR_Q) cutoff = i;
  tests.forEach((t, i) => {
    t.s.judge.rank = i + 1;
    t.s.judge.pAdj = r4(Math.min(1, (t.p * m) / (i + 1)));
    t.s.judge.fdrPass = i <= cutoff;
  });
  for (const tf of Object.keys(out.tfs)) {
    for (const s of out.tfs[tf].stats) {
      s.judge.p = s.judge.p === null ? null : r4(s.judge.p);
      if (s.judge.fdrPass === undefined) s.judge.fdrPass = null;
    }
  }

  const passed = tests.filter((t) => t.s.judge.fdrPass);
  out.meta = {
    generated: new Date().toISOString(),
    inst: "BTC-USDT-SWAP (OKX)",
    source: "선배님 블로그 인용 — 전고점·전저점(30/60/90/120일) · 이평 돌파 · 눌림 · 갭 · 장대봉 이후 · 캔들패턴 유효성",
    judgeK: JUDGE_K,
    ks: KS,
    minN: MIN_N,
    fdrQ: FDR_Q,
    tests: m,
    passed: passed.length,
    passedKeys: passed.map((t) => `${t.tf}·${t.key}`),
  };

  const date = new Date().toISOString().slice(0, 10);
  const path = join(OUT, `${date}-senior-checklist.json`);
  writeFileSync(path, JSON.stringify(out));
  const mb = (Buffer.byteLength(JSON.stringify(out)) / 1024 / 1024).toFixed(2);
  console.log(`\n검정 ${m}건 · FDR ${FDR_Q * 100}% 통과 ${passed.length}건`);
  for (const t of passed) console.log(`  ✓ ${t.tf} · ${t.s.label} — n=${t.s.judge.n} 적중 ${(t.s.judge.hit * 100).toFixed(1)}% (기준 ${(t.s.judge.base * 100).toFixed(1)}%, p=${t.p.toExponential(2)})`);
  console.log(`\n→ ${path} (${mb}MB)`);
}

main();
