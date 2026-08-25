/**
 * 손익비 축 — 복리 위에서 R:R 을 훑는다.
 *
 * 거래 단위로 보면 손익비는 기대값의 한 성분일 뿐이다. 복리에서는 다르다:
 * 손익비를 키우면 승률이 떨어지고, 승률이 떨어지면 연패가 길어지고, 연패가 길어지면
 * 낙폭이 깊어지고, 낙폭은 복리를 이차적으로 갉는다. 그래서 **거래 단위 최적과
 * 복리 최적이 갈릴 수 있다** — 이 파일은 그 갈림을 재려고 만들었다.
 *
 * 부품의 손절폭(1R)은 그대로 두고 목표만 배수로 바꾼다. 손절을 함께 바꾸면
 * 사이징(리스크/손절폭)까지 흔들려 무엇이 기여했는지 알 수 없게 된다.
 */
import { loadAll } from "../lib/runner.mjs";
import { loadOut, saveOut } from "../lib/data.mjs";
import { blockBootstrap, tradeStats } from "../lib/stats.mjs";
import { runBook, START } from "./lib/book.mjs";
import { METHODS } from "./lib/sizing.mjs";
import { PARTS, SETS, buildPartContext, runPart } from "./lib/components.mjs";

const grid = loadOut("compound-grid.json");
const WIN = grid.windows.common;
const bench = grid.bench.common;

/** 손익비 사다리 — 마지막 둘은 목표가가 없는 러너(상방 개방). */
const RATIOS = [
  { key: "r1", name: "1 : 1", mult: 1 },
  { key: "r2", name: "1 : 2", mult: 2 },
  { key: "r3", name: "1 : 3", mult: 3 },
  { key: "r4", name: "1 : 4", mult: 4 },
  { key: "r6", name: "1 : 6", mult: 6 },
  { key: "trail3", name: "무제한 3ATR 추적", trail: 3 },
  { key: "trail5", name: "무제한 5ATR 추적", trail: 5 },
];

/** 손익비를 다시 매길 대상 — 원래 고정 기하를 쓰던 12부품. 러너 2종은 이미 무제한이라 제외. */
const BASE_KEYS = PARTS.filter((p) => p.exit).map((p) => p.key);

const { data, fundingCum } = loadAll();
const ctx = buildPartContext(data);

/** 판정 설정 — 그리드에서 복리 부문 최고였던 칸으로 고정한다. 손익비만 변수로 남긴다. */
const passers = grid.rows.filter((r) => r.pass && r.method !== "m0").sort((a, b) => b.mar - a.mar);
const anchor = passers[0];
const anchorSet = SETS.find((s) => s.key === anchor.set);
console.log(`기준 칸: ${anchor.set} · ${anchor.method} · ${anchor.levCap}배 · 리스크 ${anchor.riskPct}% (MAR ${anchor.mar})`);

const rows = [];
const curves = {};
for (const R of RATIOS) {
  const remade = {};
  const partStats = {};
  for (const key of BASE_KEYS) {
    const base = PARTS.find((p) => p.key === key);
    const variant = R.trail
      ? { ...base, exit: undefined, plan: { initSl: 1, tp: null, trail: { type: "chandelier", mult: R.trail }, trailArmR: 0, beArmR: null, partial: null, timeCut: null, pyramid: null } }
      : { ...base, exit: { ...base.exit, tp: base.exit.sl * R.mult } };
    const tr = runPart(variant, ctx, fundingCum);
    remade[key] = tr;
    const st = tradeStats(tr.map((t) => t.net));
    const w = tr.filter((t) => t.net > 0);
    const l = tr.filter((t) => t.net <= 0);
    partStats[key] = {
      n: st.n, winRate: st.winRate, ev: st.ev, pf: st.pf,
      payoff: w.length && l.length
        ? Math.round(((w.reduce((s, x) => s + x.net, 0) / w.length) / Math.abs(l.reduce((s, x) => s + x.net, 0) / l.length)) * 100) / 100
        : null,
    };
  }

  for (const setKey of ["quad", "mix9"]) {
    const set = SETS.find((s) => s.key === setKey);
    const keys = set.parts.filter((k) => remade[k]);
    const trades = keys.flatMap((k) => remade[k]);
    const r = runBook(trades, {
      method: METHODS[anchor.method], riskPct: anchor.riskPct, levCap: anchor.levCap,
      maxConcurrent: 3, heatCap: null, from: WIN.from, to: WIN.to,
    });
    const boot = r.stepReturns.length >= 60
      ? blockBootstrap(r.stepReturns, { blocks: 20, runs: 1000, start: START, ruinAt: 10, seed: 20260818 })
      : null;
    // 거래 단위 총합 — 복리를 끄면 어느 손익비가 이기는가(비교 기준).
    const flat = trades.reduce((s, t) => s + t.net, 0);
    const st = tradeStats(trades.map((t) => t.net));
    rows.push({
      ratio: R.key, ratioName: R.name, set: setKey, setName: set.name,
      partsUsed: keys.length,
      tradeN: st.n, winRate: st.winRate, evPerTrade: st.ev, pf: st.pf,
      payoff: (() => {
        const w = trades.filter((t) => t.net > 0);
        const l = trades.filter((t) => t.net <= 0);
        return w.length && l.length
          ? Math.round(((w.reduce((s, x) => s + x.net, 0) / w.length) / Math.abs(l.reduce((s, x) => s + x.net, 0) / l.length)) * 100) / 100
          : null;
      })(),
      flatTotalPct: Math.round(flat * 10) / 10,
      monthlyGeo: r.monthlyGeo, cagr: r.cagr, mdd: r.mddPessimistic, mar: r.mar,
      underwaterMaxDays: r.underwaterMaxDays, monthWinRate: r.monthWinRate,
      liquidations: r.liquidations, ruin: boot ? boot.ruinPct : null,
      trades: r.trades, finalEquity: r.finalEquity,
      maxLossStreak: (() => {
        const sorted = [...trades].sort((a, b) => a.exitAt - b.exitAt);
        let cur = 0, mx = 0;
        for (const t of sorted) { if (t.net <= 0) { cur += 1; mx = Math.max(mx, cur); } else cur = 0; }
        return mx;
      })(),
    });
    if (setKey === "mix9") curves[R.key] = r.curve;
  }
  console.log(`  ${R.name} 완료`);
}

saveOut("compound-rr.json", { generatedAt: Date.now(), anchor, ratios: RATIOS, rows, curves, baseKeys: BASE_KEYS });

for (const setKey of ["quad", "mix9"]) {
  console.log("");
  console.log(`손익비 사다리 — ${SETS.find((s) => s.key === setKey).name} (${anchor.method} · ${anchor.levCap}배 · 리스크 ${anchor.riskPct}%)`);
  console.table(rows.filter((r) => r.set === setKey).map((r) => ({
    손익비: r.ratioName, 거래: r.tradeN, "승률%": r.winRate, 페이오프: r.payoff,
    "거래당 EV%": r.evPerTrade, "무복리 합%": r.flatTotalPct,
    "월 기하%": r.monthlyGeo, "낙폭%": r.mdd, MAR: r.mar,
    "최장 연패": r.maxLossStreak, "최장 수중일": r.underwaterMaxDays, "파산%": r.ruin,
  })));
}
