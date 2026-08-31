/**
 * SPOT-SWING 회차 — 일봉 스윙 지표 후보 6종 백테스트 (REQ-0024 spike).
 *
 * 1·2차(1H 진입)와 달리 스윙 지평을 본다: 1D 확정봉 판정 → 다음날 시가 진입,
 * 3/7/14/28일 보유. 순차 검정 3회째이므로 연도별 양수 게이트를 유지한다.
 *
 * 사전 등록(실행 전 고정 — .backlog REQ-0024 와 동일):
 *   후보(전부 롱):
 *     · wkdrop: 7일 수익률 ≤ −35% + 양봉 — crash 의 스윙 버전
 *     · rsid:   1D RSI14 < 20 (극단 과매도)
 *     · bbret:  전일 종가 < BB(20,2) 하단 && 당일 종가 > 하단 (복귀)
 *     · madist: 종가/SMA20 − 1 ≤ −25% (과이격)
 *     · pbd:    종가 > SMA100 && RSI14 < 30 (상승 국면 눌림)
 *     · dbrk:   60일 신고가 + 거래량 > volMA20×2 (추세 대조군 — 1·2차 기각 계열)
 *   비용: 수수료 왕복 0.1% + 슬리피지(30일 거래대금 중앙값) T1≥10억 0.1% / T2≥1억 0.2% / T3 0.3%
 *   쿨다운 7일(종목×신호) · 평가 2023-01-01~ · OOS 분할 2025-01-01
 *   채택: 표본 ≥150(일봉 빈도 반영, 사전 명시) 그리고 전체·2025·2026 각각 양수
 *
 * 사용: node scripts/backtest/spot-swing.mjs
 * 입력: scripts/backtest/.cache/spot/upbit-<market>-1D.json (REQ-0023 수집분)
 * 출력: scripts/backtest/.cache/spot/spot-swing-results.json
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), ".cache", "spot");
const DAY = 86_400_000;
const EVAL_FROM = Date.UTC(2023, 0, 1);
const OOS_SPLIT = Date.UTC(2025, 0, 1);
const Y2026 = Date.UTC(2026, 0, 1);
const FEE_RT = 0.001;
const SLIP = [
  { minKrw: 1e9, rt: 0.001, tier: "T1" },
  { minKrw: 1e8, rt: 0.002, tier: "T2" },
  { minKrw: 0, rt: 0.003, tier: "T3" },
];
const COOLDOWN = 7;
const HOLDS = [3, 7, 14, 28];
const MIN_BARS = 200;
const MIN_N = 150;

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0;
  let l = 0;
  for (let i = 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    const up = d > 0 ? d : 0;
    const dn = d < 0 ? -d : 0;
    if (i <= period) {
      g += up / period;
      l += dn / period;
      if (i === period) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    } else {
      g = (g * (period - 1) + up) / period;
      l = (l * (period - 1) + dn) / period;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
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

function trailingMax(vals, window) {
  const out = new Array(vals.length).fill(null);
  const dq = [];
  for (let i = 0; i < vals.length; i += 1) {
    if (dq.length && dq[0] < i - window) dq.shift();
    if (dq.length && i >= window) out[i] = vals[dq[0]];
    while (dq.length && vals[dq[dq.length - 1]] <= vals[i]) dq.pop();
    dq.push(i);
  }
  return out;
}

function analyzeMarket(market, rows) {
  // rows: [t,o,h,l,c,v,turnover]
  const c = rows.map((r) => r[4]);
  const v = rows.map((r) => r[5]);
  const turn = rows.map((r) => r[6] ?? 0);
  const rsi = rsiSeries(c);
  const sma20 = smaSeries(c, 20);
  const sma100 = smaSeries(c, 100);
  const sd20 = stdevSeries(c, 20);
  const lower = c.map((_, i) => (sma20[i] === null || sd20[i] === null ? null : sma20[i] - 2 * sd20[i]));
  const volMA20 = smaSeries(v, 20);
  const high60 = trailingMax(rows.map((r) => r[2]), 60);

  const medTurn = (i) => {
    const vals = turn.slice(Math.max(0, i - 30), i).filter((x) => x > 0);
    if (vals.length < 10) return null;
    const s = [...vals].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const trades = [];
  const last = {};
  for (let i = 100; i < rows.length - 1; i += 1) {
    const t = rows[i][0];
    if (t < EVAL_FROM) continue;
    if (rows[i + 1][0] - t !== DAY) continue; // 다음날 봉 결측이면 진입가 없음
    const green = c[i] > rows[i][1];

    const fired = [];
    if (i >= 7 && c[i] / c[i - 7] - 1 <= -0.35 && green) fired.push("wkdrop");
    if (rsi[i] !== null && rsi[i] < 20) fired.push("rsid");
    if (lower[i] !== null && lower[i - 1] !== null && c[i - 1] < lower[i - 1] && c[i] > lower[i]) fired.push("bbret");
    if (sma20[i] !== null && c[i] / sma20[i] - 1 <= -0.25) fired.push("madist");
    if (sma100[i] !== null && c[i] > sma100[i] && rsi[i] !== null && rsi[i] < 30) fired.push("pbd");
    if (high60[i] !== null && c[i] > high60[i] && volMA20[i - 1] !== null && v[i] > volMA20[i - 1] * 2) fired.push("dbrk");

    for (const sig of fired) {
      if (i - (last[sig] ?? -Infinity) < COOLDOWN) continue;
      last[sig] = i;
      const entry = rows[i + 1][1];
      if (!entry || entry <= 0) continue;
      const mt = medTurn(i);
      const slip = SLIP.find((s) => (mt ?? 0) >= s.minKrw) ?? SLIP[SLIP.length - 1];
      const cost = FEE_RT + slip.rt;
      const exits = {};
      for (const N of HOLDS) {
        const j = i + 1 + N;
        if (j < rows.length) exits[`d${N}`] = rows[j][1] / entry - 1 - cost;
      }
      trades.push({ market, sig, t, tier: slip.tier, exits });
    }
  }
  return trades;
}

function stats(rets) {
  if (!rets.length) return null;
  const n = rets.length;
  const wins = rets.filter((r) => r > 0);
  const sum = rets.reduce((a, b) => a + b, 0);
  const grossL = -rets.filter((r) => r <= 0).reduce((a, b) => a + b, 0);
  const sorted = [...rets].sort((a, b) => a - b);
  return {
    n,
    winRate: +((wins.length / n) * 100).toFixed(1),
    avg: +((sum / n) * 100).toFixed(3),
    median: +(sorted[Math.floor(n / 2)] * 100).toFixed(3),
    pf: grossL === 0 ? null : +(wins.reduce((a, b) => a + b, 0) / grossL).toFixed(2),
    worst: +(sorted[0] * 100).toFixed(1),
    best: +(sorted[n - 1] * 100).toFixed(1),
  };
}

function main() {
  const files = readdirSync(CACHE_DIR).filter((f) => f.startsWith("upbit-KRW-") && f.endsWith("-1D.json"));
  const all = [];
  let used = 0;
  for (const f of files) {
    const rows = JSON.parse(readFileSync(join(CACHE_DIR, f), "utf8"));
    if (rows.length < MIN_BARS) continue;
    used += 1;
    all.push(...analyzeMarket(f.slice(6, -8), rows));
  }
  console.log(`대상 ${used}종 (1D<${MIN_BARS} 제외 ${files.length - used}) · 발화 ${all.length}건\n`);

  const sigs = ["wkdrop", "rsid", "bbret", "madist", "pbd", "dbrk"];
  const holds = HOLDS.map((n) => `d${n}`);
  const summary = {};
  const verdict = {};
  for (const sig of sigs) {
    const mine = all.filter((t) => t.sig === sig);
    summary[sig] = { total: mine.length, exits: {}, tiers: {} };
    for (const ek of holds) {
      const rets = (f) => mine.filter(f).map((t) => t.exits[ek]).filter((x) => x !== undefined);
      summary[sig].exits[ek] = {
        all: stats(rets(() => true)),
        train: stats(rets((t) => t.t < OOS_SPLIT)),
        valid: stats(rets((t) => t.t >= OOS_SPLIT)),
        y2025: stats(rets((t) => t.t >= OOS_SPLIT && t.t < Y2026)),
        y2026: stats(rets((t) => t.t >= Y2026)),
      };
    }
    for (const s of SLIP) {
      summary[sig].tiers[s.tier] = Object.fromEntries(
        holds.map((ek) => [ek, stats(mine.filter((t) => t.tier === s.tier).map((t) => t.exits[ek]).filter((x) => x !== undefined))]),
      );
    }
    const passing = holds.filter((ek) => {
      const e = summary[sig].exits[ek];
      return e.all && e.all.n >= MIN_N && e.all.avg > 0 && e.y2025 && e.y2025.avg > 0 && e.y2026 && e.y2026.avg > 0;
    });
    verdict[sig] = { adopted: passing.length > 0, passingExits: passing };
  }

  writeFileSync(
    join(CACHE_DIR, "spot-swing-results.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      criteria: { evalFrom: EVAL_FROM, oosSplit: OOS_SPLIT, feeRt: FEE_RT, slip: SLIP, cooldown: COOLDOWN, holds: HOLDS, adopt: `n>=${MIN_N} && all>0 && y2025>0 && y2026>0` },
      universe: { analyzed: used },
      totalSignals: all.length,
      summary,
      verdict,
      trades: all,
    }),
  );
  for (const sig of sigs) {
    const v = verdict[sig];
    console.log(`  ${sig.padEnd(7)} ${String(summary[sig].total).padStart(6)}건 · ${v.adopted ? `통과 후보 (${v.passingExits.join(", ")})` : "기각"}`);
  }
  console.log("\n✓ spot-swing-results.json");
}

main();
