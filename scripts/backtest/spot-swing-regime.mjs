/**
 * SPOT-SWING-REGIME 회차 — REQ-0024 거래 원장을 시장 추세 국면으로 재분석 (REQ-0027 spike).
 *
 * REQ-0024 는 달력 연도(전체·2025·2026)로 게이트를 걸었다. 이번 회차는 같은 원장
 * (재시뮬 없음 — 동일 비용·쿨다운·보유기간·유니버스)을 시장 추세 국면으로 다시 자른다.
 *
 * 사전 등록(실행 전 고정 — .backlog REQ-0027 와 동일):
 *   · 주 렌즈: KRW-BTC 1D 종가 vs SMA200, 히스테리시스 ±3% 2국면
 *     (밴드 밖 이탈 시에만 전환 — 추세 개관에서 에피소드 12개로 가장 안정해 채택)
 *   · 보조 렌즈: 유니버스 226종 동일가중 지수, 동일 규칙 (SMA200 유효 전 신호는 미판정)
 *   · 국면 판정 시점: 신호 판정봉(t)의 확정 국면 — 미래 참조 없음
 *   · 국면 게이트: 전체 n≥150 & 전체·상승·하락 각각 avg>0 → 국면 강건
 *   · 사후 진단: 국면 내 상위 3개 발화일 제외 평균 (REQ-0024 동일 방식)
 *
 * 사용: node scripts/backtest/spot-swing-regime.mjs
 * 입력: .cache/spot/spot-swing-results.json (REQ-0024 원장 6,569건)
 *       .cache/spot/regime-KRW-BTC-1D-long.json (BTC 1D 2021-01-01~, SMA200 워밍업용 별도 수집)
 *       .cache/spot/upbit-KRW-*-1D.json (동일가중 지수 구성용, REQ-0023 수집분)
 * 출력: .cache/spot/spot-swing-regime-results.json
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), ".cache", "spot");
const DAY = 86_400_000;
const T0 = Date.UTC(2023, 0, 1);
const BAND = 0.03;
const MIN_N = 150;
const MIN_BARS = 200;
const HOLDS = ["d3", "d7", "d14", "d28"];
const SIGS = ["wkdrop", "rsid", "bbret", "madist", "pbd", "dbrk"];
const iso = (t) => new Date(t).toISOString().slice(0, 10);

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

/** SMA200 대비 ±BAND 히스테리시스. initBySign: 첫 유효일 부호로 초기화(지수용). */
function hysteresis(vals, s200, initBySign) {
  const out = new Array(vals.length).fill(null);
  let cur = initBySign ? null : "상승";
  for (let i = 0; i < vals.length; i += 1) {
    if (s200[i] === null) {
      out[i] = cur;
      continue;
    }
    const d = vals[i] / s200[i] - 1;
    if (cur === null) cur = d >= 0 ? "상승" : "하락";
    if (d > BAND) cur = "상승";
    else if (d < -BAND) cur = "하락";
    out[i] = cur;
  }
  return out;
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

/** 발화일(판정봉) 단위 기여 상위 3일 제외 평균(%) — 엣지의 사건 집중도 진단. */
function top3ExAvg(list, ek) {
  const byDay = new Map();
  for (const tr of list) {
    const r = tr.exits[ek];
    if (r === undefined) continue;
    if (!byDay.has(tr.t)) byDay.set(tr.t, []);
    byDay.get(tr.t).push(r);
  }
  const days = [...byDay.entries()].map(([t, rs]) => ({ t, sum: rs.reduce((a, b) => a + b, 0), rs }));
  if (days.length <= 3) return null;
  days.sort((a, b) => b.sum - a.sum);
  const rest = days.slice(3).flatMap((d) => d.rs);
  return +((rest.reduce((a, b) => a + b, 0) / rest.length) * 100).toFixed(3);
}

// ── 주 렌즈: BTC ──────────────────────────────────────────────────────────
const btc = JSON.parse(readFileSync(join(CACHE_DIR, "regime-KRW-BTC-1D-long.json"), "utf8"));
const bc = btc.map((r) => r[4]);
const bs200 = smaSeries(bc, 200);
const bReg = hysteresis(bc, bs200, false);
const bIdx = new Map(btc.map((r, i) => [r[0], i]));

// ── 보조 렌즈: 동일가중 지수 ─────────────────────────────────────────────
const files = readdirSync(CACHE_DIR).filter((f) => /^upbit-KRW-.+-1D\.json$/.test(f));
const retByT = new Map();
let usedMkts = 0;
for (const f of files) {
  const rows = JSON.parse(readFileSync(join(CACHE_DIR, f), "utf8"));
  if (rows.length < MIN_BARS) continue;
  usedMkts += 1;
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i][0] - rows[i - 1][0] !== DAY) continue;
    const t = rows[i][0];
    if (!retByT.has(t)) retByT.set(t, []);
    retByT.get(t).push(rows[i][4] / rows[i - 1][4] - 1);
  }
}
const ewTs = [...retByT.keys()].sort((a, b) => a - b);
const ewVal = [];
{
  let acc = 1;
  for (const t of ewTs) {
    const rs = retByT.get(t);
    acc *= 1 + rs.reduce((a, b) => a + b, 0) / rs.length;
    ewVal.push(acc);
  }
}
const ewS200 = smaSeries(ewVal, 200);
const ewReg = hysteresis(ewVal, ewS200, true);
const ewIdx = new Map(ewTs.map((t, i) => [t, i]));
const ewValidFrom = ewTs[ewS200.findIndex((x) => x !== null)];

const regB = (t) => {
  const i = bIdx.get(t);
  return i === undefined ? null : bReg[i];
};
const regE = (t) => {
  const i = ewIdx.get(t);
  if (i === undefined || ewS200[i] === null) return null;
  return ewReg[i];
};

// ── 원장 재분류 ───────────────────────────────────────────────────────────
const prev = JSON.parse(readFileSync(join(CACHE_DIR, "spot-swing-results.json"), "utf8"));
const trades = prev.trades;

const bySig = {};
const verdict = {};
for (const sig of SIGS) {
  const mine = trades.filter((t) => t.sig === sig);
  bySig[sig] = { total: mine.length, holds: {} };
  for (const ek of HOLDS) {
    const rets = (f) => mine.filter(f).map((t) => t.exits[ek]).filter((x) => x !== undefined);
    const sub = (f) => mine.filter(f);
    bySig[sig].holds[ek] = {
      all: stats(rets(() => true)),
      btcUp: stats(rets((t) => regB(t.t) === "상승")),
      btcDown: stats(rets((t) => regB(t.t) === "하락")),
      ewUp: stats(rets((t) => regE(t.t) === "상승")),
      ewDown: stats(rets((t) => regE(t.t) === "하락")),
      ewNa: rets((t) => regE(t.t) === null).length,
      top3Ex: {
        btcUp: top3ExAvg(sub((t) => regB(t.t) === "상승"), ek),
        btcDown: top3ExAvg(sub((t) => regB(t.t) === "하락"), ek),
      },
    };
  }
  const regimeRobust = [];
  const downOnly = [];
  const upOnly = [];
  for (const ek of HOLDS) {
    const h = bySig[sig].holds[ek];
    if (!h.all || h.all.n < MIN_N || h.all.avg <= 0) continue;
    const u = h.btcUp !== null && h.btcUp.avg > 0;
    const d = h.btcDown !== null && h.btcDown.avg > 0;
    if (u && d) regimeRobust.push(ek);
    else if (d) downOnly.push(ek);
    else if (u) upOnly.push(ek);
  }
  verdict[sig] = { regimeRobust, downOnly, upOnly };
}

// ── 국면 에피소드별 분해 (평가창, 주 렌즈) ────────────────────────────────
const i0 = btc.findIndex((r) => r[0] >= T0);
const eps = [];
for (let i = i0; i < btc.length; i += 1) {
  const g = bReg[i];
  if (!eps.length || eps.at(-1).g !== g) eps.push({ g, fromI: i, toI: i });
  else eps.at(-1).toI = i;
}
const episodes = eps.map((e) => {
  const from = btc[e.fromI][0];
  const to = btc[e.toI][0];
  const perSig = {};
  for (const sig of SIGS) {
    const mine = trades.filter((t) => t.sig === sig && t.t >= from && t.t <= to);
    perSig[sig] = Object.fromEntries(
      HOLDS.map((ek) => {
        const rs = mine.map((t) => t.exits[ek]).filter((x) => x !== undefined);
        if (!rs.length) return [ek, null];
        return [ek, { n: rs.length, avg: +((rs.reduce((a, b) => a + b, 0) / rs.length) * 100).toFixed(2) }];
      }),
    );
  }
  return {
    g: e.g,
    from: iso(from),
    to: iso(to),
    days: e.toI - e.fromI + 1,
    btcRet: +((bc[e.toI] / bc[e.fromI] - 1) * 100).toFixed(1),
    perSig,
  };
});

// ── 리포트용 시계열 (평가창, 2023-01-01=1 정규화) ─────────────────────────
const ew0 = ewIdx.get(btc[i0][0]);
const chart = { t: [], btc: [], ew: [], reg: [] };
for (let i = i0; i < btc.length; i += 1) {
  const t = btc[i][0];
  chart.t.push(t);
  chart.btc.push(+(bc[i] / bc[i0]).toFixed(4));
  const ei = ewIdx.get(t);
  chart.ew.push(ei === undefined ? null : +(ewVal[ei] / ewVal[ew0]).toFixed(4));
  chart.reg.push(bReg[i] === "상승" ? 1 : 0);
}

// ── 저장·요약 ─────────────────────────────────────────────────────────────
writeFileSync(
  join(CACHE_DIR, "spot-swing-regime-results.json"),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    criteria: {
      base: "REQ-0024 원장 재분류 (재시뮬 없음)",
      primaryLens: `KRW-BTC 1D vs SMA200 히스테리시스 ±${BAND * 100}% 2국면`,
      secondaryLens: `동일가중 지수(${usedMkts}종) 동일 규칙 · 유효 ${iso(ewValidFrom)}~`,
      gate: `n>=${MIN_N} && all>0 && 상승>0 && 하락>0`,
    },
    universe: { markets: usedMkts, trades: trades.length },
    ewValidFrom: iso(ewValidFrom),
    bySig,
    verdict,
    episodes,
    chart,
  }),
);

console.log(`원장 ${trades.length}건 재분류 · 주 렌즈 에피소드 ${episodes.length}개 · 보조 렌즈 유효 ${iso(ewValidFrom)}~\n`);
for (const sig of SIGS) {
  const v = verdict[sig];
  const tag = v.regimeRobust.length
    ? `국면 강건 (${v.regimeRobust.join(", ")})`
    : v.downOnly.length
      ? `하락 전용 (${v.downOnly.join(", ")})`
      : v.upOnly.length
        ? `상승 전용 (${v.upOnly.join(", ")})`
        : "게이트 미달";
  console.log(`  ${sig.padEnd(7)} ${String(bySig[sig].total).padStart(5)}건 · ${tag}`);
  for (const ek of HOLDS) {
    const h = bySig[sig].holds[ek];
    const f = (s) => (s === null ? "   -  " : `${s.avg >= 0 ? "+" : ""}${s.avg.toFixed(2)}%(n${s.n})`);
    console.log(
      `      ${ek.padEnd(3)} 전체 ${f(h.all)} · BTC상승 ${f(h.btcUp)} · BTC하락 ${f(h.btcDown)} · EW상승 ${f(h.ewUp)} · EW하락 ${f(h.ewDown)}` +
        ` · top3제외 상승 ${h.top3Ex.btcUp ?? "-"} / 하락 ${h.top3Ex.btcDown ?? "-"}`,
    );
  }
}
console.log("\n✓ spot-swing-regime-results.json");
