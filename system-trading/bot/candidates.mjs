/**
 * 후보 전방 검증 러너 — 백테스트 회차의 게이트 통과 후보를
 * 본대(쿼드)와 분리된 페이퍼 북("cand")에서 검증한다.
 *
 *   node system-trading/bot/candidates.mjs          # 1회 실행
 *   node system-trading/bot/candidates.mjs --loop   # 1H 마감마다 자동 (4H 멤버는 lastBarTs로 4시간마다만 평가)
 *
 * 왜 run.mjs 에 합치지 않았나:
 *   · 라이브 봇이 config.mjs 를 공유한다 — 후보가 재시작 한 번으로 실거래에 새어
 *     들어가는 경로를 아예 만들지 않는다. 이 러너는 페이퍼 전용이며 주문 코드가 없다.
 *   · 쿼드 북은 동시 포지션 상한 2개로 검증됐다 — 후보가 그 슬롯을 잠식하면
 *     본대 기록이 오염된다. 북을 분리하면 두 기록 모두 깨끗하다.
 *
 * 멤버 계보:
 *   dch·mcv — 기획 10선 검증(2026-08-17, 4H) 게이트 통과 조합.
 *   ibq — 15m·1H 재도전(2026-08-17, 1H) 유일 게이트 통과 조합. 이 편입으로 주기가 4H→1H가 됐다.
 *
 * 판정·체결 규칙은 백테스트(scripts/backtest/{ten-strategies,short-tf}.mjs)와 동일:
 * 마감 봉 판정 → 다음 봉 시가(≈마감 직후 현재가) 진입, 손절 우선, 갭이면 시가 체결.
 * 일봉 필터는 신호 봉 시가 이전에 마감 완료된 일봉만 본다(진행 중 일봉은 미래 참조).
 * 리스크는 승격 사다리 첫 칸 2%: L = min(10, 2% ÷ (손절폭% + 0.1%)).
 */
import { atr, macd, rollingLow, sma, volMA } from "./indicators.mjs";
import { notify } from "./notify.mjs";
import { OkxClient } from "./okx.mjs";
import { exitLevels } from "./signals.mjs";
import { appendLog, loadState, saveState } from "./state.mjs";

const BOOK = "cand";
const CFG = {
  instId: "BTC-USDT-SWAP",
  tfs: {
    "4H": { ms: 4 * 3600_000, maxHold: 60 }, // 10일 — 백테스트와 동일
    "1H": { ms: 3600_000, maxHold: 120 }, // 5일 — 15m·1H 재도전 회차와 동일
  },
  /** 스펙 동결일은 멤버별 명시 — 게이트 통과 회차의 조합 그대로. */
  members: {
    dch: {
      tf: "4H",
      name: "신저가 이탈 숏 + 일봉 하락",
      side: "short",
      exit: { type: "atr", sl: 1, tp: 3 },
      rule: "종가가 직전 20봉 최저가 아래로 마감 + 일봉 종가 < 일봉 SMA50 (동결 2026-08-17)",
    },
    mcv: {
      tf: "4H",
      name: "MACD 교차 + 거래량 확장",
      side: "long",
      exit: { type: "atr", sl: 1, tp: 1 },
      rule: "MACD(12,26,9) 라인이 시그널 상향 교차 마감 + 거래량 ≥ 1.5×20봉 평균 (동결 2026-08-17)",
    },
    ibq: {
      tf: "1H",
      name: "인사이드바 돌파 + 저변동",
      side: "long",
      exit: { type: "atr", sl: 2, tp: 6 },
      rule: "인사이드바 후 종가가 모봉 고가 돌파 마감 + ATR(14) < 직전 100봉 ATR 평균 (동결 2026-08-17)",
    },
  },
  riskPct: 2,
  maxLev: 10,
  feePct: 0.1,
  maxConcurrent: 3, // 멤버 3개가 슬롯을 다투면 기록이 오염된다 — 멤버당 1슬롯.
  maxOpenRiskPct: 6,
  dayMs: 24 * 3600_000,
  candleLimit: 300, // MACD 시드·ATR 100봉 평균(첫 114봉 무효)·SMA50 일봉을 전부 덮는다.
  startEquity: 100,
};

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

/* ---------- 판정 컨텍스트 ---------- */

function buildCtx4h(candles4h, daily) {
  const closes = candles4h.map((c) => c.c);
  const { line, signal } = macd(closes);
  return {
    candles: candles4h,
    atr: atr(candles4h),
    ll20: rollingLow(candles4h, 20),
    macdLine: line,
    macdSig: signal,
    volMA: volMA(candles4h),
    daily,
    dailySma50: sma(daily.map((c) => c.c), 50),
  };
}

function buildCtx1h(candles1h) {
  const atrArr = atr(candles1h);
  // sma가 null(앞 14봉)을 0으로 섞지 않게 — 백테스트와 같은 처리: 치환 후 앞 114봉 무효.
  const atrMA100 = sma(atrArr.map((v) => v ?? 0), 100);
  for (let i = 0; i < Math.min(114, atrMA100.length); i += 1) atrMA100[i] = null;
  return { candles: candles1h, atr: atrArr, atrMA100 };
}

/** 하위봉 i 시점에 "마감 완료된" 최신 일봉 인덱스 — 없으면 -1. */
function htfIdx(i, c) {
  let d = -1;
  while (d + 1 < c.daily.length && c.daily[d + 1].t + CFG.dayMs <= c.candles[i].t) d += 1;
  return d;
}

const SIGNALS = {
  dch: {
    fire: (i, c) => {
      if (c.ll20[i] === null || c.candles[i].c >= c.ll20[i]) return false;
      const d = htfIdx(i, c);
      return d >= 0 && c.dailySma50[d] !== null && c.daily[d].c < c.dailySma50[d];
    },
  },
  mcv: {
    fire: (i, c) =>
      c.macdSig[i - 1] !== null &&
      c.macdLine[i - 1] <= c.macdSig[i - 1] &&
      c.macdLine[i] > c.macdSig[i] &&
      c.volMA[i] !== null &&
      c.candles[i].v >= 1.5 * c.volMA[i],
  },
  ibq: {
    fire: (i, c) =>
      i >= 2 &&
      c.candles[i - 1].h < c.candles[i - 2].h &&
      c.candles[i - 1].l > c.candles[i - 2].l &&
      c.candles[i].c > c.candles[i - 2].h &&
      c.atr[i] !== null &&
      c.atrMA100[i] !== null &&
      c.atr[i] < c.atrMA100[i],
  },
};

function snapshot(key, i, c) {
  const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
  if (key === "ibq") {
    return {
      close: c.candles[i].c,
      atr: r1(c.atr[i]),
      atrMA100: r1(c.atrMA100[i]),
      motherHigh: i >= 2 ? c.candles[i - 2].h : null,
    };
  }
  const d = htfIdx(i, c);
  return {
    close: c.candles[i].c,
    atr: r1(c.atr[i]),
    ll20: r1(c.ll20[i]),
    macd: c.macdLine[i] === null ? null : r2(c.macdLine[i]),
    macdSig: c.macdSig[i] === null ? null : r2(c.macdSig[i]),
    volX: c.volMA[i] ? r2(c.candles[i].v / c.volMA[i]) : null,
    dailyClose: d >= 0 ? c.daily[d].c : null,
    dailySma50: d >= 0 && c.dailySma50[d] !== null ? r1(c.dailySma50[d]) : null,
  };
}

/* ---------- 사이클 ---------- */

async function runCycle(client, state) {
  const summary = { actions: [], evaluated: [], stale: [] };

  const candles4h = await client.candles(CFG.instId, "4H", CFG.candleLimit);
  const candles1h = await client.candles(CFG.instId, "1H", CFG.candleLimit);
  const daily = await client.candles(CFG.instId, "1D", CFG.candleLimit);
  if (candles4h.length < 60 || candles1h.length < 150 || daily.length < 60) {
    throw new Error(`캔들 부족(4H ${candles4h.length}·1H ${candles1h.length}·1D ${daily.length}) — 데이터 응답 이상`);
  }
  for (const [tf, arr] of [["4H", candles4h], ["1H", candles1h]]) {
    const last = arr[arr.length - 1];
    if (Date.now() > last.t + 2 * CFG.tfs[tf].ms + 30_000) summary.stale.push(tf);
  }

  const ctxByTf = { "4H": buildCtx4h(candles4h, daily), "1H": buildCtx1h(candles1h) };
  const candlesByTf = { "4H": candles4h, "1H": candles1h };

  // 열린 포지션 가상 체결 — 엔진 페이퍼 경로와 같은 보수 규칙, 포지션의 봉으로 판정.
  for (const [key, pos] of Object.entries({ ...state.positions })) {
    const bars = candlesByTf[pos.tf].filter((c) => c.t >= pos.entryTs);
    if (bars.length === 0) continue;
    if (bars[0].t > pos.entryTs) {
      appendLog(BOOK, "decisions", { member: key, warn: "진입 봉이 캔들 창 밖 — 수동 정리 필요(포지션 유지 중)" });
      summary.actions.push(`경고: ${pos.name} 진입 봉이 조회 창 밖 — data/state-cand 수동 확인 필요`);
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
    const netPct = (grossPct - CFG.feePct) * pos.lev;
    state.equity = r2(state.equity + (pos.eqAtEntry * netPct) / 100);
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
      stop: r2(pos.stop),
      target: r2(pos.target),
      signal: pos.signal,
      lev: r2(pos.lev),
      netPct: r3(netPct),
      eqAtEntry: pos.eqAtEntry,
      pnlUsd: r2((pos.eqAtEntry * netPct) / 100),
      equityAfter: state.equity,
    });
    summary.actions.push(`청산 ${pos.name} ${closed.type} → 잔고 $${state.equity}`);
  }

  // 새 마감 봉 평가 — 놓친 봉은 기록만, 진입은 최신 봉의 신호로만.
  for (const [key, m] of Object.entries(CFG.members)) {
    const ctx = ctxByTf[m.tf];
    const candles = ctx.candles;
    const lastIdx = candles.length - 1;
    const lastEval = state.lastBarTs[key] ?? candles[lastIdx - 1].t;
    for (let i = 2; i <= lastIdx; i += 1) {
      if (candles[i].t <= lastEval) continue;
      const isLatest = i === lastIdx;
      const fired = SIGNALS[key].fire(i, ctx);
      let action = "none";
      let skip = null;
      if (fired && !isLatest) {
        action = "missed";
        skip = "봇 정지 중 지나간 신호 — 진입하지 않음";
      } else if (fired) {
        const openCount = Object.keys(state.positions).length;
        const openRisk = Object.values(state.positions).reduce((s, p) => s + p.riskPct, 0);
        if (state.positions[key]) {
          action = "skip";
          skip = "이 기준의 포지션 보유 중";
        } else if (openCount >= CFG.maxConcurrent) {
          action = "skip";
          skip = `동시 포지션 상한 ${CFG.maxConcurrent}개`;
        } else if (openRisk + CFG.riskPct > CFG.maxOpenRiskPct) {
          action = "skip";
          skip = `동시 리스크 상한 ${CFG.maxOpenRiskPct}% 초과(현재 ${openRisk}%)`;
        } else {
          await enter(client, state, key, m, ctx, i, summary);
          action = "enter";
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
      if (isLatest || fired) {
        summary.evaluated.push(
          `${key}@${new Date(candles[i].t).toISOString().slice(0, 16)} ${fired ? "신호" : "-"}${skip ? ` (${skip})` : ""}`,
        );
      }
    }
    state.lastBarTs[key] = candles[lastIdx].t;
  }

  appendLog(BOOK, "equity", { equity: state.equity, open: Object.keys(state.positions) });
  saveState(state);
  summary.equity = state.equity;
  summary.openPositions = Object.keys(state.positions);
  return summary;
}

async function enter(client, state, key, m, ctx, i, summary) {
  const price = await client.lastPrice(CFG.instId);
  const { stop, target, stopDistPct } = exitLevels(price, m.side, m.exit, ctx.atr[i]);
  const lev = Math.min(CFG.maxLev, CFG.riskPct / (stopDistPct + CFG.feePct));

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
    riskPct: CFG.riskPct,
    eqAtEntry: r2(state.equity),
    maxHold: CFG.tfs[m.tf].maxHold,
    openedAt: Date.now(),
    signal: snapshot(key, i, ctx),
  };
  state.positions[key] = pos;
  saveState(state);
  appendLog(BOOK, "trades", { type: "open", ...pos, lev: r2(lev) });
  summary.actions.push(
    `진입 ${m.name} ${m.side} @ ${price} (레버 ${r2(lev)}배, 손절 ${r2(stop)}, 목표 ${r2(target)})`,
  );
}

/* ---------- 실행 ---------- */

const loop = process.argv.includes("--loop");
const client = new OkxClient("paper"); // 공개 API만 쓴다 — 키 불필요, 주문 코드 없음.
const state = loadState(BOOK, CFG.startEquity);
if (state.equity === null || state.equity === undefined) state.equity = CFG.startEquity;

const TAG = "[CAND]";
console.log(`후보 전방 검증 (페이퍼·주문 없음) — ${Object.keys(CFG.members).join(", ")} · 리스크 ${CFG.riskPct}% · 1H 주기`);

async function once() {
  const started = new Date().toISOString();
  try {
    const s = await runCycle(client, state);
    console.log(`[${started}] cand 사이클 완료 — 잔고 $${s.equity} · 열린 포지션 ${s.openPositions.join(", ") || "없음"}`);
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
