/**
 * 앙상블 전방 검증 러너 — 복리 조합 탐색(2026-08-17) 회차의 "후보 1호"를
 * 페이퍼 북("ens")에서 백테스트 스펙 그대로 재현한다.
 *
 *   node system-trading/bot/ensemble-paper.mjs          # 1회 실행
 *   node system-trading/bot/ensemble-paper.mjs --loop   # 1H 마감마다 자동
 *
 * 개정 1.1 (2026-08-17, 거래 0건 상태 — 시계 리셋): 베이시스 회차의 bzc 편입(all8).
 *   근거 all8·both·r2 = $302 · CAGR 25.8% · 봉 MDD −37.7% · MAR 0.68 · 3/3구간 (품질 4/5).
 * 구성(스펙 동결 2026-08-17, docs/backtest/2026-08-17-ensemble.json 근거):
 *   멤버 8 = 쿼드(gc·ob·fade·dc) + 후보(dch·mcv·ibq) + 베이시스(bzc) — criteria.md 판정·청산 그대로
 *   레짐 게이트 = 롱은 일봉 종가>일봉 SMA200일 때만, 숏은 <일 때만 (전 멤버 적용 — 백테스트와 동일)
 *   드로다운 스로틀 = 유효 리스크 = 2% × clamp(잔고/피크, 0.25, 1)
 *   동시 상한 = 3개 · 리스크 합 6% · 레버 상한 10배
 *   비용 = 왕복 0.1% + 펀딩(롱 0.03%/일 × 보유일) — 백테스트와 같은 가정
 *
 * 이 러너는 주문 코드가 없다(공개 API만). cand 북과도 분리 — cand는 멤버 단독 검증,
 * ens는 조합+오버레이 검증이라 묻는 질문이 다르다. 승격 게이트: 신규 30~50건에서
 * 기대값>0 유지 시 데모 검토. 라이브 반영은 사용자 결정.
 */
import { atr, basisSeries, macd, rollingLow, rollingZ, rsi, sma, volMA } from "./indicators.mjs";
import { notify } from "./notify.mjs";
import { mirrorDecision, mirrorEquity, mirrorState, mirrorTradeClose, mirrorTradeOpen } from "./state-mirror.mjs";
import { OkxClient } from "./okx.mjs";
import { exitLevels } from "./signals.mjs";
import { appendLog, loadState, saveState } from "./state.mjs";

const BOOK = "ens";
const CFG = {
  instId: "BTC-USDT-SWAP",
  tfs: {
    "1H": { ms: 3600_000, maxHold: 120 },
    "4H": { ms: 4 * 3600_000, maxHold: 60 },
    "1D": { ms: 24 * 3600_000, maxHold: 20 },
  },
  members: {
    gc: { tf: "4H", name: "골든크로스", side: "long", exit: { type: "atr", sl: 1, tp: 3 } },
    ob: { tf: "4H", name: "RSI 과매도 반등", side: "long", exit: { type: "atr", sl: 1, tp: 3 } },
    fade: { tf: "4H", name: "RSI 과매수 반락", side: "short", exit: { type: "atr", sl: 2, tp: 4 } },
    dc: { tf: "1D", name: "20봉 신저가 이탈", side: "short", exit: { type: "pct", sl: 2, tp: 4 } },
    dch: { tf: "4H", name: "신저가 숏+일봉 하락", side: "short", exit: { type: "atr", sl: 1, tp: 3 } },
    mcv: { tf: "4H", name: "MACD+거래량", side: "long", exit: { type: "atr", sl: 1, tp: 1 } },
    ibq: { tf: "1H", name: "인사이드바+저변동", side: "long", exit: { type: "atr", sl: 2, tp: 6 } },
    bzc: { tf: "4H", name: "베이시스 공포 복귀", side: "long", exit: { type: "atr", sl: 2, tp: 6 } },
  },
  baseRiskPct: 2,
  throttleFloor: 0.25,
  maxLev: 10,
  feePct: 0.1,
  fundLongPctPerDay: 0.03,
  maxConcurrent: 3,
  maxOpenRiskPct: 6,
  dayMs: 24 * 3600_000,
  candleLimit: 300, // 일봉 SMA200(200봉)·MACD 시드·ATR100(첫 114 무효)을 전부 덮는다.
  startEquity: 100,
};

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

/* ---------- 판정 컨텍스트 ---------- */

function buildCtx(tf, candles, daily, spot4h = null) {
  const closes = candles.map((c) => c.c);
  const ctx = { candles, atr: atr(candles), daily };
  if (tf === "4H") {
    const { line, signal } = macd(closes);
    ctx.rsi = rsi(closes);
    ctx.sma20 = sma(closes, 20);
    ctx.sma50 = sma(closes, 50);
    ctx.ll20 = rollingLow(candles, 20);
    ctx.macdLine = line;
    ctx.macdSig = signal;
    ctx.volMA = volMA(candles);
    ctx.dailySma50 = sma(daily.map((c) => c.c), 50);
  }
  if (tf === "1H") {
    const atrMA100 = sma(ctx.atr.map((v) => v ?? 0), 100);
    for (let i = 0; i < Math.min(114, atrMA100.length); i += 1) atrMA100[i] = null;
    ctx.atrMA100 = atrMA100;
  }
  if (tf === "1D") {
    ctx.ll20 = rollingLow(candles, 20);
  }
  if (tf === "4H" && spot4h?.length) {
    ctx.basis = basisSeries(candles, spot4h);
    ctx.basisZ = rollingZ(ctx.basis, 180);
  }
  ctx.dailySma200 = sma(daily.map((c) => c.c), 200);
  return ctx;
}

/** 하위봉 i 시점에 마감 완료된 최신 일봉 인덱스. */
function htfIdx(i, c) {
  let d = -1;
  while (d + 1 < c.daily.length && c.daily[d + 1].t + CFG.dayMs <= c.candles[i].t) d += 1;
  return d;
}

const SIGNALS = {
  gc: (i, c) => c.sma20[i - 1] !== null && c.sma50[i - 1] !== null && c.sma20[i - 1] <= c.sma50[i - 1] && c.sma20[i] > c.sma50[i],
  ob: (i, c) => c.rsi[i - 1] !== null && c.rsi[i - 1] < 30 && c.rsi[i] >= 30,
  fade: (i, c) => c.rsi[i - 1] !== null && c.rsi[i - 1] > 70 && c.rsi[i] <= 70,
  dc: (i, c) => c.ll20[i] !== null && c.candles[i].c < c.ll20[i],
  dch: (i, c) => {
    if (c.ll20[i] === null || c.candles[i].c >= c.ll20[i]) return false;
    const d = htfIdx(i, c);
    return d >= 0 && c.dailySma50[d] !== null && c.daily[d].c < c.dailySma50[d];
  },
  mcv: (i, c) =>
    c.macdSig[i - 1] !== null && c.macdLine[i - 1] <= c.macdSig[i - 1] && c.macdLine[i] > c.macdSig[i] &&
    c.volMA[i] !== null && c.candles[i].v >= 1.5 * c.volMA[i],
  ibq: (i, c) =>
    i >= 2 &&
    c.candles[i - 1].h < c.candles[i - 2].h && c.candles[i - 1].l > c.candles[i - 2].l &&
    c.candles[i].c > c.candles[i - 2].h &&
    c.atr[i] !== null && c.atrMA100[i] !== null && c.atr[i] < c.atrMA100[i],
  bzc: (i, c) => c.basisZ?.[i - 1] !== null && c.basisZ?.[i] !== null && c.basisZ[i - 1] <= -2 && c.basisZ[i] > -2,
};

/** 레짐 — 신호 봉 시가 이전에 마감된 일봉 종가 vs 일봉 SMA200. null이면 보수적으로 차단. */
function regimeAllows(side, i, c) {
  const d = htfIdx(i, c);
  if (d < 0 || c.dailySma200[d] === null) return false;
  const up = c.daily[d].c > c.dailySma200[d];
  return side === "long" ? up : !up;
}

function snapshot(key, i, c) {
  const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
  const d = htfIdx(i, c);
  return {
    close: c.candles[i].c,
    atr: r1(c.atr[i]),
    dailyClose: d >= 0 ? c.daily[d].c : null,
    dailySma200: d >= 0 && c.dailySma200[d] !== null ? r1(c.dailySma200[d]) : null,
  };
}

/* ---------- 사이클 ---------- */

async function runCycle(client, state) {
  const summary = { actions: [], evaluated: [], stale: [] };

  const candlesByTf = {};
  for (const tf of ["1H", "4H", "1D"]) {
    candlesByTf[tf] = await client.candles(CFG.instId, tf, CFG.candleLimit);
  }
  if (candlesByTf["1H"].length < 150 || candlesByTf["4H"].length < 60 || candlesByTf["1D"].length < 210) {
    throw new Error(
      `캔들 부족(1H ${candlesByTf["1H"].length}·4H ${candlesByTf["4H"].length}·1D ${candlesByTf["1D"].length}) — 일봉 SMA200에 210봉 필요`,
    );
  }
  for (const tf of ["1H", "4H", "1D"]) {
    const arr = candlesByTf[tf];
    const last = arr[arr.length - 1];
    if (tf !== "1D" && Date.now() > last.t + 2 * CFG.tfs[tf].ms + 30_000) summary.stale.push(tf);
  }
  const spot4h = await client.candles("BTC-USDT", "4H", CFG.candleLimit); // 베이시스(bzc)용 현물.
  if (spot4h.length < 200) throw new Error(`현물 4H 캔들 부족(${spot4h.length}) — 베이시스 z(180봉)에 200봉 필요`);
  const daily = candlesByTf["1D"];
  const ctxByTf = Object.fromEntries(["1H", "4H", "1D"].map((tf) => [tf, buildCtx(tf, candlesByTf[tf], daily, tf === "4H" ? spot4h : null)]));

  // 열린 포지션 가상 체결 — 손절 우선·갭 시가·시한 청산, 펀딩 차감.
  for (const [key, pos] of Object.entries({ ...state.positions })) {
    const bars = candlesByTf[pos.tf].filter((c) => c.t >= pos.entryTs);
    if (bars.length === 0) continue;
    if (bars[0].t > pos.entryTs) {
      appendLog(BOOK, "decisions", { member: key, warn: "진입 봉이 캔들 창 밖 — 수동 정리 필요(포지션 유지 중)" });
      summary.actions.push(`경고: ${pos.name} 진입 봉이 조회 창 밖 — data/state-ens 수동 확인 필요`);
      continue;
    }
    const dir = pos.side === "long" ? 1 : -1;
    let closed = null;
    for (let k = 0; k < bars.length; k += 1) {
      const bar = bars[k];
      const hitSl = dir === 1 ? bar.l <= pos.stop : bar.h >= pos.stop;
      const hitTp = dir === 1 ? bar.h >= pos.target : bar.l <= pos.target;
      if (hitSl) {
        closed = { price: dir === 1 ? Math.min(pos.stop, bar.o) : Math.max(pos.stop, bar.o), type: "sl", ts: bar.t, held: k + 1 };
        break;
      }
      if (hitTp) {
        closed = { price: pos.target, type: "tp", ts: bar.t, held: k + 1 };
        break;
      }
      if (k === pos.maxHold - 1) {
        closed = { price: bar.c, type: "time", ts: bar.t, held: k + 1 };
        break;
      }
    }
    if (!closed) continue;

    const grossPct = ((closed.price - pos.entryPrice) / pos.entryPrice) * dir * 100;
    const holdDays = (closed.held * CFG.tfs[pos.tf].ms) / 86400_000;
    const fundPct = pos.side === "long" ? CFG.fundLongPctPerDay * holdDays : 0;
    const netPct = (grossPct - CFG.feePct - fundPct) * pos.lev;
    state.equity = r2(state.equity + (pos.eqAtEntry * netPct) / 100);
    state.peakEquity = Math.max(state.peakEquity ?? CFG.startEquity, state.equity);
    delete state.positions[key];
    saveState(state);
    appendLog(BOOK, "trades", {
      type: "close",
      tradeId: `${key}-${pos.entryTs}`,
      member: key,
      name: pos.name,
      side: pos.side,
      entryTs: pos.entryTs,
      exitTs: closed.ts,
      entryPrice: pos.entryPrice,
      exitPrice: r2(closed.price),
      exitType: closed.type,
      holdBars: closed.held,
      fundPct: r3(fundPct),
      stop: r2(pos.stop),
      target: r2(pos.target),
      signal: pos.signal,
      lev: r2(pos.lev),
      riskEff: pos.riskPct,
      netPct: r3(netPct),
      eqAtEntry: pos.eqAtEntry,
      pnlUsd: r2((pos.eqAtEntry * netPct) / 100),
      equityAfter: state.equity,
    });
    summary.actions.push(`청산 ${pos.name} ${closed.type} → 잔고 $${state.equity}`);
  }

  // 새 마감 봉 평가.
  for (const [key, m] of Object.entries(CFG.members)) {
    const ctx = ctxByTf[m.tf];
    const candles = ctx.candles;
    const lastIdx = candles.length - 1;
    const lastEval = state.lastBarTs[key] ?? candles[lastIdx - 1].t;
    for (let i = 2; i <= lastIdx; i += 1) {
      if (candles[i].t <= lastEval) continue;
      const isLatest = i === lastIdx;
      const fired = SIGNALS[key](i, ctx);
      let action = "none";
      let skip = null;
      if (fired && !isLatest) {
        action = "missed";
        skip = "봇 정지 중 지나간 신호 — 진입하지 않음";
      } else if (fired) {
        if (!regimeAllows(m.side, i, ctx)) {
          action = "regime";
          skip = "레짐 게이트 — 일봉 SMA200 방향 불일치";
        } else {
          state.peakEquity = Math.max(state.peakEquity ?? CFG.startEquity, state.equity);
          const riskEff = r3(
            CFG.baseRiskPct * Math.max(CFG.throttleFloor, Math.min(1, state.equity / state.peakEquity)),
          );
          const openCount = Object.keys(state.positions).length;
          const openRisk = Object.values(state.positions).reduce((s, p) => s + p.riskPct, 0);
          if (state.positions[key]) {
            action = "skip";
            skip = "이 기준의 포지션 보유 중";
          } else if (openCount >= CFG.maxConcurrent) {
            action = "skip";
            skip = `동시 포지션 상한 ${CFG.maxConcurrent}개`;
          } else if (openRisk + riskEff > CFG.maxOpenRiskPct) {
            action = "skip";
            skip = `동시 리스크 상한 ${CFG.maxOpenRiskPct}% 초과(현재 ${r2(openRisk)}%)`;
          } else {
            await enter(client, state, key, m, ctx, i, riskEff, summary);
            action = "enter";
          }
        }
      }
      appendLog(BOOK, "decisions", {
        member: key,
        tf: m.tf,
        barTs: candles[i].t,
        fired,
        action,
        skip,
        indicators: snapshot(key, i, ctx),
      });
      if (fired) await mirrorDecision(BOOK, { member: key, tf: m.tf, barTs: candles[i].t, fired, action, skip });
      if (isLatest || fired) {
        summary.evaluated.push(
          `${key}@${new Date(candles[i].t).toISOString().slice(0, 16)} ${fired ? "신호" : "-"}${skip ? ` (${skip})` : ""}`,
        );
      }
    }
    state.lastBarTs[key] = candles[lastIdx].t;
  }

  appendLog(BOOK, "equity", { equity: state.equity, peak: state.peakEquity, open: Object.keys(state.positions) });
  await mirrorEquity(BOOK, state.equity, Object.keys(state.positions));
  await mirrorState(BOOK, state);
  saveState(state);
  summary.equity = state.equity;
  summary.openPositions = Object.keys(state.positions);
  return summary;
}

async function enter(client, state, key, m, ctx, i, riskEff, summary) {
  const price = await client.lastPrice(CFG.instId);
  const { stop, target, stopDistPct } = exitLevels(price, m.side, m.exit, ctx.atr[i]);
  const lev = Math.min(CFG.maxLev, riskEff / (stopDistPct + CFG.feePct));

  const pos = {
    member: key,
    name: m.name,
    tf: m.tf,
    side: m.side,
    signalTs: ctx.candles[i].t,
    entryTs: ctx.candles[i].t + CFG.tfs[m.tf].ms,
    entryPrice: price,
    stop,
    target,
    stopDistPct: r3(stopDistPct),
    lev,
    riskPct: riskEff,
    eqAtEntry: r2(state.equity),
    maxHold: CFG.tfs[m.tf].maxHold,
    openedAt: Date.now(),
    signal: snapshot(key, i, ctx),
  };
  state.positions[key] = pos;
  saveState(state);
  appendLog(BOOK, "trades", { type: "open", ...pos, lev: r2(lev) });
  await mirrorTradeOpen(BOOK, pos);
  await mirrorState(BOOK, state);
  summary.actions.push(
    `진입 ${m.name} ${m.side} @ ${price} (유효리스크 ${riskEff}%, 레버 ${r2(lev)}배, 손절 ${r2(stop)}, 목표 ${r2(target)})`,
  );
}

/* ---------- 실행 ---------- */

const loop = process.argv.includes("--loop");
const client = new OkxClient("paper"); // 공개 API만 — 키 불필요, 주문 코드 없음.
const state = loadState(BOOK, CFG.startEquity);
if (state.equity === null || state.equity === undefined) state.equity = CFG.startEquity;
if (state.peakEquity === undefined) state.peakEquity = state.equity;

const TAG = "[ENS]";
console.log(
  `앙상블 전방 검증 (페이퍼·주문 없음) — 멤버 ${Object.keys(CFG.members).length} · 레짐+스로틀 · 기본 리스크 ${CFG.baseRiskPct}% · 1H 주기`,
);

async function once() {
  const started = new Date().toISOString();
  try {
    const s = await runCycle(client, state);
    console.log(`[${started}] ens 사이클 완료 — 잔고 $${s.equity} · 열린 포지션 ${s.openPositions.join(", ") || "없음"}`);
    for (const a of s.actions) console.log("  · " + a);
    for (const e of s.evaluated) console.log("  평가 " + e);
    if (s.actions.length) await notify(`${TAG} ${s.actions.join("\n")}`);
    return s;
  } catch (e) {
    console.error(`[${started}] 사이클 실패:`, e.message);
    await notify(`${TAG} 사이클 실패: ${e.message}`);
    return null;
  }
}

async function onceWithRetry() {
  let s = await once();
  for (let r = 0; r < 2 && s?.stale?.length; r += 1) {
    console.log(`봉 확정 대기(${s.stale.join(",")}) — 2분 뒤 재시도`);
    await new Promise((res) => setTimeout(res, 120_000));
    s = await once();
  }
  if (s?.stale?.length) await notify(`${TAG} 봉 확정 지연(${s.stale.join(",")}) — 재시도 소진, 이 봉의 신호는 건너뛸 수 있음`);
  return s;
}

function msToNext1hClose() {
  const period = CFG.tfs["1H"].ms;
  return period - (Date.now() % period) + 90_000;
}

await onceWithRetry();
if (loop) {
  const schedule = () => {
    const wait = msToNext1hClose();
    console.log(`다음 사이클: ${new Date(Date.now() + wait).toISOString()} (${Math.round(wait / 60000)}분 뒤)`);
    setTimeout(async () => {
      await onceWithRetry();
      schedule();
    }, wait);
  };
  schedule();
}
