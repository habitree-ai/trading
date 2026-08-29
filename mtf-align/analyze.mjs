/**
 * MTF 정렬 분석 — 1m·15m·1H·4H 네 봉이 동시에 같은 방향일 때 TA 스냅샷.
 *
 * 사용: node --max-old-space-size=8192 mtf-align/analyze.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { C, T, decompose } from "../scripts/backtest/lib/oneway-core.mjs";
import { WARMUP, computeTa } from "../scripts/backtest/lib/oneway-ta.mjs";
import { computeDirection, mapDirection, htfIndexMap } from "./lib/direction.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "scripts", "backtest", ".cache");
const OUTDIR = join(dirname(fileURLToPath(import.meta.url)), "out");

const SCAN_TF = "1m";
const TF_KEYS = ["1m", "15m", "1H", "4H"];
const TF_MS = {
  "15m": 15 * 60_000,
  "1H": 3600_000,
  "4H": 4 * 3600_000,
};

const KST = (t) => new Date(t + 9 * 3600_000);
const iso = (t) => KST(t).toISOString().replace("T", " ").slice(0, 16);
const r2 = (v) => Math.round(v * 100) / 100;
const q = (arr, p) => {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

function load(tf) {
  const p = join(CACHE, `oneway-${tf}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function snapTa(ta, i, close) {
  return {
    close: r2(close),
    rsi: r2(ta.rsi[i]),
    bbPb: r2(ta.bbPb[i]),
    bbWPct: r2(ta.bbWPct[i] * 100),
    atrPct: r2(ta.atrPct[i]),
    atrPctile: r2(ta.atrPctile[i] * 100),
    distE200: r2(ta.distE200[i]),
    stack: ta.stack[i],
    body: r2(ta.body[i]),
    volR: r2(ta.volR[i]),
    dcPos: r2(ta.dcPos[i] * 100),
    e20: r2(ta.e20[i]),
    e50: r2(ta.e50[i]),
    e200: r2(ta.e200[i]),
  };
}

const CONDITIONS = [
  { key: "bbw-squeeze", group: "변동성", name: "밴드폭 수축 (하위 20%)", test: (ta, i) => ta.bbWPct[i] <= 0.2 },
  { key: "bbw-expand", group: "변동성", name: "밴드폭 확장 (상위 20%)", test: (ta, i) => ta.bbWPct[i] >= 0.8 },
  { key: "atr-quiet", group: "변동성", name: "ATR 하위 20%", test: (ta, i) => ta.atrPctile[i] <= 0.2 },
  { key: "atr-loud", group: "변동성", name: "ATR 상위 20%", test: (ta, i) => ta.atrPctile[i] >= 0.8 },
  { key: "rsi-os", group: "모멘텀", name: "RSI ≤ 30", test: (ta, i) => ta.rsi[i] <= 30 },
  { key: "rsi-ob", group: "모멘텀", name: "RSI ≥ 70", test: (ta, i) => ta.rsi[i] >= 70 },
  { key: "rsi-mid", group: "모멘텀", name: "RSI 45~55", test: (ta, i) => ta.rsi[i] >= 45 && ta.rsi[i] <= 55 },
  { key: "bb-upper", group: "위치", name: "볼린저 상단 (%b≥1)", test: (ta, i) => ta.bbPb[i] >= 1 },
  { key: "bb-lower", group: "위치", name: "볼린저 하단 (%b≤0)", test: (ta, i) => ta.bbPb[i] <= 0 },
  { key: "dc-high", group: "위치", name: "채널 상단 (상위 5%)", test: (ta, i) => ta.dcPos[i] >= 0.95 },
  { key: "dc-low", group: "위치", name: "채널 하단 (하위 5%)", test: (ta, i) => ta.dcPos[i] <= 0.05 },
  { key: "ma-up", group: "추세", name: "이평 정배열", test: (ta, i) => ta.stack[i] === 1 },
  { key: "ma-dn", group: "추세", name: "이평 역배열", test: (ta, i) => ta.stack[i] === -1 },
  { key: "vol-burst", group: "거래량", name: "거래량 2배+", test: (ta, i) => ta.volR[i] >= 2 },
  { key: "vol-dry", group: "거래량", name: "거래량 0.5배-", test: (ta, i) => ta.volR[i] <= 0.5 },
  { key: "sqz-vol", group: "복합", name: "밴드 수축+거래량 2배", test: (ta, i) => ta.bbWPct[i] <= 0.2 && ta.volR[i] >= 2 },
];

const IDX_KEY = { "1m": "i1m", "15m": "i15m", "1H": "i1H", "4H": "i4H" };

function profileEvents(events, taByTf) {
  const byDir = { up: events.filter((e) => e.dir === 1), dn: events.filter((e) => e.dir === -1) };
  const metrics = ["rsi", "bbPb", "bbWPct", "atrPctile", "distE200", "volR", "dcPos", "body"];
  const profiles = {};

  for (const [dirKey, list] of Object.entries(byDir)) {
    profiles[dirKey] = {};
    for (const tf of TF_KEYS) {
      const ta = taByTf[tf];
      const idxKey = IDX_KEY[tf];
      const vals = {};
      for (const m of metrics) {
        const arr = list.map((ev) => {
          const i = ev[idxKey];
          if (m === "bbWPct" || m === "atrPctile" || m === "dcPos") return ta[m][i] * 100;
          return ta[m][i];
        });
        vals[m] = { mean: r2(mean(arr)), p25: r2(q(arr, 0.25)), p50: r2(q(arr, 0.5)), p75: r2(q(arr, 0.75)) };
      }
      const stacks = list.map((ev) => ta.stack[ev[idxKey]]);
      vals.stack = {
        bull: stacks.filter((s) => s === 1).length,
        bear: stacks.filter((s) => s === -1).length,
        mix: stacks.filter((s) => s === 0).length,
        total: stacks.length,
      };
      profiles[dirKey][tf] = vals;
    }
  }
  return profiles;
}

function conditionFreq(events, ta1m) {
  const n = events.length;
  return CONDITIONS.map((c) => {
    let hit = 0;
    for (const ev of events) if (c.test(ta1m, ev.i1m)) hit += 1;
    return { key: c.key, group: c.group, name: c.name, count: hit, pct: r2(n ? (hit / n) * 100 : 0) };
  }).sort((a, b) => b.pct - a.pct);
}

function forwardMove(rows1m, startI, dir, horizons) {
  const p0 = rows1m[startI][C];
  const out = {};
  for (const [label, bars] of horizons) {
    const j = Math.min(startI + bars, rows1m.length - 1);
    const p1 = rows1m[j][C];
    out[label] = r2(((p1 - p0) / p0) * 100 * (dir === 1 ? 1 : -1));
  }
  return out;
}

function alignedAt(i, dir1m, d15, dH, d4) {
  const d1 = dir1m[i];
  return d1 !== 0 && d1 === d15[i] && d15[i] === dH[i] && dH[i] === d4[i] ? d1 : 0;
}

function main() {
  const data = {};
  for (const tf of TF_KEYS) {
    data[tf] = load(tf);
    if (!data[tf]) {
      console.error(`캐시 없음: oneway-${tf}.json — node scripts/backtest/oneway-fetch.mjs 1m 15m 1H 4H`);
      process.exit(1);
    }
  }

  let from = 0;
  let to = Infinity;
  for (const tf of TF_KEYS) {
    if (data[tf][0][T] > from) from = data[tf][0][T];
    const end = data[tf][data[tf].length - 1][T];
    if (end < to) to = end;
  }

  const rows1m = data["1m"].filter((r) => r[T] >= from && r[T] <= to);
  const rows15 = data["15m"].filter((r) => r[T] >= from && r[T] <= to);
  const rows1H = data["1H"].filter((r) => r[T] >= from && r[T] <= to);
  const rows4H = data["4H"].filter((r) => r[T] >= from && r[T] <= to);

  console.log(`공통 구간: ${iso(from).slice(0, 10)} → ${iso(to).slice(0, 10)}`);
  console.log(`  1m ${rows1m.length.toLocaleString()} · 15m ${rows15.length.toLocaleString()} · 1H ${rows1H.length.toLocaleString()} · 4H ${rows4H.length.toLocaleString()}`);

  const dir1m = computeDirection(rows1m);
  const dir15 = computeDirection(rows15);
  const dir1H = computeDirection(rows1H);
  const dir4H = computeDirection(rows4H);

  const d15on1m = mapDirection(rows1m, rows15, dir15, TF_MS["15m"]);
  const d1Hon1m = mapDirection(rows1m, rows1H, dir1H, TF_MS["1H"]);
  const d4Hon1m = mapDirection(rows1m, rows4H, dir4H, TF_MS["4H"]);

  const map15 = htfIndexMap(rows1m, rows15, TF_MS["15m"]);
  const map1H = htfIndexMap(rows1m, rows1H, TF_MS["1H"]);
  const map4H = htfIndexMap(rows1m, rows4H, TF_MS["4H"]);

  console.log("\nTA 계산 중...");
  const ta1m = computeTa(rows1m, {});
  const ta15 = computeTa(rows15, {});
  const ta1H = computeTa(rows1H, {});
  const ta4H = computeTa(rows4H, {});

  const events = [];
  let prevAligned = 0;
  let episodeDir = 0;
  let episodeStartI = 0;
  const durations = { up: [], dn: [] };

  for (let i = WARMUP; i < rows1m.length; i += 1) {
    const aligned = alignedAt(i, dir1m, d15on1m, d1Hon1m, d4Hon1m);

    if (aligned !== 0 && prevAligned !== aligned) {
      if (episodeDir !== 0) {
        const dur = i - episodeStartI;
        (episodeDir === 1 ? durations.up : durations.dn).push(dur);
      }
      episodeDir = aligned;
      episodeStartI = i;

      events.push({
        t: rows1m[i][T],
        kst: iso(rows1m[i][T]),
        dir: aligned,
        price: r2(rows1m[i][C]),
        i1m: i,
        i15m: map15[i],
        i1H: map1H[i],
        i4H: map4H[i],
        tf: {
          "1m": snapTa(ta1m, i, rows1m[i][C]),
          "15m": map15[i] >= 0 ? snapTa(ta15, map15[i], rows15[map15[i]][C]) : null,
          "1H": map1H[i] >= 0 ? snapTa(ta1H, map1H[i], rows1H[map1H[i]][C]) : null,
          "4H": map4H[i] >= 0 ? snapTa(ta4H, map4H[i], rows4H[map4H[i]][C]) : null,
        },
        forward: forwardMove(rows1m, i, aligned, [
          ["15m", 15], ["1H", 60], ["4H", 240], ["8H", 480],
        ]),
      });
    } else if (aligned === 0 && prevAligned !== 0) {
      const dur = i - episodeStartI;
      (prevAligned === 1 ? durations.up : durations.dn).push(dur);
      episodeDir = 0;
    }

    prevAligned = aligned !== 0 ? aligned : 0;
  }

  const upEvents = events.filter((e) => e.dir === 1);
  const dnEvents = events.filter((e) => e.dir === -1);
  const spanDays = (to - from) / 86_400_000;
  const spanYears = spanDays / 365.25;

  let alignedBars = 0, bullBars = 0, bearBars = 0;
  for (let i = WARMUP; i < rows1m.length; i += 1) {
    const a = alignedAt(i, dir1m, d15on1m, d1Hon1m, d4Hon1m);
    if (a !== 0) {
      alignedBars += 1;
      if (a === 1) bullBars += 1; else bearBars += 1;
    }
  }
  const totalBars = rows1m.length - WARMUP;

  const taByTf = { "1m": ta1m, "15m": ta15, "1H": ta1H, "4H": ta4H };
  const profiles = profileEvents(events, taByTf);

  const fwdHorizons = ["15m", "1H", "4H", "8H"];
  const fwdSummary = {};
  for (const [dirKey, list] of [["up", upEvents], ["dn", dnEvents]]) {
    fwdSummary[dirKey] = {};
    for (const h of fwdHorizons) {
      const arr = list.map((e) => e.forward[h]);
      fwdSummary[dirKey][h] = {
        mean: r2(mean(arr)),
        p50: r2(q(arr, 0.5)),
        p75: r2(q(arr, 0.75)),
        winPct: r2(arr.length ? (arr.filter((v) => v > 0).length / arr.length) * 100 : 0),
      };
    }
  }

  const legs = decompose(rows1m, 0.01);
  let overlapStarts = 0;
  for (const ev of events) {
    const hit = legs.some((l) => l.si === ev.i1m || (l.si <= ev.i1m && l.ei >= ev.i1m && l.dir === ev.dir));
    if (hit) overlapStarts += 1;
  }

  const result = {
    round: "mtf-align",
    name: "4봉 동방향 정렬 시작점 TA",
    generatedAt: new Date().toISOString(),
    inst: "BTC-USDT-SWAP (OKX)",
    question: "1m·15m·1H·4H 네 봉이 동시에 같은 방향으로 정렬되기 시작할 때, 각 봉의 기술적 분석은 어떤 모습인가",
    definition: {
      direction: "EMA20>EMA50 AND close>EMA20 → 상승(1), EMA20<EMA50 AND close<EMA20 → 하락(-1), 그 외 혼조(0)",
      alignment: "네 봉 모두 같은 부호(1 또는 -1). 1m 기준 스캔, 상위봉은 마감된 봉만 참조.",
      startEvent: "직전 봉에서는 4-way 정렬이 아니었고, 현재 봉에서 4-way 정렬이 성립한 순간.",
    },
    period: { from: iso(from), to: iso(to), days: r2(spanDays), years: r2(spanYears) },
    summary: {
      totalBars,
      alignedBars,
      alignedPct: r2((alignedBars / totalBars) * 100),
      bullBars,
      bearBars,
      startEvents: events.length,
      bullStarts: upEvents.length,
      bearStarts: dnEvents.length,
      startsPerYear: r2(events.length / spanYears),
      bullStartsPerYear: r2(upEvents.length / spanYears),
      bearStartsPerYear: r2(dnEvents.length / spanYears),
      medDurationMin: { up: r2(q(durations.up, 0.5)), dn: r2(q(durations.dn, 0.5)) },
      impulseOverlapPct: r2(events.length ? (overlapStarts / events.length) * 100 : 0),
    },
    forward: fwdSummary,
    profiles,
    conditions: {
      all: conditionFreq(events, ta1m),
      bull: conditionFreq(upEvents, ta1m),
      bear: conditionFreq(dnEvents, ta1m),
    },
    samples: {
      bull: upEvents.filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 20)) === 0).slice(0, 20),
      bear: dnEvents.filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 20)) === 0).slice(0, 20),
    },
    backtestContext: {
      note: "기존 oneway(2026-08-25)는 단일봉 임펄스 시작점 — 4-way 정렬은 더 엄격한 전제",
      onewayConclusion: "임펄스 빈도는 충분하나 시작점 예측 상한 +1.9%p",
      basisRound: "유일 게이트 6/6 — 베이시스 4H (CAGR 48%, MDD -35%)",
      labFrontier: "월 10% 복리 기각 — 4,464조합 게이트 0통과",
    },
  };

  if (!existsSync(OUTDIR)) mkdirSync(OUTDIR, { recursive: true });
  const outPath = join(OUTDIR, "mtf-align.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n→ ${outPath}`);
  console.log(`  4-way 정렬 ${result.summary.alignedPct}% · 시작 ${events.length.toLocaleString()} (${r2(events.length / spanYears)}/년)`);
  console.log(`  상승 ${upEvents.length.toLocaleString()} · 하락 ${dnEvents.length.toLocaleString()}`);
}

main();
