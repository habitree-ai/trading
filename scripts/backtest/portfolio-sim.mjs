/**
 * BTC 복리 운용 5방식 — 검증된 기준의 병행 운용으로 $100 누적 복리.
 *
 * "단시간 복리"의 건전한 길: 봉을 줄이는 대신(수수료 잠식 — 표본200 검토에서 확정)
 * 검증된 4H·1D 기준을 한 계좌에 병행해 거래 빈도를 올리고, 리스크%로 속도를 조절한다.
 *
 * 병행 회계: 각 거래는 진입 시점의 "실현 잔고"로 사이징하고(레버리지 자동 감축),
 * 실현손익(USD)은 청산 시점에 잔고에 더한다. 동시 포지션 수와 합산 리스크를 추적한다.
 *
 * 사용: node scripts/backtest/portfolio-sim.mjs [출력.json]
 *   → 기본 출력: docs/backtest/<KST 오늘>-portfolio-sim.json
 *   → 리포트: portfolio-sim-template.html 의 __DATA_JSON__/__DATA_PATH__ 에 JSON을 심어
 *     docs/backtest/portfolio-report.html 로 만든다.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://www.okx.com/api/v5";
const INST = "BTC-USDT-SWAP";
const DAYS = 720;
const PAGE = 100;
const FEE_PCT = 0.1;
const WARMUP = 200; // 시리즈 공통 출발선.
const START = 100;
const MAX_LEV = 10;

const TFS = {
  "4H": { ms: 4 * 3600_000, maxHold: 60 },
  "1D": { ms: 24 * 3600_000, maxHold: 20 },
};

/** 구성원 — 플레이북에서 검증된 기준·청산 그대로. */
const MEMBERS = {
  gc: { tf: "4H", signal: "golden-cross", exit: { type: "atr", sl: 1, tp: 3 }, label: "골든크로스 (4H·롱)" },
  ob: { tf: "4H", signal: "rsi-oversold-bounce", exit: { type: "atr", sl: 1, tp: 3 }, label: "RSI 과매도 반등 (4H·롱)" },
  fade: { tf: "4H", signal: "rsi-overbought-fade", exit: { type: "atr", sl: 2, tp: 4 }, label: "RSI 과매수 반락 (4H·숏)" },
  dc: { tf: "1D", signal: "donchian-breakdown", exit: { type: "pct", sl: 2, tp: 4 }, label: "20봉 신저가 이탈 (1D·숏)" },
};

/** 5방식 — 단일 → 병행 → 공격의 사다리. 전부 고정 목표·손절(가장 심플). */
const METHODS = [
  { key: "solo-trend", name: "① 솔로 추세", members: ["gc"], risk: 5, desc: "골든크로스 하나만, 거래당 리스크 5%" },
  { key: "solo-meanrev", name: "② 솔로 역추세", members: ["ob"], risk: 5, desc: "RSI 과매도 반등 하나만, 거래당 리스크 5%" },
  { key: "duo-long", name: "③ 듀오 롱 병행", members: ["gc", "ob"], risk: 5, desc: "추세+역추세 롱 두 기준을 한 계좌에 병행, 각 5%" },
  { key: "quad", name: "④ 쿼드 롱숏 병행", members: ["gc", "ob", "fade", "dc"], risk: 5, desc: "롱 2 + 숏 2를 병행 — 빈도 최대·방향 균형, 각 5%" },
  { key: "quad-aggr", name: "⑤ 쿼드 공격형", members: ["gc", "ob", "fade", "dc"], risk: 10, desc: "④와 같은 구성, 리스크만 10% — 복리 최속, 낙폭 최대" },
];

/* ---------- 데이터 수집 ---------- */

async function fetchPage(bar, after, attempt = 0) {
  const url = `${BASE}/market/history-candles?instId=${INST}&bar=${bar}&after=${after}&limit=${PAGE}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 429 && attempt < 5) {
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    return fetchPage(bar, after, attempt + 1);
  }
  if (!res.ok) throw new Error(`OKX ${res.status}`);
  const json = await res.json();
  if (json.code !== "0") throw new Error(`OKX: ${json.msg || json.code}`);
  return json.data;
}

async function fetchCandles(bar) {
  const ms = TFS[bar].ms;
  const to = Math.floor(Date.now() / ms) * ms;
  const from = to - DAYS * 24 * 3600_000;
  const span = ms * PAGE;
  const pages = Math.ceil((to - from) / span);
  const cursors = Array.from({ length: pages }, (_, i) => to - i * span);

  const out = new Map();
  for (let i = 0; i < cursors.length; i += 8) {
    const batch = await Promise.all(cursors.slice(i, i + 8).map((c) => fetchPage(bar, c)));
    for (const rows of batch) {
      for (const row of rows) {
        const t = Number(row[0]);
        if (t >= from && t < to && row[8] === "1") {
          out.set(t, {
            t,
            o: Number(row[1]),
            h: Number(row[2]),
            l: Number(row[3]),
            c: Number(row[4]),
            v: Number(row[5]),
          });
        }
      }
    }
    if (i + 8 < cursors.length) await new Promise((r) => setTimeout(r, 1600));
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/* ---------- 지표 — 시리즈 공통 ---------- */

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) gain += ch;
    else loss -= ch;
  }
  gain /= period;
  loss /= period;
  const toRsi = (g, l) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[period] = toRsi(gain, loss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const ch = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(ch, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = toRsi(gain, loss);
  }
  return out;
}

function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = (i) =>
    Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c),
    );
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr(i);
  let value = sum / period;
  out[period] = value;
  for (let i = period + 1; i < candles.length; i += 1) {
    value = (value * (period - 1) + tr(i)) / period;
    out[i] = value;
  }
  return out;
}

function volMA(candles, n = 20) {
  const out = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    if (i >= n) out[i] = sum / n;
    sum += candles[i].v;
    if (i >= n) sum -= candles[i - n].v;
  }
  return out;
}

function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function rolling(candles, n, pick, cmp) {
  const out = new Array(candles.length).fill(null);
  for (let i = n; i < candles.length; i += 1) {
    let best = pick(candles[i - n]);
    for (let k = i - n + 1; k < i; k += 1) {
      const v = pick(candles[k]);
      if (cmp(v, best)) best = v;
    }
    out[i] = best;
  }
  return out;
}

const SIGNALS = {
  "golden-cross": {
    side: "long",
    rule: "SMA20이 SMA50을 상향 돌파 마감",
    signal: (i, c) => c.sma20[i - 1] <= c.sma50[i - 1] && c.sma20[i] > c.sma50[i],
  },
  "rsi-oversold-bounce": {
    side: "long",
    rule: "RSI(14)가 30 아래로 갔다가 30 위로 복귀 마감",
    signal: (i, c) => c.rsi[i - 1] < 30 && c.rsi[i] >= 30,
  },
  "rsi-overbought-fade": {
    side: "short",
    rule: "RSI(14)가 70 위로 갔다가 70 아래로 복귀 마감",
    signal: (i, c) => c.rsi[i - 1] > 70 && c.rsi[i] <= 70,
  },
  "donchian-breakdown": {
    side: "short",
    rule: "종가가 직전 20봉 최저가 아래로 마감",
    signal: (i, c) => c.candles[i].c < c.ll20[i],
  },
};

/* ---------- 체결 — 고정 목표·손절, 갭이면 시가 체결(보수적) ---------- */

function walkExit(candles, entryIdx, entry, side, exit, atrSig, maxHold) {
  const dir = side === "long" ? 1 : -1;
  const slDist = exit.type === "atr" ? exit.sl * atrSig : entry * exit.sl / 100;
  const tpDist = exit.type === "atr" ? exit.tp * atrSig : entry * exit.tp / 100;
  const stop = entry - dir * slDist;
  const target = entry + dir * tpDist;

  let exitIdx = Math.min(entryIdx + maxHold - 1, candles.length - 1);
  let exitPrice = candles[exitIdx].c;
  let exitType = "time";
  for (let j = entryIdx; j <= exitIdx; j += 1) {
    const bar = candles[j];
    const hitSl = dir === 1 ? bar.l <= stop : bar.h >= stop;
    const hitTp = dir === 1 ? bar.h >= target : bar.l <= target;
    // 같은 봉에서 둘 다 걸리면 손절 — 봉 내부 경로를 모르니 보수적으로.
    if (hitSl) {
      exitIdx = j;
      // 시가가 손절선 너머면(갭) 손절가에 체결될 수 없다 — 시가로 체결.
      exitPrice = dir === 1 ? Math.min(stop, bar.o) : Math.max(stop, bar.o);
      exitType = "sl";
      break;
    }
    if (hitTp) {
      exitIdx = j;
      exitPrice = target;
      exitType = "tp";
      break;
    }
  }
  if (exitType === "time" && exitIdx === candles.length - 1 && exitIdx - entryIdx + 1 < maxHold) {
    exitType = "open";
  }
  const gross = ((exitPrice - entry) / entry) * dir * 100;
  return { exitIdx, exitPrice, exitType, grossPct: gross, stopDistPct: (slDist / entry) * 100 };
}

/* ---------- 구성원별 가격 기준 거래 목록 (잔고와 무관) ---------- */

function memberTrades(memberKey, dataByTf) {
  const mdef = MEMBERS[memberKey];
  const { candles, ctx } = dataByTf[mdef.tf];
  const s = SIGNALS[mdef.signal];
  const maxHold = TFS[mdef.tf].maxHold;
  const trades = [];
  let openUntil = -1;
  for (let i = WARMUP; i < candles.length - 1; i += 1) {
    if (i < openUntil) continue;
    if (!s.signal(i, ctx)) continue;
    const entryIdx = i + 1;
    const entry = candles[entryIdx].o;
    const x = walkExit(candles, entryIdx, entry, s.side, mdef.exit, ctx.atr[i], maxHold);
    openUntil = x.exitIdx;
    if (x.exitType === "open") continue;
    trades.push({
      member: memberKey,
      side: s.side,
      entryAt: candles[entryIdx].t,
      exitAt: candles[x.exitIdx].t,
      entry,
      exit: Math.round(x.exitPrice * 10) / 10,
      exitType: x.exitType,
      holdBars: x.exitIdx - entryIdx + 1,
      grossPct: Math.round(x.grossPct * 1000) / 1000,
      stopDistPct: Math.round(x.stopDistPct * 1000) / 1000,
    });
  }
  return trades;
}

/* ---------- 병행 복리 — 진입 시점 실현 잔고로 사이징 ---------- */

function runMethod(method, tradesByMember, periodEdges) {
  const all = method.members
    .flatMap((mk) => tradesByMember[mk])
    .sort((a, b) => a.entryAt - b.entryAt || a.exitAt - b.exitAt);

  // 청산 이벤트를 시간순으로 반영하기 위한 정렬 사본.
  const byExit = all.slice().sort((a, b) => a.exitAt - b.exitAt || a.entryAt - b.entryAt);

  let realized = START;
  let exitPtr = 0;
  const log = [];
  const curve = [{ at: periodEdges[0], eq: START }];
  const open = []; // {exitAt, riskPct}

  let maxConcurrent = 0;
  let maxOpenRisk = 0;

  for (const t of all) {
    // 이 진입보다 먼저 끝난 거래의 손익을 잔고에 반영한다.
    // 아직 진입 처리 전인 거래(자기 자신의 같은 봉 청산 등)를 만나면 멈춘다 —
    // 지나쳐 버리면 그 손익이 영영 누락된다.
    while (exitPtr < byExit.length && byExit[exitPtr].exitAt <= t.entryAt) {
      const e = byExit[exitPtr];
      if (!e._resolved) break;
      realized += e._pnlUsd;
      curve.push({ at: e.exitAt, eq: Math.round(realized * 100) / 100 });
      exitPtr += 1;
    }
    // 동시 노출 추적.
    for (let k = open.length - 1; k >= 0; k -= 1) if (open[k].exitAt <= t.entryAt) open.splice(k, 1);

    const lev = Math.min(MAX_LEV, method.risk / (t.stopDistPct + FEE_PCT));
    const netPct = (t.grossPct - FEE_PCT) * lev;
    const eqAtEntry = realized;
    t._pnlUsd = eqAtEntry * netPct / 100;
    t._resolved = true;

    open.push({ exitAt: t.exitAt, riskPct: method.risk });
    maxConcurrent = Math.max(maxConcurrent, open.length);
    maxOpenRisk = Math.max(maxOpenRisk, open.reduce((s, o) => s + o.riskPct, 0));

    log.push({
      member: t.member,
      label: MEMBERS[t.member].label,
      side: t.side,
      entryAt: t.entryAt,
      exitAt: t.exitAt,
      entry: t.entry,
      exit: t.exit,
      exitType: t.exitType,
      holdBars: t.holdBars,
      lev: Math.round(lev * 100) / 100,
      netPct: Math.round(netPct * 1000) / 1000,
      eqAtEntry: Math.round(eqAtEntry * 100) / 100,
    });
  }
  // 남은 청산 반영 — 이 시점에는 모든 거래의 진입이 처리돼 있다.
  while (exitPtr < byExit.length) {
    const e = byExit[exitPtr];
    realized += e._pnlUsd;
    curve.push({ at: e.exitAt, eq: Math.round(realized * 100) / 100 });
    exitPtr += 1;
  }
  // 로그에 청산 후 잔고를 붙인다 — 청산 시간순.
  const logByExit = log.slice().sort((a, b) => a.exitAt - b.exitAt || a.entryAt - b.entryAt);
  let eq = START;
  for (const l of logByExit) {
    eq += l.eqAtEntry * l.netPct / 100;
    l.pnlUsd = Math.round(l.eqAtEntry * l.netPct / 100 * 100) / 100;
    l.equityAfter = Math.round(eq * 100) / 100;
  }

  // 통계 — 청산 시간순 실현 잔고 기준.
  let peak = START, mdd = 0, streak = 0, maxLossStreak = 0;
  for (const l of logByExit) {
    peak = Math.max(peak, l.equityAfter);
    mdd = Math.min(mdd, (l.equityAfter / peak - 1) * 100);
    streak = l.netPct > 0 ? 0 : streak + 1;
    maxLossStreak = Math.max(maxLossStreak, streak);
  }
  const n = log.length;
  const wins = log.filter((l) => l.netPct > 0).length;
  const final = logByExit.length ? logByExit[logByExit.length - 1].equityAfter : START;
  const totalReturn = (final / START - 1) * 100;

  const periods = periodEdges.slice(0, -1).map((from, k) => {
    const to = periodEdges[k + 1];
    const ts = logByExit.filter((l) => l.entryAt >= from && l.entryAt < to);
    const usd = ts.reduce((s, l) => s + l.pnlUsd, 0);
    return { n: ts.length, usd: Math.round(usd * 100) / 100 };
  });

  const days = (periodEdges[3] - periodEdges[0]) / 86400_000;
  const r = (x) => Math.round(x * 100) / 100;
  return {
    stats: {
      trades: n,
      wins,
      winRate: n ? r((wins / n) * 100) : null,
      finalEquity: r(final),
      totalReturn: r(totalReturn),
      mdd: r(mdd),
      mar: mdd !== 0 ? r(totalReturn / -mdd) : null,
      perMonth: r(n / (days / 30)),
      avgLev: n ? r(log.reduce((s, l) => s + l.lev, 0) / n) : null,
      maxConcurrent,
      maxOpenRisk: r(maxOpenRisk),
      maxLossStreak,
      periods,
      positivePeriods: periods.filter((p) => p.n > 0 && p.usd > 0).length,
      exitCounts: {
        tp: log.filter((l) => l.exitType === "tp").length,
        sl: log.filter((l) => l.exitType === "sl").length,
        time: log.filter((l) => l.exitType === "time").length,
      },
    },
    curve,
    log: logByExit,
  };
}

/* ---------- 실행 ---------- */

const dataByTf = {};
for (const tf of ["4H", "1D"]) {
  const candles = await fetchCandles(tf);
  const closes = candles.map((c) => c.c);
  dataByTf[tf] = {
    candles,
    ctx: {
      candles,
      rsi: rsi(closes),
      atr: atr(candles),
      volMA: volMA(candles),
      sma20: sma(closes, 20),
      sma50: sma(closes, 50),
      ll20: rolling(candles, 20, (c) => c.l, (a, b) => a < b),
    },
  };
  console.log(`${tf}: 캔들 ${candles.length}개`);
}

// 공통 3구간 — 4H 워밍업 이후를 기준으로 한다(1D 거래도 이 축으로 묶는다).
const c4 = dataByTf["4H"].candles;
const t0 = c4[WARMUP].t;
const t1 = c4[c4.length - 1].t;
const periodEdges = [t0, t0 + (t1 - t0) / 3, t0 + (2 * (t1 - t0)) / 3, t1 + 1];

const tradesByMember = Object.fromEntries(
  Object.keys(MEMBERS).map((mk) => [mk, memberTrades(mk, dataByTf)]),
);

// BTC 보유 벤치마크 — 같은 기간 $100.
const benchStart = c4.find((c) => c.t >= t0).c;
const benchEnd = c4[c4.length - 1].c;

const result = {
  meta: {
    generatedAt: Date.now(),
    symbol: INST,
    days: DAYS,
    fee: FEE_PCT,
    start: START,
    maxLev: MAX_LEV,
    sizing: "L = min(10, 리스크% ÷ (손절폭% + 0.1%)) — 거래당 손실 상한 = 리스크%",
    accounting: "진입 시점 실현 잔고로 사이징, 실현손익은 청산 시점 반영 (미실현 제외)",
    from: t0,
    to: t1,
    rules: {
      entry: "신호 봉 마감 → 다음 봉 시가 진입",
      exits: "고정 목표·손절 (플레이북 검증 폭) — 가장 심플한 형태",
      maxHold: "4H 60봉(10일) · 1D 20봉(20일)째 마감에 청산",
      fee: `왕복 ${FEE_PCT}% × 레버리지 (펀딩비 제외)`,
      conflict: "동시 도달은 손절, 갭은 시가 체결(보수적)",
    },
  },
  members: Object.entries(MEMBERS).map(([key, m]) => ({
    key, label: m.label, tf: m.tf, side: SIGNALS[m.signal].side,
    rule: SIGNALS[m.signal].rule,
    exitDesc: m.exit.type === "atr" ? `손절 ${m.exit.sl}×ATR·목표 ${m.exit.tp}×ATR` : `손절 ${m.exit.sl}%·목표 ${m.exit.tp}%`,
    trades: tradesByMember[key].length,
  })),
  benchmark: {
    finalEquity: Math.round((benchEnd / benchStart) * START * 100) / 100,
    note: "같은 기간 $100로 BTC를 사서 들고만 있었다면",
  },
  methods: [],
};

for (const method of METHODS) {
  const sim = runMethod(
    method,
    // _pnlUsd 오염을 막기 위해 거래 목록을 복제해서 넘긴다.
    Object.fromEntries(Object.entries(tradesByMember).map(([k, v]) => [k, v.map((t) => ({ ...t }))])),
    periodEdges,
  );
  result.methods.push({ ...method, stats: sim.stats, curve: sim.curve, log: sim.log });
  const st = sim.stats;
  console.log(
    `${method.name} — $100→$${st.finalEquity} (${st.totalReturn > 0 ? "+" : ""}${st.totalReturn}%) ` +
    `MDD ${st.mdd}% MAR ${st.mar} · ${st.trades}건(월 ${st.perMonth}) 승률 ${st.winRate}% ` +
    `동시 최대 ${st.maxConcurrent}개(리스크 합 ${st.maxOpenRisk}%) 구간 ${st.positivePeriods}/3`,
  );
}
console.log(`벤치마크(보유): $${result.benchmark.finalEquity}`);

const kstDay = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = process.argv[2] ?? join(repoRoot, "docs", "backtest", `${kstDay}-portfolio-sim.json`);
writeFileSync(out, JSON.stringify(result));
console.log(`저장: ${out}`);
