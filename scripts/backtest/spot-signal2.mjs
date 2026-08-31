/**
 * SPOT-SIGNAL 회차 P4 — 2차 신호 4종 백테스트 (REQ-0023 Phase A2).
 *
 * 1차(spot-signal.mjs)는 추세추종 롱 4종 전부 기각 — 학습(23~24) 양수가 검증(25~)에서
 * 전부 음수로 뒤집혔다. 2차는 다른 유형의 가설을 검증한다. 순차 검정이므로(1차 결과를
 * 보고 고른 가설) 채택 기준을 연도 단위로 강화한다.
 *
 * 판정 기준(사전 등록 — 실행 전 고정):
 *   신호(전부 롱, 확정봉 기준, 진입 = 다음 1H봉 시가):
 *     · mr1d:  어제(확정 1D) RSI14 < 25 · 1H RSI 상승 전환 · 양봉 — 과매도 심화 반전
 *     · crash: 72봉(3일) 수익률 ≤ −25% · 양봉 · 거래량 > volMA20×1.5 — 급락 후 수요 확인
 *     · rs:    코인/BTC 비율이 480봉(20일) 신고가 · 양봉 — BTC 대비 상대강도 리더
 *     · volx:  1H 거래대금 > 직전 168봉 중앙값 × 8 · 양봉 — 거래대금 급증 감지
 *   평가·비용·쿨다운·OOS: 1차와 동일 (수수료 0.1% + 슬리피지 3계층, 쿨다운 24봉,
 *     hold 24/72/168 + ATR 1.5/3.0, 평가 2023-01-01~, 분할 2025-01-01)
 *   채택(강화): 표본 ≥300 그리고 전체 순기대값>0 그리고 2025년>0 그리고 2026년>0
 *   1차와 마찬가지로 기준 미달이면 기각 — 사후 완화 없음
 *
 * 사용: node scripts/backtest/spot-signal2.mjs
 * 입력: scripts/backtest/.cache/spot/  (1차 수집 캐시 재사용)
 * 출력: scripts/backtest/.cache/spot/spot-signal2-results.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), ".cache", "spot");
const H1 = 3600_000;
const DAY = 86_400_000;
const EVAL_FROM = Date.UTC(2023, 0, 1);
const OOS_SPLIT = Date.UTC(2025, 0, 1);
const Y2026 = Date.UTC(2026, 0, 1);
const FEE_RT = 0.001;
const SLIP = [
  { minKrw: 1e9, rt: 0.001, tier: "T1(≥10억)" },
  { minKrw: 1e8, rt: 0.002, tier: "T2(1억~10억)" },
  { minKrw: 0, rt: 0.003, tier: "T3(<1억)" },
];
const COOLDOWN = 24;
const HOLDS = [24, 72, 168];
const ATR_STOP = 1.5;
const ATR_TARGET = 3.0;
const ATR_HORIZON = 168;
const MIN_1H_BARS = 1000;

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let avgG = 0;
  let avgL = 0;
  for (let i = 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    if (i <= period) {
      avgG += g / period;
      avgL += l / period;
      if (i === period) out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    } else {
      avgG = (avgG * (period - 1) + g) / period;
      avgL = (avgL * (period - 1) + l) / period;
      out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
  }
  return out;
}

function smaSeries(vals, period) {
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i += 1) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function atrSeries(rows, period = 14) {
  const out = new Array(rows.length).fill(null);
  let atr = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const tr = Math.max(rows[i][2] - rows[i][3], Math.abs(rows[i][2] - rows[i - 1][4]), Math.abs(rows[i][3] - rows[i - 1][4]));
    if (i <= period) {
      atr += tr / period;
      if (i === period) out[i] = atr;
    } else {
      atr = (atr * (period - 1) + tr) / period;
      out[i] = atr;
    }
  }
  return out;
}

/** 직전 window 개의 슬라이딩 중앙값 (정렬 창 유지, O(n·w) 이동). 값 부족하면 null. */
function trailingMedian(vals, window) {
  const out = new Array(vals.length).fill(null);
  const sorted = [];
  const insert = (v) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    sorted.splice(lo, 0, v);
  };
  const remove = (v) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    sorted.splice(lo, 1);
  };
  for (let i = 0; i < vals.length; i += 1) {
    if (i >= window) {
      out[i] = sorted[window >> 1];
      remove(vals[i - window]);
    }
    insert(vals[i]);
  }
  // out[i] 는 [i-window, i-1] 창의 중앙값이 되도록 한 칸 늦게 읽는다
  const shifted = new Array(vals.length).fill(null);
  for (let i = window; i < vals.length; i += 1) shifted[i] = out[i];
  return shifted;
}

/** 직전 window 봉 최고값(현재 제외) — 단조 감소 덱, O(n). */
function trailingMax(vals, window) {
  const out = new Array(vals.length).fill(null);
  const deque = []; // [index]
  for (let i = 0; i < vals.length; i += 1) {
    if (deque.length && deque[0] < i - window) deque.shift();
    if (deque.length && i >= window) out[i] = vals[deque[0]];
    while (deque.length && vals[deque[deque.length - 1]] <= vals[i]) deque.pop();
    deque.push(i);
  }
  return out;
}

function analyzeMarket(market, h1, d1, btcCloseByT) {
  const c1 = h1.map((r) => r[4]);
  const v1 = h1.map((r) => r[5]);
  const rsi1 = rsiSeries(c1);
  const volMA20 = smaSeries(v1, 20);
  const atr1 = atrSeries(h1);
  const turn = h1.map((r) => r[4] * r[5]);
  const turnMed168 = trailingMedian(turn, 168);

  // 코인/BTC 비율 (시각 정합 — BTC 봉이 없으면 null)
  const ratio = h1.map((r) => {
    const b = btcCloseByT.get(r[0]);
    return b ? r[4] / b : null;
  });
  const ratioForMax = ratio.map((x) => (x === null ? -Infinity : x));
  const ratioMax480 = trailingMax(ratioForMax, 480);

  // 어제 확정 1D RSI — 날짜 인덱스
  const dayCloses = d1.map((r) => r[4]);
  const dayRsi = rsiSeries(dayCloses);
  const rsiByDay = new Map(d1.map((r, i) => [Math.floor(r[0] / DAY), dayRsi[i]]));
  const yesterdayRsi = (t) => rsiByDay.get(Math.floor(t / DAY) - 1) ?? null;

  const dayTurn = new Map(d1.map((r) => [Math.floor(r[0] / DAY), r[6] ?? 0]));
  const medTurnover = (t) => {
    const d0 = Math.floor(t / DAY);
    const vals = [];
    for (let k = 1; k <= 30; k += 1) {
      const v = dayTurn.get(d0 - k);
      if (v !== undefined) vals.push(v);
    }
    if (vals.length < 10) return null;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  };

  const trades = [];
  const lastFired = { mr1d: -Infinity, crash: -Infinity, rs: -Infinity, volx: -Infinity };

  for (let i = 80; i < h1.length - 1; i += 1) {
    const t = h1[i][0];
    if (t < EVAL_FROM) continue;
    if (h1[i + 1][0] - t !== H1) continue;
    const green = c1[i] > h1[i][1];

    const fired = [];
    const yRsi = yesterdayRsi(t);
    if (yRsi !== null && yRsi < 25 && rsi1[i] !== null && rsi1[i - 1] !== null && rsi1[i] > rsi1[i - 1] && green) fired.push("mr1d");
    if (i >= 72 && c1[i] / c1[i - 72] - 1 <= -0.25 && green && volMA20[i - 1] !== null && v1[i] > volMA20[i - 1] * 1.5) fired.push("crash");
    if (ratio[i] !== null && ratioMax480[i] !== null && ratioMax480[i] !== -Infinity && ratio[i] > ratioMax480[i] && green) fired.push("rs");
    if (turnMed168[i] !== null && turnMed168[i] > 0 && turn[i] > turnMed168[i] * 8 && green) fired.push("volx");

    for (const sig of fired) {
      if (i - lastFired[sig] < COOLDOWN) continue;
      lastFired[sig] = i;
      const entry = h1[i + 1][1];
      if (!entry || entry <= 0) continue;
      const mt = medTurnover(t);
      const slip = SLIP.find((s) => (mt ?? 0) >= s.minKrw) ?? SLIP[SLIP.length - 1];
      const cost = FEE_RT + slip.rt;

      const exits = {};
      for (const N of HOLDS) {
        const j = i + 1 + N;
        if (j < h1.length) exits[`hold${N}`] = h1[j][1] / entry - 1 - cost;
      }
      if (atr1[i] !== null) {
        const stop = entry - ATR_STOP * atr1[i];
        const target = entry + ATR_TARGET * atr1[i];
        let ret = null;
        for (let j = i + 1; j <= Math.min(i + ATR_HORIZON, h1.length - 1); j += 1) {
          if (h1[j][3] <= stop) { ret = stop / entry - 1 - cost; break; }
          if (h1[j][2] >= target) { ret = target / entry - 1 - cost; break; }
        }
        if (ret === null && i + ATR_HORIZON < h1.length) ret = h1[i + ATR_HORIZON][1] / entry - 1 - cost;
        if (ret !== null) exits.atr = ret;
      }
      trades.push({ market, sig, t, entry, tier: slip.tier, exits });
    }
  }
  return trades;
}

function stats(rets) {
  if (!rets.length) return null;
  const n = rets.length;
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r <= 0);
  const sum = rets.reduce((a, b) => a + b, 0);
  const grossW = wins.reduce((a, b) => a + b, 0);
  const grossL = -losses.reduce((a, b) => a + b, 0);
  const sorted = [...rets].sort((a, b) => a - b);
  return {
    n,
    winRate: +((wins.length / n) * 100).toFixed(1),
    avg: +((sum / n) * 100).toFixed(3),
    median: +(sorted[Math.floor(n / 2)] * 100).toFixed(3),
    pf: grossL === 0 ? null : +(grossW / grossL).toFixed(2),
    worst: +(sorted[0] * 100).toFixed(1),
    best: +(sorted[n - 1] * 100).toFixed(1),
  };
}

function main() {
  const fetchReport = JSON.parse(readFileSync(join(CACHE_DIR, "spot-fetch-report.json"), "utf8"));
  const targets = fetchReport.report.filter((r) => !r.excluded1H && r.tf["1H"].bars >= MIN_1H_BARS);
  console.log(`대상 ${targets.length}종 (2차 회차 — 캐시 재사용)\n`);

  const btc1h = JSON.parse(readFileSync(join(CACHE_DIR, "upbit-KRW-BTC-1H.json"), "utf8"));
  const btcCloseByT = new Map(btc1h.map((r) => [r[0], r[4]]));

  const all = [];
  let done = 0;
  for (const r of targets) {
    done += 1;
    const load = (tf) => JSON.parse(readFileSync(join(CACHE_DIR, `upbit-${r.market}-${tf}.json`), "utf8"));
    all.push(...analyzeMarket(r.market, load("1H"), load("1D"), btcCloseByT));
    if (done % 50 === 0 || done === targets.length) console.log(`  ${done}/${targets.length} · 누적 신호 ${all.length}`);
  }

  const sigs = ["mr1d", "crash", "rs", "volx"];
  const exitKeys = [...HOLDS.map((n) => `hold${n}`), "atr"];
  const summary = {};
  for (const sig of sigs) {
    const mine = all.filter((tr) => tr.sig === sig);
    summary[sig] = { total: mine.length, exits: {}, tiers: {} };
    for (const ek of exitKeys) {
      const rets = (f) => mine.filter(f).map((tr) => tr.exits[ek]).filter((x) => x !== undefined);
      summary[sig].exits[ek] = {
        all: stats(rets(() => true)),
        train: stats(rets((tr) => tr.t < OOS_SPLIT)),
        valid: stats(rets((tr) => tr.t >= OOS_SPLIT)),
        y2025: stats(rets((tr) => tr.t >= OOS_SPLIT && tr.t < Y2026)),
        y2026: stats(rets((tr) => tr.t >= Y2026)),
      };
    }
    for (const s of SLIP) {
      summary[sig].tiers[s.tier] = Object.fromEntries(
        exitKeys.map((ek) => [ek, stats(mine.filter((tr) => tr.tier === s.tier).map((tr) => tr.exits[ek]).filter((x) => x !== undefined))]),
      );
    }
  }

  // 채택(강화): n>=300 && 전체>0 && 2025>0 && 2026>0
  const verdict = {};
  for (const sig of sigs) {
    const passing = exitKeys.filter((ek) => {
      const e = summary[sig].exits[ek];
      return e.all && e.all.n >= 300 && e.all.avg > 0 && e.y2025 && e.y2025.avg > 0 && e.y2026 && e.y2026.avg > 0;
    });
    verdict[sig] = { adopted: passing.length > 0, passingExits: passing };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    round: 2,
    criteria: {
      evalFrom: EVAL_FROM, oosSplit: OOS_SPLIT, feeRt: FEE_RT, slip: SLIP, cooldown: COOLDOWN,
      holds: HOLDS, atr: { stop: ATR_STOP, target: ATR_TARGET, horizon: ATR_HORIZON },
      adopt: "n>=300 && all.avg>0 && y2025.avg>0 && y2026.avg>0",
    },
    universe: { analyzed: targets.length },
    totalSignals: all.length,
    summary,
    verdict,
    trades: all,
  };
  writeFileSync(join(CACHE_DIR, "spot-signal2-results.json"), JSON.stringify(out));
  console.log(`\n✓ 신호 ${all.length}건 → spot-signal2-results.json`);
  for (const sig of sigs) {
    const v = verdict[sig];
    console.log(`  ${sig.padEnd(6)} ${String(summary[sig].total).padStart(6)}건 · ${v.adopted ? `채택 후보 (${v.passingExits.join(", ")})` : "기각"}`);
  }
}

main();
