/**
 * SPOT-SIGNAL 회차 P2 — 신호 4종 백테스트 (REQ-0023 Phase A).
 *
 * 판정 기준(사전 등록 — 실행 전 고정, 기획서 .backlog/2-active/REQ-0023 와 동일):
 *   신호(전부 롱 전용, 확정봉만):
 *     · pullback: 4H 종가>SMA50 & SMA20>SMA50 / 1H 직전 RSI14<35 → RSI 반등 & 양봉
 *     · gc:       4H 종가>SMA50 / 1H SMA20 이 SMA50 상향 돌파
 *     · breakout: 4H 종가>SMA50 / 1H 종가가 직전 20봉 고가 돌파 & 거래량>volMA20×1.5
 *     · squeeze:  4H BB(20,2) 밴드폭이 직전 500봉 하위 20백분위 / 1H BB 상단 돌파 & 거래량>volMA20×1.5
 *   실행 가정: 알람은 1H 봉 마감 후 → 진입가 = 다음 1H 봉 시가
 *   비용(왕복): 수수료 0.1% + 슬리피지 — 직전 30일 일 거래대금 중앙값
 *     ≥10억 0.1% / 1억~10억 0.2% / <1억 0.3%  → 왕복 0.2 / 0.3 / 0.4%
 *   청산 두 방식 병행 평가:
 *     · hold-N: 진입 후 N봉 뒤 시가 청산 (N = 24 / 72 / 168)
 *     · atr:    손절 진입가−1.5×ATR14(1H) / 목표 진입가+3×ATR14, 같은 봉에서 둘 다 닿으면
 *               손절로 처리(보수적), 168봉 내 미체결이면 그 시점 시가 청산
 *   중복 억제: 같은 (종목, 신호) 는 발화 후 24봉(1H) 쿨다운
 *   평가 구간: 2023-01-01 이후 발화분만 (앞 3개월 워밍업)
 *   OOS: 학습 2023-01-01~2024-12-31 / 검증 2025-01-01~
 *   채택 조건(신호 유형별): 표본≥300 & 전체 순기대값>0 & 검증(2025~) 순기대값>0
 *   유동성 하한: 슬리피지 3계층별 성과 분해로 확정
 *   데이터 제외: 1H 결측>10% 종목(fetch 보고서 excluded1H), 1H 봉<1000 종목
 *
 * 사용: node scripts/backtest/spot-signal.mjs
 * 입력: scripts/backtest/.cache/spot/  (spot-signal-fetch.mjs 산출)
 * 출력: scripts/backtest/.cache/spot/spot-signal-results.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), ".cache", "spot");
const H1 = 3600_000;
const H4 = 4 * H1;
const DAY = 86_400_000;
const EVAL_FROM = Date.UTC(2023, 0, 1);
const OOS_SPLIT = Date.UTC(2025, 0, 1);
const FEE_RT = 0.001; // 0.05% × 2
const SLIP = [
  { minKrw: 1e9, rt: 0.001, tier: "T1(≥10억)" },
  { minKrw: 1e8, rt: 0.002, tier: "T2(1억~10억)" },
  { minKrw: 0, rt: 0.003, tier: "T3(<1억)" },
];
const COOLDOWN = 24; // 1H 봉
const HOLDS = [24, 72, 168];
const ATR_STOP = 1.5;
const ATR_TARGET = 3.0;
const ATR_HORIZON = 168;
const MIN_1H_BARS = 1000;

// ── 지표 (확정봉 배열 [t,o,h,l,c,v] 기준, 결과는 봉 인덱스 정렬) ──────────────

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

/** Wilder RSI — src/lib/indicators.ts 와 같은 정의(앞 period 개는 null). */
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

function stdevSeries(vals, period) {
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < vals.length; i += 1) {
    sum += vals[i];
    sq += vals[i] * vals[i];
    if (i >= period) {
      sum -= vals[i - period];
      sq -= vals[i - period] * vals[i - period];
    }
    if (i >= period - 1) {
      const m = sum / period;
      out[i] = Math.sqrt(Math.max(0, sq / period - m * m));
    }
  }
  return out;
}

/** 직전 window 개 값 중 현재 값의 백분위(0~100). 값이 부족하면 null. */
function trailingPercentile(vals, window) {
  const out = new Array(vals.length).fill(null);
  for (let i = 0; i < vals.length; i += 1) {
    if (vals[i] === null || i < window) continue;
    let below = 0;
    let total = 0;
    for (let j = i - window; j < i; j += 1) {
      if (vals[j] === null) continue;
      total += 1;
      if (vals[j] <= vals[i]) below += 1;
    }
    if (total >= window / 2) out[i] = (below / total) * 100;
  }
  return out;
}

// ── 백테스트 본체 ────────────────────────────────────────────────────────────

function analyzeMarket(market, h1, h4, d1) {
  const c1 = h1.map((r) => r[4]);
  const v1 = h1.map((r) => r[5]);
  const rsi1 = rsiSeries(c1);
  const sma20 = smaSeries(c1, 20);
  const sma50 = smaSeries(c1, 50);
  const volMA20 = smaSeries(v1, 20);
  const atr1 = atrSeries(h1);
  const sd1 = stdevSeries(c1, 20);

  const c4 = h4.map((r) => r[4]);
  const sma20h4 = smaSeries(c4, 20);
  const sma50h4 = smaSeries(c4, 50);
  const sd4 = stdevSeries(c4, 20);
  const smaBB4 = smaSeries(c4, 20);
  const bbWidth4 = c4.map((_, i) => (sd4[i] === null || smaBB4[i] === null || smaBB4[i] === 0 ? null : (4 * sd4[i]) / smaBB4[i]));
  const bbWidthPct4 = trailingPercentile(bbWidth4, 500);

  // 1H 봉 → 마감 시점에 이용 가능한 최신 확정 4H 봉 (4H 시가시각 T 는 T+4h 에 마감)
  const h4ByTime = new Map(h4.map((r, i) => [r[0], i]));
  const htfIdx = (t1) => {
    const usable = Math.floor((t1 + H1 - H4) / H4) * H4; // T ≤ t+1h−4h
    for (let k = 0; k < 8; k += 1) {
      const i = h4ByTime.get(usable - k * H4);
      if (i !== undefined) return i;
    }
    return undefined;
  };

  // 일 거래대금(30일 중앙값) — 슬리피지 계층
  const dayTurn = d1.map((r) => [Math.floor(r[0] / DAY), r[6] ?? 0]);
  const dayMap = new Map(dayTurn);
  const medTurnover = (t) => {
    const d0 = Math.floor(t / DAY);
    const vals = [];
    for (let k = 1; k <= 30; k += 1) {
      const v = dayMap.get(d0 - k);
      if (v !== undefined) vals.push(v);
    }
    if (vals.length < 10) return null;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  };

  const prevHigh20 = new Array(h1.length).fill(null); // 직전 20봉 고가 (현재 봉 제외)
  for (let i = 20; i < h1.length; i += 1) {
    let m = -Infinity;
    for (let j = i - 20; j < i; j += 1) m = Math.max(m, h1[j][2]);
    prevHigh20[i] = m;
  }

  const trades = [];
  const lastFired = { pullback: -Infinity, gc: -Infinity, breakout: -Infinity, squeeze: -Infinity };

  for (let i = 60; i < h1.length - 1; i += 1) {
    const t = h1[i][0];
    if (t < EVAL_FROM) continue;
    if (h1[i + 1][0] - t !== H1) continue; // 다음 봉 결측이면 진입가를 정의할 수 없다
    const hi = htfIdx(t);
    if (hi === undefined || sma50h4[hi] === null || sma20h4[hi] === null) continue;
    const regimeUp = c4[hi] > sma50h4[hi];
    const regimeTrend = regimeUp && sma20h4[hi] > sma50h4[hi];

    const fired = [];
    if (regimeTrend && rsi1[i - 1] !== null && rsi1[i - 1] < 35 && rsi1[i] > rsi1[i - 1] && c1[i] > h1[i][1]) fired.push("pullback");
    if (regimeUp && sma20[i - 1] !== null && sma50[i - 1] !== null && sma20[i - 1] <= sma50[i - 1] && sma20[i] > sma50[i]) fired.push("gc");
    if (regimeUp && prevHigh20[i] !== null && c1[i] > prevHigh20[i] && volMA20[i - 1] !== null && v1[i] > volMA20[i - 1] * 1.5) fired.push("breakout");
    if (
      bbWidthPct4[hi] !== null && bbWidthPct4[hi] <= 20 &&
      sma20[i] !== null && sd1[i] !== null && c1[i] > sma20[i] + 2 * sd1[i] &&
      volMA20[i - 1] !== null && v1[i] > volMA20[i - 1] * 1.5
    ) fired.push("squeeze");

    for (const sig of fired) {
      if (i - lastFired[sig] < COOLDOWN) continue;
      lastFired[sig] = i;
      const entry = h1[i + 1][1]; // 다음 봉 시가
      if (!entry || entry <= 0) continue;
      const turn = medTurnover(t);
      const slip = SLIP.find((s) => (turn ?? 0) >= s.minKrw) ?? SLIP[SLIP.length - 1];
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
          if (h1[j][3] <= stop) { ret = stop / entry - 1 - cost; break; } // 같은 봉 동시 도달 → 손절(보수)
          if (h1[j][2] >= target) { ret = target / entry - 1 - cost; break; }
        }
        if (ret === null && i + ATR_HORIZON < h1.length) ret = h1[i + ATR_HORIZON][1] / entry - 1 - cost;
        if (ret !== null) exits.atr = ret;
      }
      trades.push({ market, sig, t, entry, tier: slip.tier, turn: turn === null ? null : Math.round(turn), rsi: rsi1[i] === null ? null : +rsi1[i].toFixed(1), exits });
    }
  }
  return trades;
}

// ── 집계 ────────────────────────────────────────────────────────────────────

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
  const reportPath = join(CACHE_DIR, "spot-fetch-report.json");
  if (!existsSync(reportPath)) {
    console.error("✗ spot-fetch-report.json 이 없다 — 먼저 spot-signal-fetch.mjs");
    process.exit(1);
  }
  const fetchReport = JSON.parse(readFileSync(reportPath, "utf8"));
  const targets = fetchReport.report.filter((r) => !r.excluded1H && r.tf["1H"].bars >= MIN_1H_BARS);
  const skipped = fetchReport.report.length - targets.length;
  console.log(`대상 ${targets.length}종 (제외 ${skipped}종: 결측>10% 또는 1H<${MIN_1H_BARS}봉)\n`);

  const all = [];
  let done = 0;
  for (const r of targets) {
    done += 1;
    const load = (tf) => JSON.parse(readFileSync(join(CACHE_DIR, `upbit-${r.market}-${tf}.json`), "utf8"));
    const trades = analyzeMarket(r.market, load("1H"), load("4H"), load("1D"));
    all.push(...trades);
    if (done % 25 === 0 || done === targets.length) console.log(`  ${done}/${targets.length} · 누적 신호 ${all.length}`);
  }

  // 집계: 신호 × 청산방식 × (전체/학습/검증) + 유동성 계층
  const sigs = ["pullback", "gc", "breakout", "squeeze"];
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
      };
    }
    for (const s of SLIP) {
      summary[sig].tiers[s.tier] = Object.fromEntries(
        exitKeys.map((ek) => [ek, stats(mine.filter((tr) => tr.tier === s.tier).map((tr) => tr.exits[ek]).filter((x) => x !== undefined))]),
      );
    }
  }

  // 채택 판정(사전 등록): 표본≥300 & 전체 순기대값>0 & 검증 순기대값>0 — 청산방식 중 하나라도 충족하면 그 방식으로 채택
  const verdict = {};
  for (const sig of sigs) {
    const passing = exitKeys.filter((ek) => {
      const e = summary[sig].exits[ek];
      return e.all && e.all.n >= 300 && e.all.avg > 0 && e.valid && e.valid.avg > 0;
    });
    verdict[sig] = { adopted: passing.length > 0, passingExits: passing };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    criteria: {
      evalFrom: EVAL_FROM, oosSplit: OOS_SPLIT, feeRt: FEE_RT, slip: SLIP, cooldown: COOLDOWN,
      holds: HOLDS, atr: { stop: ATR_STOP, target: ATR_TARGET, horizon: ATR_HORIZON },
      adopt: "n>=300 && all.avg>0 && valid.avg>0",
    },
    universe: { analyzed: targets.length, skipped },
    totalSignals: all.length,
    summary,
    verdict,
    trades: all,
  };
  writeFileSync(join(CACHE_DIR, "spot-signal-results.json"), JSON.stringify(out));
  console.log(`\n✓ 신호 ${all.length}건 → spot-signal-results.json`);
  for (const sig of sigs) {
    const v = verdict[sig];
    console.log(`  ${sig.padEnd(9)} ${String(summary[sig].total).padStart(6)}건 · ${v.adopted ? `채택 후보 (${v.passingExits.join(", ")})` : "기각"}`);
  }
}

main();
