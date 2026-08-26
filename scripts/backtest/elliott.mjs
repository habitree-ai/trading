/**
 * ELLIOTT 회차 — 엘리엇 파동을 기계 규칙으로 세었을 때 데이터로 쓸 수 있는지 검토한다.
 *
 * 사람이 그리는 파동은 그대로 검증할 수 없다. 그래서 (1) 피벗을 decompose(rows,R) 의
 * 극값만으로 기계적으로 정하고, (2) 5파 임펄스 규칙 4개·3파 조정을 판정하고, (3) 스윙
 * 길이를 섞은 대조군(200회)으로 "우연 수준"을 못 박고, (4) 4파가 확정된 시점에 서서
 * 5파 목표 도달률을 같은 거리의 무조건 도달률과 견준다. 이 넷의 숫자만 남긴다 — 사람이
 * 그린 파동과 얼마나 닮았는지는 재지 않는다.
 *
 * 정본: .backlog/2-active/REQ-0012_feat_active_elliott-wave-feasibility.md ("정의"·"산출물
 * 스키마" 절이 정본). 판정 문장 자체는 이 스크립트가 쓰지 않는다 — elliott-template.html
 * 이 baseline·forward 원값에서 그대로 계산한다.
 *
 * 사용:
 *   node --max-old-space-size=8192 scripts/backtest/elliott.mjs run
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { C, H, L, O, T, V, decompose, reachScan } from "./lib/oneway-core.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = join(repoRoot, "scripts", "backtest", ".cache");
const OUTDIR = join(repoRoot, "docs", "backtest");

const TFS = ["15m", "1H", "4H", "1D"];
const TF_LABEL = { "15m": "15분봉", "1H": "1시간봉", "4H": "4시간봉", "1D": "일봉" };
const R_BY_TF = { "15m": [0.01, 0.02], "1H": [0.02, 0.03], "4H": [0.03, 0.05], "1D": [0.05, 0.1] };
// 앞보기 상한 — 정본 문서에는 값이 없다. oneway.mjs 의 cap 관례(봉당 앞보기 한도)를
// 그대로 가져와 이 값을 쓴다(판단, 최종 보고에 남김).
const CAP_BY_TF = { "15m": 672, "1H": 336, "4H": 180, "1D": 90 };

const FIB_RETRACE = [0.382, 0.5, 0.618, 0.786];
const FIB_EXT = [1, 1.618, 2.618];
const FIB_W5 = [0.618, 1, 1.618];
const TOL_RETRACE = 0.05;
const TOL_EXT = 0.1;
const TOL_W5 = 0.1; // 정본 axes.tol 에는 없지만 정의 절 문장의 값을 그대로 씀(ext 와 같은 0.10)

const SHUFFLES = 200;
const SEED = 20260826;

// 하위 분할 쌍 — 상위가 나중에 처리되므로(TFS 순서) 상위를 계산할 때 하위 피벗은 이미 캐시돼 있다.
const NEST_PAIRS = [
  { upperTf: "1H", upperR: 0.02, lowerTf: "15m", lowerR: 0.01 },
  { upperTf: "4H", upperR: 0.03, lowerTf: "1H", lowerR: 0.02 },
  { upperTf: "1D", upperR: 0.05, lowerTf: "4H", lowerR: 0.03 },
];

/* ---------------------------------------------------------------------------
 * 공통 헬퍼 — impulse-mtf.mjs 와 같은 이름·같은 구현.
 * ------------------------------------------------------------------------- */
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
const pctOf = (num, den) => (den > 0 ? r2((num / den) * 100) : 0);
const finite = (arr) => arr.filter((v) => Number.isFinite(v));

function loadTf(tf) {
  const p = join(CACHE, `oneway-${tf}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

/** mulberry32 — 작고 빠른 결정적 PRNG. 시드 하나로 재현 가능한 셔플을 만든다. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
}

const fibNear = (v, set, tol) => set.some((f) => Math.abs(v - f) <= tol);
const fibDist = (v, set) => Math.min(...set.map((f) => Math.abs(v - f)));

/* ---------------------------------------------------------------------------
 * 피벗·스윙 — 정의: decompose 결과 leg 들의 극값(ep,ei)만 이어 만든다.
 * 첫 leg 의 시작점 (si,sp) 을 p0 으로 앞에 붙인다(dir = -legs[0].dir).
 * ------------------------------------------------------------------------- */
/**
 * decompose() 는 내부에서 너무 짧은(재조정 후 폭이 남지 않는) leg 를 조용히 버린다 —
 * push() 안의 `ei<=si`·`start>=ei` 두 return 이 그것이다. 그때도 바깥 루프의 dir 는
 * 버려진 leg 몫까지 그대로 뒤집히므로, 반환된 legs 배열에는 같은 방향이 연속으로
 * 나오는 지점이 실제로 생긴다(15m R=1% 에서 20,703 leg 중 294곳, 8조합 전부에서 관찰).
 * 정본 문서의 "극값은 교대로 이어진다"는 이 부작용을 가정하지 않았다.
 *
 * decompose 를 수정할 수 없으므로(수정 금지) 같은 방향이 연속되는 구간(run)을 만나면
 * 그 run 안에서 실제로 가장 먼 값(상승 run 이면 최고가, 하락 run 이면 최저가)만 남기고
 * 합친다 — run 내부의 나머지는 "그 방향 안에서 다시 갱신된 극값"일 뿐 새 반전이 아니다.
 * run 내부가 항상 단조는 아니어서(277 run 중 23곳) 마지막이 아니라 극값 자체를 골라야 한다.
 * 판단: 이 병합은 정본에 없는 처리이며 최종 보고에 남긴다.
 */
function collapseRuns(pivots) {
  if (pivots.length <= 1) return pivots;
  const out = [pivots[0]];
  let i = 1;
  while (i < pivots.length) {
    let j = i;
    let best = pivots[i];
    while (j + 1 < pivots.length && pivots[j + 1].dir === pivots[i].dir) {
      j += 1;
      const cand = pivots[j];
      if (pivots[i].dir === 1 ? cand.price > best.price : cand.price < best.price) best = cand;
    }
    out.push(best);
    i = j + 1;
  }
  return out;
}

function buildPivots(rows, r) {
  const legs = decompose(rows, r);
  if (!legs.length) return { legs, pivots: [] };
  const raw = [{ idx: legs[0].si, t: rows[legs[0].si][T], price: legs[0].sp, dir: -legs[0].dir }];
  for (const l of legs) raw.push({ idx: l.ei, t: rows[l.ei][T], price: l.ep, dir: l.dir });
  return { legs, pivots: collapseRuns(raw) };
}

/** 불변식 ① — 피벗 방향이 엄격히 교대해야 한다. decompose 가 이미 그렇게 만들지만 확인한다. */
function checkAlternation(pivots, tfLabel, r) {
  for (let i = 1; i < pivots.length; i += 1) {
    if (pivots[i].dir === pivots[i - 1].dir) {
      console.error(`✗ [${tfLabel} R=${r}] 불변식① 위반 — 피벗 방향 교대 깨짐 i=${i} t=${iso(pivots[i].t)}`);
      process.exit(1);
    }
  }
}

function buildSwings(pivots) {
  const swings = [];
  for (let k = 0; k < pivots.length - 1; k += 1) {
    const a = pivots[k], b = pivots[k + 1];
    swings.push({
      dir: b.dir,
      lenPct: (Math.abs(b.price - a.price) / a.price) * 100,
      bars: b.idx - a.idx,
      t0: a.t, t1: b.t, p0: a.price, p1: b.price,
    });
  }
  return swings;
}

/* ---------------------------------------------------------------------------
 * 임펄스 규칙 4개 — 상승(d=1) 기준, 하락은 부등호를 반대로("하락은 거울").
 * 비율(w2w1 등)은 가격 차이를 그대로 나눈 값이라 방향에 상관없이 부호가 맞는다
 * (분자·분모가 함께 뒤집혀 상쇄된다) — 그래서 ruleCheck 에만 d 분기가 필요하다.
 * ------------------------------------------------------------------------- */
function ruleCheck(pv, d) {
  const [p0, p1, p2, p3, p4, p5] = pv;
  const r1 = d === 1 ? p2 > p0 : p2 < p0;
  const r3 = d === 1 ? p4 > p1 : p4 < p1;
  const r4 = d === 1 ? p5 > p3 : p5 < p3;
  const len1 = Math.abs(p1 - p0), len3 = Math.abs(p3 - p2), len5 = Math.abs(p5 - p4);
  // "3파가 가장 짧지 않다" — 동률은 짧지 않은 것으로 본다(엄격한 최솟값만 탈락).
  const r2ok = !(len3 < len1 && len3 < len5);
  return { r1, r2: r2ok, r3, r4, candidate: r1 && r2ok && r3 && r4, truncated: r1 && r2ok && r3 && !r4 };
}

function computeRatios(pv) {
  const [p0, p1, p2, p3, p4, p5] = pv;
  return {
    w2w1: (p1 - p2) / (p1 - p0),
    w3w1: (p3 - p2) / (p1 - p0),
    w4w3: (p3 - p4) / (p3 - p2),
    w5w1: (p5 - p4) / (p1 - p0),
    w5net: (p5 - p4) / (p3 - p0),
  };
}

/** 5스윙 창 전수(겹침 허용) — 실 데이터용. 피벗 참조를 들고 있어 샘플·조정에 재사용한다. */
function buildAllWindows(pivots, swings) {
  const out = [];
  for (let k = 0; k + 4 < swings.length; k += 1) {
    const P = pivots.slice(k, k + 6);
    const pv = P.map((p) => p.price);
    const d = swings[k].dir;
    const rules = ruleCheck(pv, d);
    const w = { k, d, P, pv, rules };
    if (rules.candidate) w.ratios = computeRatios(pv);
    out.push(w);
  }
  return out;
}

/** 겹침 제거본 — 시간순 greedy, 후보를 만나면 그 5스윙(6피벗)을 소비하고 다음 창으로 건너뛴다. */
function buildNonOverlap(allWindows) {
  const out = [];
  let k = 0;
  while (k < allWindows.length) {
    const w = allWindows[k];
    if (w.rules.candidate) { out.push(w); k += 5; } else k += 1;
  }
  return out;
}

/** 대조군용 빠른 카운터 — 객체를 만들지 않고 후보·절단·근접 건수만 센다(200회 반복이라 성능 우선). */
function scanImpulseStats(prices, dirs) {
  const n = dirs.length;
  let windows = 0, candidates = 0, truncated = 0;
  let nearW2W1 = 0, nearW3W1 = 0, nearW4W3 = 0, nearW5W1 = 0;
  for (let k = 0; k + 4 < n; k += 1) {
    windows += 1;
    const d = dirs[k];
    const p0 = prices[k], p1 = prices[k + 1], p2 = prices[k + 2], p3 = prices[k + 3], p4 = prices[k + 4], p5 = prices[k + 5];
    const r1 = d === 1 ? p2 > p0 : p2 < p0;
    const r3 = d === 1 ? p4 > p1 : p4 < p1;
    const r4 = d === 1 ? p5 > p3 : p5 < p3;
    const len1 = Math.abs(p1 - p0), len3 = Math.abs(p3 - p2), len5 = Math.abs(p5 - p4);
    const r2ok = !(len3 < len1 && len3 < len5);
    if (r1 && r2ok && r3) {
      if (r4) candidates += 1; else truncated += 1;
    }
    if (r1 && r2ok && r3 && r4) {
      const w2w1 = (p1 - p2) / (p1 - p0), w3w1 = (p3 - p2) / (p1 - p0), w4w3 = (p3 - p4) / (p3 - p2), w5w1 = (p5 - p4) / (p1 - p0);
      if (fibNear(w2w1, FIB_RETRACE, TOL_RETRACE)) nearW2W1 += 1;
      if (fibNear(w3w1, FIB_EXT, TOL_EXT)) nearW3W1 += 1;
      if (fibNear(w4w3, FIB_RETRACE, TOL_RETRACE)) nearW4W3 += 1;
      if (fibNear(w5w1, FIB_W5, TOL_W5)) nearW5W1 += 1;
    }
  }
  return { windows, candidates, truncated, nearW2W1, nearW3W1, nearW4W3, nearW5W1 };
}

/* ---------------------------------------------------------------------------
 * 대조군 — 스윙의 (길이,봉수) 쌍을 함께 셔플, 방향은 원래 순서 그대로 유지.
 * 가격은 시작 피벗 p0 에서 누적 곱해 재구성한다(스케일이 달라져도 비율·규칙은
 * 상대 비교라 영향받지 않는다 — 실제 시작가를 그대로 쓴 것은 정의를 그대로 따른 것).
 * ------------------------------------------------------------------------- */
function runControl(swings, startPrice, seed, shuffles, observed) {
  const rng = mulberry32(seed);
  const n = swings.length;
  const dirs = swings.map((s) => s.dir);
  const rateArr = [], truncArr = [];
  const fibArrs = { w2w1: [], w3w1: [], w4w3: [], w5w1: [] };

  for (let iter = 0; iter < shuffles; iter += 1) {
    const pool = swings.map((s) => ({ lenPct: s.lenPct, bars: s.bars }));
    shuffleInPlace(pool, rng);
    // 불변식 ④ — 합성 스윙 수 = 원본 스윙 수 (셔플은 같은 배열의 순서만 바꾸므로 자명하나 확인한다)
    if (pool.length !== n) {
      console.error("✗ 불변식④ 위반 — 합성 스윙 수가 원본과 다름");
      process.exit(1);
    }
    const prices = new Array(n + 1);
    prices[0] = startPrice;
    for (let k = 0; k < n; k += 1) prices[k + 1] = prices[k] * (1 + dirs[k] * (pool[k].lenPct / 100));

    const st = scanImpulseStats(prices, dirs);
    rateArr.push(pctOf(st.candidates, st.windows));
    truncArr.push(pctOf(st.truncated, st.windows));
    fibArrs.w2w1.push(pctOf(st.nearW2W1, st.candidates));
    fibArrs.w3w1.push(pctOf(st.nearW3W1, st.candidates));
    fibArrs.w4w3.push(pctOf(st.nearW4W3, st.candidates));
    fibArrs.w5w1.push(pctOf(st.nearW5W1, st.candidates));
  }

  const ms = (arr) => ({ mean: r2(mean(arr)), p95: r2(q(arr, 0.95)) });
  return {
    shuffles,
    observedRate: r2(observed.rate),
    rate: ms(rateArr),
    truncRate: ms(truncArr),
    fibNear: {
      w2w1: { ...ms(fibArrs.w2w1), observed: r2(observed.fibNear.w2w1) },
      w3w1: { ...ms(fibArrs.w3w1), observed: r2(observed.fibNear.w3w1) },
      w4w3: { ...ms(fibArrs.w4w3), observed: r2(observed.fibNear.w4w3) },
      w5w1: { ...ms(fibArrs.w5w1), observed: r2(observed.fibNear.w5w1) },
    },
  };
}

/* ---------------------------------------------------------------------------
 * 조정(ABC) — 임펄스 후보(겹침 제거본) 직후 3스윙. 캐시 끝을 넘으면 제외.
 * ------------------------------------------------------------------------- */
function buildCorrection(w, pivots, nSwings) {
  const k = w.k;
  if (k + 8 > nSwings) return null; // 직후 3스윙(피벗 3개 더)이 없으면 제외
  const p5 = pivots[k + 5], pA = pivots[k + 6], pB = pivots[k + 7], pC = pivots[k + 8];
  const d = w.d;
  const zigzag = d === 1 ? pC.price < pA.price : pC.price > pA.price;
  const retrace = (p5.price - pC.price) / (p5.price - w.pv[0]);
  const lenA = Math.abs(pA.price - p5.price);
  const lenC = Math.abs(pC.price - pB.price);
  const cVsA = lenA > 0 ? lenC / lenA : 0;
  return { p5, pA, pB, pC, zigzag, retrace, cVsA };
}

/* ---------------------------------------------------------------------------
 * 전방 검증 — 판단 봉(4파 확정) 이후 목표 도달을 R% 역행 전에 맞혔는지.
 * ------------------------------------------------------------------------- */
function findDecisionBar(rows, p4Idx, p4Price, d, r, cap) {
  const end = Math.min(rows.length, p4Idx + 1 + cap);
  for (let j = p4Idx + 1; j < end; j += 1) {
    if (d === 1) { if ((rows[j][H] - p4Price) / p4Price >= r) return j; }
    else if ((p4Price - rows[j][L]) / p4Price >= r) return j;
  }
  return null;
}

/** "역행 먼저" 순서 — decompose·reachScan 과 같다: 이번 봉의 역행을 먼저 보고, 그다음 목표, 그다음 극값 갱신. */
function reachTargetFrom(rows, startIdx, target, d, r, cap) {
  const end = Math.min(rows.length, startIdx + 1 + cap);
  if (d === 1) {
    let peak = rows[startIdx][C];
    for (let j = startIdx + 1; j < end; j += 1) {
      const hi = rows[j][H], lo = rows[j][L];
      if ((peak - lo) / peak >= r) return { reached: false };
      if (hi >= target) return { reached: true, atIdx: j };
      if (hi > peak) peak = hi;
    }
  } else {
    let trough = rows[startIdx][C];
    for (let j = startIdx + 1; j < end; j += 1) {
      const hi = rows[j][H], lo = rows[j][L];
      if ((hi - trough) / trough >= r) return { reached: false };
      if (lo <= target) return { reached: true, atIdx: j };
      if (lo < trough) trough = lo;
    }
  }
  return { reached: false };
}

function baseRateFor(reachArr, d) {
  if (!reachArr.length) return 0;
  let c = 0;
  for (let i = 0; i < reachArr.length; i += 1) if (reachArr[i] >= d) c += 1;
  return (c / reachArr.length) * 100;
}

function computeForward(rows, swings, pivots, reach, r, cap) {
  const n = swings.length;
  const raw = [];
  for (let k = 0; k + 3 < n; k += 1) {
    const d = swings[k].dir;
    const p0 = pivots[k].price, p1 = pivots[k + 1].price, p2 = pivots[k + 2].price, p3 = pivots[k + 3].price, p4 = pivots[k + 4].price;
    const r1ok = d === 1 ? p2 > p0 : p2 < p0;
    const r3ok = d === 1 ? p4 > p1 : p4 < p1;
    const len1 = Math.abs(p1 - p0), len3 = Math.abs(p3 - p2);
    if (r1ok && r3ok && len3 > len1) raw.push({ d, p0, p1, p2, p3, p4, p4Idx: pivots[k + 4].idx });
  }

  const resolved = [];
  for (const c of raw) {
    const j = findDecisionBar(rows, c.p4Idx, c.p4, c.d, r, cap);
    if (j === null) continue; // 판단 봉이 앞보기 상한 안에 없음 — 제외
    resolved.push({ ...c, j, startPrice: rows[j][C] });
  }

  const TARGET_DEFS = [
    { key: "eq1", label: "5 = 1", fn: (c) => c.p4 + (c.p1 - c.p0) },
    { key: "f618", label: "0.618×(0→3)", fn: (c) => c.p4 + 0.618 * (c.p3 - c.p0) },
  ];

  const allDist = [];
  const targets = TARGET_DEFS.map((td) => {
    const up = resolved.filter((c) => c.d === 1);
    const dn = resolved.filter((c) => c.d === -1);
    const distUp = up.map((c) => Math.abs(((td.fn(c) - c.startPrice) / c.startPrice) * 100));
    const distDn = dn.map((c) => Math.abs(((td.fn(c) - c.startPrice) / c.startPrice) * 100));
    allDist.push(...distUp, ...distDn);
    const dUp = distUp.length ? q(distUp, 0.5) : 0;
    const dDn = distDn.length ? q(distDn, 0.5) : 0;
    const baseUp = baseRateFor(reach.up, dUp);
    const baseDn = baseRateFor(reach.dn, dDn);
    const nUp = up.length, nDn = dn.length, nTot = nUp + nDn;
    const baseRate = nTot > 0 ? (nUp * baseUp + nDn * baseDn) / nTot : 0;

    let hit = 0;
    for (const c of resolved) {
      const res = reachTargetFrom(rows, c.j, td.fn(c), c.d, r, cap);
      if (res.reached) {
        if (res.atIdx <= c.j) {
          console.error(`✗ 불변식③ 위반 — 도달봉(${res.atIdx}) <= 판단봉(${c.j})`);
          process.exit(1);
        }
        hit += 1;
      }
    }
    const rate = pctOf(hit, resolved.length);
    const baseRateR = r2(baseRate);
    const lift = baseRateR > 0 ? r2(rate / baseRateR) : 0;
    return { key: td.key, label: td.label, n: resolved.length, hit, rate, baseRate: baseRateR, lift };
  });

  return {
    forward: { candidates: resolved.length, distPct: { p50: allDist.length ? r2(q(allDist, 0.5)) : 0 }, targets },
    resolved, // 손 대조 로그용 — 최종 JSON 에는 담지 않는다
  };
}

/* ---------------------------------------------------------------------------
 * 하위 분할(nesting) — 상위 임펄스 후보(겹침 제거본)의 3파·2파 시간창 안에 든
 * 하위봉 피벗 수. 시간 이분 탐색(정렬된 피벗 시각 배열 기준).
 * ------------------------------------------------------------------------- */
function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
function upperBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}
function countInRange(sortedT, from, to) {
  return upperBound(sortedT, to) - lowerBound(sortedT, from);
}
function histOf(counts) {
  const hist = {};
  for (let i = 0; i <= 12; i += 1) hist[String(i)] = 0;
  hist["12+"] = 0;
  for (const c of counts) { const k = c > 12 ? "12+" : String(c); hist[k] += 1; }
  return hist;
}
function computeNesting(nonOverlap, lowerTf, lowerR, lowerPivotTimes) {
  const wave3Counts = [], wave2Counts = [];
  for (const w of nonOverlap) {
    const t1 = w.P[1].t, t2 = w.P[2].t, t3 = w.P[3].t;
    const n3 = countInRange(lowerPivotTimes, t2, t3);
    const n2v = countInRange(lowerPivotTimes, t1, t2);
    wave3Counts.push(Math.max(0, n3 - 1));
    wave2Counts.push(Math.max(0, n2v - 1));
  }
  const share = (arr, v) => pctOf(arr.filter((x) => x === v).length, arr.length);
  return {
    lowerTf, lowerR,
    wave3: { hist: histOf(wave3Counts), p50: r2(q(wave3Counts, 0.5)), share5: share(wave3Counts, 5) },
    wave2: { hist: histOf(wave2Counts), p50: r2(q(wave2Counts, 0.5)), share3: share(wave2Counts, 3) },
  };
}

/* ---------------------------------------------------------------------------
 * 캔들 스니펫 — oneway.mjs 의 snippet() 그대로 복사. impulse-mtf.mjs 가 이미 같은
 * 이유로 이렇게 했다: oneway.mjs 를 import 하면 그 파일 맨 아래 `if (cmd==="run")
 * cmdRun()` 이 이 스크립트가 "run" 인자를 쓰는 순간 함께 실행돼 버린다. 로직은
 * 바꾸지 않았다.
 * ------------------------------------------------------------------------- */
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

/* ---------------------------------------------------------------------------
 * 대표 사례 — 임펄스 8(순이동 최대 3·피보나치 근접도 최고 3·최근 2) + 조정 4(zigzag 2·flat 2, 최근순).
 * 창: p0(또는 p5) 앞뒤 15% 여백, 최대 240봉으로 묶음.
 * ------------------------------------------------------------------------- */
function sampleWindow(rows, si, ei) {
  const span = ei - si;
  // 짧은 임펄스(1H 에서 8봉짜리도 있다)는 15% 여백이 한두 봉이라 차트가 파동만 덩그러니 남는다 — 최소 12봉은 앞뒤로 둔다.
  const pad = Math.max(12, Math.round(span * 0.15));
  const from = Math.max(0, si - pad);
  const to = Math.min(rows.length - 1, ei + pad);
  return snippet(rows, from, to, si, ei, 240);
}

function buildImpulseSample(w, why, rows) {
  const si = w.P[0].idx, ei = w.P[5].idx;
  const sn = sampleWindow(rows, si, ei);
  const ratios = w.ratios;
  const fibHits = [];
  if (fibNear(ratios.w2w1, FIB_RETRACE, TOL_RETRACE)) fibHits.push("w2w1");
  if (fibNear(ratios.w3w1, FIB_EXT, TOL_EXT)) fibHits.push("w3w1");
  if (fibNear(ratios.w4w3, FIB_RETRACE, TOL_RETRACE)) fibHits.push("w4w3");
  if (fibNear(ratios.w5w1, FIB_W5, TOL_W5)) fibHits.push("w5w1");
  const labels = ["0", "1", "2", "3", "4", "5"];
  return {
    kind: "impulse", why, dir: w.d,
    startLabel: iso(w.P[0].t), endLabel: iso(w.P[5].t),
    netMove: r2((Math.abs(w.pv[5] - w.pv[0]) / w.pv[0]) * 100),
    bars: ei - si,
    pivots: w.P.map((p, i) => [p.t, Math.round(p.price), labels[i]]),
    ratios: { w2w1: r3(ratios.w2w1), w3w1: r3(ratios.w3w1), w4w3: r3(ratios.w4w3), w5w1: r3(ratios.w5w1) },
    fibHits,
    candles: sn.candles, step: sn.step, si: sn.si, ei: sn.ei,
  };
}
function buildCorrectionSample(entry, rows) {
  const { w, corr } = entry;
  const si = corr.p5.idx, ei = corr.pC.idx;
  const sn = sampleWindow(rows, si, ei);
  const fibHits = [];
  if (fibNear(corr.retrace, FIB_RETRACE, TOL_RETRACE)) fibHits.push("retrace");
  if (fibNear(corr.cVsA, FIB_W5, TOL_W5)) fibHits.push("cVsA");
  return {
    kind: "correction", why: corr.zigzag ? "zigzag · 최근순" : "flat · 최근순", dir: -w.d,
    startLabel: iso(corr.p5.t), endLabel: iso(corr.pC.t),
    netMove: r2((Math.abs(corr.pC.price - corr.p5.price) / corr.p5.price) * 100),
    bars: ei - si,
    pivots: [
      [corr.p5.t, Math.round(corr.p5.price), "5"],
      [corr.pA.t, Math.round(corr.pA.price), "A"],
      [corr.pB.t, Math.round(corr.pB.price), "B"],
      [corr.pC.t, Math.round(corr.pC.price), "C"],
    ],
    ratios: { retrace: r3(corr.retrace), cVsA: r3(corr.cVsA) },
    fibHits,
    candles: sn.candles, step: sn.step, si: sn.si, ei: sn.ei,
  };
}
function pickSamples(nonOverlap, corrList, rows) {
  const picked = []; const seen = new Set();
  const add = (w, why) => { if (!w || seen.has(w.k)) return; seen.add(w.k); picked.push(buildImpulseSample(w, why, rows)); };
  const take = (arr, n, why) => arr.slice(0, n).forEach((w) => add(w, why));

  take([...nonOverlap].sort((a, b) => Math.abs(b.pv[5] - b.pv[0]) / b.pv[0] - Math.abs(a.pv[5] - a.pv[0]) / a.pv[0]), 3, "순이동 최대");
  take(
    [...nonOverlap].sort((a, b) => {
      const da = fibDist(a.ratios.w2w1, FIB_RETRACE) + fibDist(a.ratios.w3w1, FIB_EXT) + fibDist(a.ratios.w4w3, FIB_RETRACE);
      const db = fibDist(b.ratios.w2w1, FIB_RETRACE) + fibDist(b.ratios.w3w1, FIB_EXT) + fibDist(b.ratios.w4w3, FIB_RETRACE);
      return da - db;
    }),
    3,
    "피보나치 근접도 최고",
  );
  take([...nonOverlap].sort((a, b) => b.P[5].idx - a.P[5].idx), 2, "최근");

  const zz = corrList.filter((x) => x.corr.zigzag).sort((a, b) => b.corr.pC.idx - a.corr.pC.idx).slice(0, 2);
  const fl = corrList.filter((x) => !x.corr.zigzag).sort((a, b) => b.corr.pC.idx - a.corr.pC.idx).slice(0, 2);
  for (const e of [...zz, ...fl]) picked.push(buildCorrectionSample(e, rows));

  return picked;
}

/* ---------------------------------------------------------------------------
 * 봉 × R 한 조합 분석.
 * ------------------------------------------------------------------------- */
function analyzeTfR(tf, r, rows, spanYears, pivotCache, logLines) {
  const cap = CAP_BY_TF[tf];
  const { pivots } = buildPivots(rows, r);
  checkAlternation(pivots, tf, r);
  const swings = buildSwings(pivots);
  pivotCache.set(`${tf}|${r}`, { pivots, times: pivots.map((p) => p.t) });

  const allWindows = buildAllWindows(pivots, swings);
  const windows = allWindows.length;
  const impulseCandidates = allWindows.filter((w) => w.rules.candidate);
  const truncatedList = allWindows.filter((w) => w.rules.truncated);
  const nonOverlap = buildNonOverlap(allWindows);

  // 자체 정합성 확인 — scanImpulseStats(빠른 카운터)와 상세 스캔이 같은 후보 수를 내야 한다.
  const selfCheck = scanImpulseStats(pivots.map((p) => p.price), swings.map((s) => s.dir));
  if (selfCheck.candidates !== impulseCandidates.length || selfCheck.windows !== windows) {
    console.error(`✗ [${tf} R=${r}] 내부 정합성 불일치 — 빠른 스캔(${selfCheck.candidates}/${selfCheck.windows}) vs 상세 스캔(${impulseCandidates.length}/${windows})`);
    process.exit(1);
  }

  const rulePass = {
    r1: pctOf(allWindows.filter((w) => w.rules.r1).length, windows),
    r2: pctOf(allWindows.filter((w) => w.rules.r2).length, windows),
    r3: pctOf(allWindows.filter((w) => w.rules.r3).length, windows),
    r4: pctOf(allWindows.filter((w) => w.rules.r4).length, windows),
  };

  const ratioArrs = { w2w1: [], w3w1: [], w4w3: [], w5w1: [], w5net: [] };
  const t3t1Arr = [], netMoveArr = [], barsArr = [];
  let up = 0, dn = 0;
  for (const w of impulseCandidates) {
    if (w.d === 1) up += 1; else dn += 1;
    ratioArrs.w2w1.push(w.ratios.w2w1);
    ratioArrs.w3w1.push(w.ratios.w3w1);
    ratioArrs.w4w3.push(w.ratios.w4w3);
    ratioArrs.w5w1.push(w.ratios.w5w1);
    ratioArrs.w5net.push(w.ratios.w5net);
    const bars1 = swings[w.k].bars, bars3 = swings[w.k + 2].bars;
    t3t1Arr.push(bars3 / Math.max(bars1, 1e-9));
    netMoveArr.push((Math.abs(w.pv[5] - w.pv[0]) / w.pv[0]) * 100);
    barsArr.push(w.P[5].idx - w.P[0].idx);
  }
  const w2w1F = finite(ratioArrs.w2w1), w3w1F = finite(ratioArrs.w3w1), w4w3F = finite(ratioArrs.w4w3), w5w1F = finite(ratioArrs.w5w1), w5netF = finite(ratioArrs.w5net);

  const ratiosOut = {
    w2w1: { p25: r3(q(w2w1F, 0.25)), p50: r3(q(w2w1F, 0.5)), p75: r3(q(w2w1F, 0.75)), fibNear: pctOf(w2w1F.filter((v) => fibNear(v, FIB_RETRACE, TOL_RETRACE)).length, w2w1F.length) },
    w3w1: { p25: r3(q(w3w1F, 0.25)), p50: r3(q(w3w1F, 0.5)), p75: r3(q(w3w1F, 0.75)), fibNear: pctOf(w3w1F.filter((v) => fibNear(v, FIB_EXT, TOL_EXT)).length, w3w1F.length) },
    w4w3: { p25: r3(q(w4w3F, 0.25)), p50: r3(q(w4w3F, 0.5)), p75: r3(q(w4w3F, 0.75)), fibNear: pctOf(w4w3F.filter((v) => fibNear(v, FIB_RETRACE, TOL_RETRACE)).length, w4w3F.length) },
    w5w1: { p25: r3(q(w5w1F, 0.25)), p50: r3(q(w5w1F, 0.5)), p75: r3(q(w5w1F, 0.75)), fibNear: pctOf(w5w1F.filter((v) => fibNear(v, FIB_W5, TOL_W5)).length, w5w1F.length) },
    w5net: { p25: r3(q(w5netF, 0.25)), p50: r3(q(w5netF, 0.5)), p75: r3(q(w5netF, 0.75)) },
    t3t1: { p50: r3(q(t3t1Arr, 0.5)) },
  };

  const impulse = {
    count: impulseCandidates.length, countNonOverlap: nonOverlap.length, up, dn,
    perYear: r2(impulseCandidates.length / spanYears),
    truncated: truncatedList.length,
    rulePass, ratios: ratiosOut,
    netMove: { p50: r2(q(netMoveArr, 0.5)), p90: r2(q(netMoveArr, 0.9)) },
    bars: { p50: r2(q(barsArr, 0.5)), p90: r2(q(barsArr, 0.9)) },
  };

  const observed = {
    rate: pctOf(impulseCandidates.length, windows),
    fibNear: { w2w1: ratiosOut.w2w1.fibNear, w3w1: ratiosOut.w3w1.fibNear, w4w3: ratiosOut.w4w3.fibNear, w5w1: ratiosOut.w5w1.fibNear },
  };
  const baseline = runControl(swings, pivots[0].price, SEED, SHUFFLES, observed);

  const corrList = [];
  for (const w of nonOverlap) {
    const c = buildCorrection(w, pivots, swings.length);
    if (c) corrList.push({ w, corr: c });
  }
  const retraceArr = finite(corrList.map((x) => x.corr.retrace));
  const cVsAArr = finite(corrList.map((x) => x.corr.cVsA));
  const zigzagCount = corrList.filter((x) => x.corr.zigzag).length;
  const correction = {
    count: corrList.length, zigzag: zigzagCount, flat: corrList.length - zigzagCount,
    retrace: {
      p25: r3(q(retraceArr, 0.25)), p50: r3(q(retraceArr, 0.5)), p75: r3(q(retraceArr, 0.75)),
      fibNear: pctOf(retraceArr.filter((v) => fibNear(v, FIB_RETRACE, TOL_RETRACE)).length, retraceArr.length),
    },
    cVsA: { p50: r3(q(cVsAArr, 0.5)), fibNear: pctOf(cVsAArr.filter((v) => fibNear(v, FIB_W5, TOL_W5)).length, cVsAArr.length) },
  };

  const reach = reachScan(rows, r, cap);
  const { forward, resolved } = computeForward(rows, swings, pivots, reach, r, cap);

  const samples = pickSamples(nonOverlap, corrList, rows);

  let nesting = null;
  const pair = NEST_PAIRS.find((p) => p.upperTf === tf && p.upperR === r);
  if (pair) {
    const lower = pivotCache.get(`${pair.lowerTf}|${pair.lowerR}`);
    if (!lower) { console.error(`✗ [${tf} R=${r}] 하위 봉(${pair.lowerTf} R=${pair.lowerR}) 피벗이 아직 없음`); process.exit(1); }
    nesting = computeNesting(nonOverlap, pair.lowerTf, pair.lowerR, lower.times);
  }

  const lenAll = swings.map((s) => s.lenPct), barsAll = swings.map((s) => s.bars);
  const entry = {
    r, pivots: pivots.length, swings: swings.length,
    swingLen: { p50: r2(q(lenAll, 0.5)), p90: r2(q(lenAll, 0.9)) },
    swingBars: { p50: r2(q(barsAll, 0.5)), p90: r2(q(barsAll, 0.9)) },
    windows, impulse, baseline, correction, forward, nesting, samples,
  };

  logLines.push(
    `[${tf} R=${r}] 피벗 ${pivots.length.toLocaleString()} · 창 ${windows.toLocaleString()} · ` +
      `후보 ${impulseCandidates.length.toLocaleString()}(겹침)/${nonOverlap.length.toLocaleString()}(비겹침) · 절단 ${truncatedList.length.toLocaleString()} · ` +
      `대조군후보율 mean ${baseline.rate.mean}%/p95 ${baseline.rate.p95}% vs 관측 ${baseline.observedRate}% · ` +
      `w2w1근접 관측 ${baseline.fibNear.w2w1.observed}% vs 대조군p95 ${baseline.fibNear.w2w1.p95}% · ` +
      `전방eq1 n=${forward.targets[0].n} hit=${forward.targets[0].hit} rate=${forward.targets[0].rate}% base=${forward.targets[0].baseRate}% lift=${forward.targets[0].lift}×`,
  );

  return { entry, nonOverlap, resolved, pivots };
}

/* ---------------------------------------------------------------------------
 * 실행
 * ------------------------------------------------------------------------- */
function cmdRun() {
  const t0 = Date.now();
  console.log("캐시 로드…");
  const rowsByTf = {};
  for (const tf of TFS) {
    rowsByTf[tf] = loadTf(tf);
    if (!rowsByTf[tf]) { console.error(`✗ 캐시 없음: ${tf}`); process.exit(1); }
    console.log(`  [${tf}] ${rowsByTf[tf].length.toLocaleString()}봉`);
  }

  const pivotCache = new Map();
  const logLines = [];
  const tfs = [];
  let handCheck1H = null; // 1H R=0.02 손 대조용

  for (const tf of TFS) {
    const rows = rowsByTf[tf];
    const spanMs = rows[rows.length - 1][T] - rows[0][T];
    const spanYears = spanMs / (365.25 * 86_400_000);
    const byR = {};
    for (const r of R_BY_TF[tf]) {
      const { entry, nonOverlap, resolved } = analyzeTfR(tf, r, rows, spanYears, pivotCache, logLines);
      byR[String(r)] = entry;
      if (tf === "1H" && r === 0.02) handCheck1H = { nonOverlap, resolved };
    }
    tfs.push({
      tf, label: TF_LABEL[tf], bars: rows.length,
      spanDays: Math.round(spanMs / 86_400_000), spanYears: r2(spanYears),
      from: iso(rows[0][T]), to: iso(rows[rows.length - 1][T]),
      byR,
    });
  }

  console.log("\n실행 로그 (봉×R 8조합):");
  for (const line of logLines) console.log("  " + line);

  // 손 대조 — 1H R=0.02 임펄스 후보 2건 + 전방 후보 1건.
  console.log("\n손 대조 — 1H R=0.02:");
  if (handCheck1H) {
    const two = handCheck1H.nonOverlap.slice(0, 2);
    for (const w of two) {
      console.log(`  임펄스 후보 k=${w.k} dir=${w.d} 규칙 r1=${w.rules.r1} r2=${w.rules.r2} r3=${w.rules.r3} r4=${w.rules.r4}`);
      w.P.forEach((p, i) => console.log(`    p${i}: ${iso(p.t)} · ${Math.round(p.price).toLocaleString()}`));
    }
    const fc = handCheck1H.resolved[0];
    if (fc) {
      const Teq1 = fc.p4 + (fc.p1 - fc.p0);
      const rows1H = rowsByTf["1H"];
      const res = reachTargetFrom(rows1H, fc.j, Teq1, fc.d, 0.02, CAP_BY_TF["1H"]);
      console.log(
        `  전방 후보: 판단봉 ${iso(rows1H[fc.j][T])} · 출발가 ${Math.round(fc.startPrice).toLocaleString()} · ` +
          `목표(5=1) ${Math.round(Teq1).toLocaleString()} · 도달 ${res.reached ? iso(rows1H[res.atIdx][T]) : "미도달"}`,
      );
    } else {
      console.log("  전방 후보 없음(판단 봉이 앞보기 상한 안에서 발견되지 않음)");
    }
  } else {
    console.log("  1H R=0.02 결과 없음");
  }

  const fetchPath = join(CACHE, "oneway-fetch-report.json");
  const fetchReport = existsSync(fetchPath) ? JSON.parse(readFileSync(fetchPath, "utf8")) : [];

  const data = {
    round: "elliott",
    name: "엘리엇 파동 적용 가능성",
    generatedAt: new Date().toISOString(),
    inst: "BTC-USDT-SWAP (OKX)",
    question: "BTC 15m·1H·4H·1D 에서 되돌림 임계 R 로 자른 피벗을 5파 임펄스 규칙으로 세면, 그 구조가 무작위 지그재그보다 더 자주 나오고 4파 확정 시점에서 5파 목표를 맞히는 데 쓸모가 있는가",
    definition: {
      pivot: "decompose(rows,R) 가 돌려주는 leg 들의 극값(ep,ei)만 이어 만든다. leg 의 재조정된 si/sp 는 쓰지 않는다. 피벗 p_k=(t_k,price_k,dirOfSwingEndingHere). 스윙 k = p_{k-1}→p_k, 길이 len_k=|price_k-price_{k-1}|/price_{k-1}×100, 봉수 bars_k. R(봉별): 15m {1,2}% · 1H {2,3}% · 4H {3,5}% · 1D {5,10}%.",
      impulse: "연속 5스윙 s1..s5(s1 방향 d, 피벗 p0..p5). 상승(d=+1) 기준, 하락은 거울: R1 p2>p0(2파는 1파 시작을 넘지 않는다) · R2 3파가 1·3·5 중 가장 짧지 않다 · R3 p4>p1(4파가 1파 영역에 들어오지 않는다) · R4 p5>p3(미절단). 4개 전부 통과=임펄스 후보. R1~R3 통과·R4 실패=절단(truncated). 비율: w2w1=(p1-p2)/(p1-p0) · w3w1=(p3-p2)/(p1-p0) · w4w3=(p3-p4)/(p3-p2) · w5w1=(p5-p4)/(p1-p0) · w5net=(p5-p4)/(p3-p0) · t3t1=bars3/bars1. 창은 겹칠 수 있다(스윙 하나씩 밀며 전수). 겹침 제거본(비겹침 greedy, 시간순)도 count 로 함께 둔다.",
      fib: "되돌림(w2w1·w4w3·조정 되돌림)은 {0.382,0.5,0.618,0.786}±0.05 · 연장(w3w1)은 {1.0,1.618,2.618}±0.10 · w5w1 은 {0.618,1.0,1.618}±0.10 안에 들면 근접. 근접률=근접 건수/전체.",
      baseline: "같은 피벗 열에서 스윙 길이(len_k)와 봉수를 함께 섞어(교대 방향은 유지) 합성 피벗 열을 200회 만들고, 임펄스 후보율(후보/창)·절단율·피보나치 근접률을 같은 규칙으로 잰다. mean·p95 를 남긴다. 시드 고정(20260826, mulberry32).",
      correction: "임펄스 후보(겹침 제거본) 직후 3스윙(A·B·C, 반대 방향). C 가 A 끝을 넘으면 zigzag, 아니면 flat. 되돌림=(p5-pC)/(p5-p0). cVsA=lenC/lenA.",
      forward: "판단 시점=p4 피벗이 확정된 봉=p4 봉 이후 처음으로 (high-p4)/p4≥R 이 된 봉(하락은 거울). 그 봉 종가가 출발가. 그 시점에 알 수 있는 것만으로 후보를 정한다: R1·R3·len3>len1. 목표 T_eq1=p4+(p1-p0), T_618=p4+0.618×(p3-p0). 도달=출발 이후 R% 역행이 나오기 전에 high≥T(하락은 거울). 기준선=전 구간 모든 봉에서 같은 %거리(후보별 거리의 중앙값)를 reachScan(rows,R,cap) 으로 잰 무조건 도달률(상승 후보는 up, 하락 후보는 dn — 섞이면 후보 수로 가중 평균). lift=도달률/기준선. 앞보기 상한(cap): 15m 672 · 1H 336 · 4H 180 · 1D 90봉.",
      nesting: "쌍 1D(0.05)→4H(0.03) · 4H(0.03)→1H(0.02) · 1H(0.02)→15m(0.01). 상위봉 임펄스 후보(겹침 제거본)의 3파 시간창 [t(p2),t(p3)] 안에 든 하위봉 피벗 수-1 을 스윙 수로 본다(피벗이 0~1개면 스윙 0). 2파 창 [t(p1),t(p2)] 도 같은 방식.",
      verdict: "① 15m·1H·4H·1D 중 3개 이상에서 임펄스 후보율이 대조군 p95 를 넘는다(그 봉의 두 임계 R 모두) ② w2w1·w4w3 근접률이 대조군 p95 를 넘는다(①을 넘은 봉에서, 두 임계 모두) ③ 전방 검증 lift≥1.2 이고 n≥100 인 (봉,R,목표) 조합이 하나 이상 있다. 셋 모두 충족하면 '기계적 데이터로 적용 가능', 하나라도 빠지면 '적용 불가'.",
    },
    caveats: [
      "피벗은 되돌림 임계 R 로 자른 지그재그이지 사람이 그린 파동이 아니다.",
      "수수료·체결 없음.",
      "규칙 4개는 기본 임펄스만(대각·연장·복합 조정 제외).",
      "전방 검증은 4파 확정 시점 기준이며 5파 절단·실패는 결과에 포함된다.",
      "대조군은 스윙 길이를 섞은 것이라 추세 지속성(자기상관)은 보존되지 않는다.",
      "decompose 는 너무 짧은 leg 를 조용히 버리면서 방향은 뒤집어, 반환된 극값이 같은 방향으로 연속되는 자리가 있다(15m R=1% 에서 leg 의 1.4%). 그 자리는 run 안의 실제 극값 하나로 합쳤다 — 사이에 있던 작은 반전 하나는 잃는다.",
      "임펄스 후보는 겹침을 허용해 세고(창을 한 스윙씩 밀며 전수), 조정·하위 분할·대표 사례는 시간순 greedy 로 겹침을 뺀 것만 쓴다.",
    ],
    axes: {
      tfs: TFS, rByTf: R_BY_TF,
      fib: { retrace: FIB_RETRACE, ext: FIB_EXT, w5: FIB_W5 },
      tol: { retrace: TOL_RETRACE, ext: TOL_EXT },
      shuffles: SHUFFLES, seed: SEED,
    },
    fetch: fetchReport,
    tfs,
  };

  if (!existsSync(OUTDIR)) mkdirSync(OUTDIR, { recursive: true });
  const out = join(OUTDIR, "2026-08-26-elliott.json");
  const body = JSON.stringify(data);
  writeFileSync(out, body);
  const mb = Buffer.byteLength(body) / 1024 / 1024;
  console.log(`\n→ ${out} (${mb.toFixed(2)}MB) · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (mb > 6) console.error(`⚠ JSON 이 상한 6MB 를 넘었습니다(${mb.toFixed(2)}MB) — 줄이지 않고 보고합니다.`);
}

const cmd = process.argv[2];
if (cmd === "run") cmdRun();
else console.log("사용: node --max-old-space-size=8192 scripts/backtest/elliott.mjs run");
