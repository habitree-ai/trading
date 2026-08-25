/**
 * P2 — 과거 복기: 누적 캔들 전체에 봇과 같은 부등식을 걸어
 * "언제 신호가 났고, 들어갔다면 언제 어떻게 나왔나"를 전량 재현한다.
 *
 * 판정·체결 규칙은 라이브 봇(system-trading/bot)과 같아야 의미가 있다:
 *   · 판정은 마감 봉에서만 — signals.mjs 의 SIGNALS 를 그대로 import 한다
 *   · 진입은 다음 봉 시가(봇의 "마감 직후 시장가" 근사)
 *   · 손절 우선, 갭이면 시가 체결 · 목표는 목표가 체결 · 시한 초과는 종가 정리
 *   · 사이징 L = min(10, 리스크% ÷ (손절폭% + 수수료%)), 순손익 = (총손익% − 수수료%) × L
 *
 * 두 층위를 모두 남긴다:
 *   members   — 기준별 독립 복기(한 기준 한 포지션만 제약). 신호 이력의 정본.
 *   portfolio — 현 시스템(쿼드 봇) 규칙 그대로: 동시 2개·리스크 합 20% 상한, 복리 회계.
 */
import { sma } from "../system-trading/bot/indicators.mjs";
import { CONFIG as cfg } from "../system-trading/bot/config.mjs";
import { SIGNALS, buildCtx, exitLevels, snapshot } from "../system-trading/bot/signals.mjs";
import { BARS, loadData, saveData, saveDataText, toCsv } from "./lib/data.mjs";

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

/* ---------- 단일 트레이드 시뮬레이션 (엔진 managePaper 와 같은 규칙) ---------- */

function simulateTrade(key, m, ctx, i) {
  const candles = ctx.candles;
  const entryIdx = i + 1;
  const entryPrice = candles[entryIdx].o;
  const { stop, target, stopDistPct } = exitLevels(entryPrice, m.side, m.exit, ctx.atr[i]);
  const lev = Math.min(cfg.maxLev, cfg.riskPct / (stopDistPct + cfg.feePct));
  const dir = m.side === "long" ? 1 : -1;
  const maxHold = cfg.maxHoldBars[m.tf];
  const barMs = cfg.barMs[m.tf];

  let closed = null;
  let exitIdx = null;
  for (let k = 0; k < maxHold; k += 1) {
    const idx = entryIdx + k;
    if (idx >= candles.length) break; // 데이터 끝 — 미청산 상태로 남긴다
    const bar = candles[idx];
    const hitSl = dir === 1 ? bar.l <= stop : bar.h >= stop;
    const hitTp = dir === 1 ? bar.h >= target : bar.l <= target;
    if (hitSl) {
      closed = { price: dir === 1 ? Math.min(stop, bar.o) : Math.max(stop, bar.o), type: "sl", held: k + 1 };
      exitIdx = idx;
      break;
    }
    if (hitTp) {
      closed = { price: target, type: "tp", held: k + 1 };
      exitIdx = idx;
      break;
    }
    if (k === maxHold - 1) {
      closed = { price: bar.c, type: "time", held: k + 1 };
      exitIdx = idx;
      break;
    }
  }

  const trade = {
    tradeId: `${key}-${candles[i].t + barMs}`,
    member: key,
    name: m.name,
    tf: m.tf,
    side: m.side,
    signalTs: candles[i].t,
    entryTs: candles[i].t + barMs,
    entryPrice,
    stop: r2(stop),
    target: r2(target),
    stopDistPct: r3(stopDistPct),
    lev: r3(lev),
    signal: snapshot(i, ctx),
  };
  if (closed) {
    const grossPct = ((closed.price - entryPrice) / entryPrice) * dir * 100;
    trade.exitIdx = exitIdx;
    trade.exitTs = candles[exitIdx].t + barMs; // 마감 시각 기준 — 포트폴리오 순서 정렬에 쓴다
    trade.exitBarTs = candles[exitIdx].t;
    trade.exitPrice = r2(closed.price);
    trade.exitType = closed.type;
    trade.holdBars = closed.held;
    trade.grossPct = r3(grossPct);
    trade.netPct = r3((grossPct - cfg.feePct) * lev);
  } else {
    trade.exitType = "open"; // 데이터 끝까지 미청산
  }
  return trade;
}

/* ---------- 기준별 독립 복기 ---------- */

function replayMember(key, m, ctx) {
  const candles = ctx.candles;
  const signals = [];
  const trades = [];
  let freeFromIdx = -1; // 이 인덱스부터 신규 진입 가능(청산 봉에서는 청산→진입이 한 사이클)

  for (let i = 1; i < candles.length; i += 1) {
    if (!SIGNALS[key].fire(i, ctx)) continue;
    const base = { member: key, tf: m.tf, barTs: candles[i].t, indicators: snapshot(i, ctx) };
    if (i < freeFromIdx) {
      signals.push({ ...base, action: "skip", skip: "이 기준의 포지션 보유 중" });
      continue;
    }
    if (i === candles.length - 1) {
      signals.push({ ...base, action: "pending", skip: "다음 봉 미형성 — 진입가 미확정" });
      continue;
    }
    if (m.exit.type === "atr" && ctx.atr[i] === null) {
      signals.push({ ...base, action: "skip", skip: "ATR 워밍업 구간" });
      continue;
    }
    const trade = simulateTrade(key, m, ctx, i);
    trades.push(trade);
    signals.push({ ...base, action: "enter", tradeId: trade.tradeId });
    freeFromIdx = trade.exitIdx ?? Infinity;
  }
  return { signals, trades };
}

function memberSummary(trades) {
  const closed = trades.filter((t) => t.exitType !== "open");
  const wins = closed.filter((t) => t.netPct > 0);
  const posSum = wins.reduce((s, t) => s + t.netPct, 0);
  const negSum = closed.filter((t) => t.netPct <= 0).reduce((s, t) => s + t.netPct, 0);
  let eq = 100;
  let peak = 100;
  let maxDd = 0;
  const curve = [];
  for (const t of closed) {
    eq *= 1 + t.netPct / 100;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (1 - eq / peak) * 100);
    curve.push({ ts: t.exitTs, eq: r2(eq) });
  }
  const byType = {};
  for (const t of closed) byType[t.exitType] = (byType[t.exitType] ?? 0) + 1;
  return {
    trades: trades.length,
    closed: closed.length,
    open: trades.length - closed.length,
    winRate: closed.length ? r2((wins.length / closed.length) * 100) : null,
    avgNetPct: closed.length ? r3(closed.reduce((s, t) => s + t.netPct, 0) / closed.length) : null,
    profitFactor: negSum < 0 ? r2(posSum / -negSum) : null,
    finalEquityIdx: r2(eq),
    maxDdPct: r2(maxDd),
    byExitType: byType,
    curve,
  };
}

/* ---------- 포트폴리오 복기 — 쿼드 봇 규칙 그대로 ---------- */

function replayPortfolio(ctxByTf) {
  // 발화한 모든 신호(마지막 봉 제외)를 진입 시각 순으로 늘어놓는다.
  const events = [];
  for (const [key, m] of Object.entries(cfg.members)) {
    const ctx = ctxByTf[m.tf];
    for (let i = 1; i < ctx.candles.length - 1; i += 1) {
      if (!SIGNALS[key].fire(i, ctx)) continue;
      if (m.exit.type === "atr" && ctx.atr[i] === null) continue;
      events.push({ key, m, ctx, i, entryTs: ctx.candles[i].t + cfg.barMs[m.tf] });
    }
  }
  events.sort((a, b) => a.entryTs - b.entryTs);

  let equity = cfg.paperStartEquity;
  const open = new Map(); // key → { trade, eqAtEntry }
  const trades = [];
  const skips = [];
  const curve = [{ ts: events.length ? events[0].entryTs : Date.now(), eq: equity }];
  let peak = equity;
  let maxDd = 0;
  let maxConcurrentSeen = 0;

  const closeDue = (untilTs) => {
    // 청산 시각(청산 봉 마감) <= 기준 시각 — 같은 사이클에서는 청산이 진입보다 먼저다.
    const due = [...open.entries()]
      .filter(([, p]) => p.trade.exitTs !== undefined && p.trade.exitTs <= untilTs)
      .sort((a, b) => a[1].trade.exitTs - b[1].trade.exitTs);
    for (const [key, p] of due) {
      const pnlUsd = r2((p.eqAtEntry * p.trade.netPct) / 100);
      equity = r2(equity + pnlUsd);
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, (1 - equity / peak) * 100);
      trades.push({ ...p.trade, eqAtEntry: p.eqAtEntry, pnlUsd, equityAfter: equity });
      curve.push({ ts: p.trade.exitTs, eq: equity });
      open.delete(key);
    }
  };

  for (const ev of events) {
    closeDue(ev.entryTs);
    const base = { member: ev.key, tf: ev.m.tf, barTs: ev.ctx.candles[ev.i].t, entryTs: ev.entryTs };
    if (open.has(ev.key)) {
      skips.push({ ...base, skip: "이 기준의 포지션 보유 중" });
      continue;
    }
    if (open.size >= cfg.maxConcurrent) {
      skips.push({ ...base, skip: `동시 포지션 상한 ${cfg.maxConcurrent}개` });
      continue;
    }
    const openRisk = open.size * cfg.riskPct;
    if (openRisk + cfg.riskPct > cfg.maxOpenRiskPct) {
      skips.push({ ...base, skip: `동시 리스크 상한 ${cfg.maxOpenRiskPct}% 초과` });
      continue;
    }
    const trade = simulateTrade(ev.key, ev.m, ev.ctx, ev.i);
    open.set(ev.key, { trade, eqAtEntry: equity });
    maxConcurrentSeen = Math.max(maxConcurrentSeen, open.size);
  }
  closeDue(Infinity);

  const stillOpen = [...open.values()].map((p) => ({ ...p.trade, eqAtEntry: p.eqAtEntry }));
  const closed = trades;
  const wins = closed.filter((t) => t.netPct > 0);
  const posSum = wins.reduce((s, t) => s + t.netPct, 0);
  const negSum = closed.filter((t) => t.netPct <= 0).reduce((s, t) => s + t.netPct, 0);
  return {
    trades: closed,
    openTrades: stillOpen,
    skips,
    curve,
    summary: {
      signals: events.length,
      entered: closed.length + stillOpen.length,
      skipped: skips.length,
      winRate: closed.length ? r2((wins.length / closed.length) * 100) : null,
      avgNetPct: closed.length ? r3(closed.reduce((s, t) => s + t.netPct, 0) / closed.length) : null,
      profitFactor: negSum < 0 ? r2(posSum / -negSum) : null,
      startEquity: cfg.paperStartEquity,
      finalEquity: equity,
      maxDdPct: r2(maxDd),
      maxConcurrent: maxConcurrentSeen,
    },
  };
}

/* ---------- 기간·국면 분해 ---------- */

const yymm = (ts) => new Date(ts).toISOString().slice(0, 7);
const yy = (ts) => new Date(ts).getUTCFullYear();
const r2g = (x) => Math.round(x * 100) / 100;
const r3g = (x) => Math.round(x * 1000) / 1000;

function groupMult(trades, keyFn) {
  const m = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    const s = m.get(k) ?? { key: k, n: 0, wins: 0, mult: 1 };
    s.n += 1;
    if (t.netPct > 0) s.wins += 1;
    s.mult *= 1 + t.netPct / 100;
    m.set(k, s);
  }
  return [...m.values()]
    .map((s) => ({ ...s, winRate: r2g((s.wins / s.n) * 100), mult: r3g(s.mult) }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

/** BTC 1D 종가의 SMA200 국면 — 시점 ts 의 마지막 확정 1D 봉 기준. */
function makeRegimeAt(d1) {
  const closes = d1.map((c) => c.c);
  const s200 = sma(closes, 200);
  return (ts) => {
    let lo = 0;
    let hi = d1.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (d1[mid].t <= ts) lo = mid;
      else hi = mid - 1;
    }
    if (d1[lo].t > ts || s200[lo] === null) return null;
    return closes[lo] > s200[lo] ? "상승장(1D>SMA200)" : "하락장(1D<SMA200)";
  };
}

/** 낙폭 에피소드 — 고점 → 저점 → 회복(또는 미회복). 깊이순 상위만. */
function drawdownEpisodes(curve, top = 5) {
  const eps = [];
  let peak = curve[0];
  let trough = curve[0];
  let inDd = false;
  for (const p of curve) {
    if (p.eq >= peak.eq) {
      if (inDd) {
        eps.push({ peakTs: peak.ts, troughTs: trough.ts, recoverTs: p.ts, depthPct: r2g((1 - trough.eq / peak.eq) * 100) });
        inDd = false;
      }
      peak = p;
      trough = p;
    } else {
      inDd = true;
      if (p.eq < trough.eq) trough = p;
    }
  }
  if (inDd) eps.push({ peakTs: peak.ts, troughTs: trough.ts, recoverTs: null, depthPct: r2g((1 - trough.eq / peak.eq) * 100) });
  return eps.sort((a, b) => b.depthPct - a.depthPct).slice(0, top);
}

function netPctHistogram(trades) {
  const edges = [-Infinity, -10, -5, -2, 0, 2, 5, 10, 20, Infinity];
  const labels = ["<−10%", "−10~−5%", "−5~−2%", "−2~0%", "0~2%", "2~5%", "5~10%", "10~20%", "≥20%"];
  const counts = new Array(labels.length).fill(0);
  for (const t of trades) {
    const i = edges.findIndex((e, k) => k < edges.length - 1 && t.netPct >= e && t.netPct < edges[k + 1]);
    if (i >= 0) counts[i] += 1;
  }
  return labels.map((label, i) => ({ label, n: counts[i] }));
}

/* ---------- 메인 ---------- */

function main() {
  const candlesByTf = {};
  const dataRange = {};
  for (const tf of Object.keys(BARS)) {
    const store = loadData(`candles-BTC-${tf}.json`) ?? loadData(`candles-${tf}.json`);
    if (!store) {
      console.error(`캔들 없음: re_sys/data/candles-BTC-${tf}.json — node re_sys/fetch.mjs 를 먼저 실행하라.`);
      process.exit(1);
    }
    candlesByTf[tf] = store.candles;
    dataRange[tf] = {
      bars: store.candles.length,
      from: store.candles[0].t,
      to: store.candles[store.candles.length - 1].t,
    };
    console.log(
      `[${tf}] ${store.candles.length}봉 · ${new Date(dataRange[tf].from).toISOString().slice(0, 10)} → ${new Date(dataRange[tf].to).toISOString().slice(0, 10)}`,
    );
  }
  const ctxByTf = Object.fromEntries(
    Object.keys(BARS).map((tf) => [tf, buildCtx(candlesByTf[tf])]),
  );

  const members = {};
  for (const [key, m] of Object.entries(cfg.members)) {
    const { signals, trades } = replayMember(key, m, ctxByTf[m.tf]);
    members[key] = { name: m.name, tf: m.tf, side: m.side, exit: m.exit, signals, trades, summary: memberSummary(trades) };
    const s = members[key].summary;
    console.log(
      `  ${key.padEnd(4)} ${m.name}: 신호 ${signals.length} · 체결 ${s.trades} · 승률 ${s.winRate ?? "—"}% · ` +
        `지수 ${s.finalEquityIdx} · MDD ${s.maxDdPct}%`,
    );
  }

  const portfolio = replayPortfolio(ctxByTf);
  // 기간·국면 분해 — 전 구간 합산이 감추는 것(엣지의 시기 편중)을 드러낸다.
  const regimeAt = makeRegimeAt(candlesByTf["1D"]);
  portfolio.analysis = {
    byYear: groupMult(portfolio.trades, (t) => yy(t.entryTs)),
    byMonth: groupMult(portfolio.trades, (t) => yymm(t.entryTs)),
    byRegime: groupMult(portfolio.trades, (t) => regimeAt(t.signalTs) ?? "판정 불가"),
    drawdowns: drawdownEpisodes(portfolio.curve),
    histogram: netPctHistogram(portfolio.trades),
  };
  for (const [key, m] of Object.entries(members)) {
    const closed = m.trades.filter((t) => t.exitType !== "open");
    m.summary.byYear = groupMult(closed, (t) => yy(t.entryTs));
    m.summary.byRegime = groupMult(closed, (t) => regimeAt(t.signalTs) ?? "판정 불가");
  }
  const ps = portfolio.summary;
  console.log(
    `  쿼드 포트폴리오: 신호 ${ps.signals} · 진입 ${ps.entered} · 건너뜀 ${ps.skipped} · ` +
      `$${ps.startEquity} → $${ps.finalEquity} · 승률 ${ps.winRate ?? "—"}% · MDD ${ps.maxDdPct}%`,
  );

  const result = {
    generatedAt: Date.now(),
    instId: cfg.instId,
    // 복기가 어떤 설정으로 돌았는지 — 설정이 바뀌면 과거 리포트와 비교할 근거가 된다.
    config: {
      members: cfg.members,
      riskPct: cfg.riskPct,
      maxLev: cfg.maxLev,
      feePct: cfg.feePct,
      maxConcurrent: cfg.maxConcurrent,
      maxOpenRiskPct: cfg.maxOpenRiskPct,
      maxHoldBars: cfg.maxHoldBars,
    },
    dataRange,
    members,
    portfolio,
  };
  saveData("replay.json", result);

  // 로우데이터 CSV — 기준별 트레이드·신호 전량.
  const tradeCols = [
    "member", "name", "tf", "side", "signalTs", "entryTs", "exitTs", "entryPrice", "exitPrice",
    "exitType", "holdBars", "stop", "target", "stopDistPct", "lev", "grossPct", "netPct",
  ];
  const allTrades = Object.values(members).flatMap((m) => m.trades);
  saveDataText("trades.csv", toCsv(allTrades, tradeCols));
  const sigRows = Object.values(members).flatMap((m) =>
    m.signals.map((s) => ({
      member: s.member, tf: s.tf, barTs: s.barTs, action: s.action, skip: s.skip ?? "",
      close: s.indicators.close, rsi: s.indicators.rsi, atr: s.indicators.atr,
      sma20: s.indicators.sma20, sma50: s.indicators.sma50, ll20: s.indicators.ll20,
    })),
  );
  saveDataText("signals.csv", toCsv(sigRows, ["member", "tf", "barTs", "action", "skip", "close", "rsi", "atr", "sma20", "sma50", "ll20"]));

  console.log("\n저장 완료 → re_sys/data/replay.json · trades.csv · signals.csv");
}

main();
