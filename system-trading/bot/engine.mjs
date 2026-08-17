/**
 * 엔진 — 한 사이클: 캔들 수집 → 열린 포지션 관리 → 새 마감 봉 평가 → 진입 → 기록.
 *
 * 백테스트와의 동치성이 이 파일의 존재 이유다:
 *   · 판정은 마감 봉에서만 (미확정 봉 배제)
 *   · 진입은 마감 직후 시장가 ≈ 다음 봉 시가
 *   · 손절 우선, 갭이면 시가 체결 (페이퍼 시뮬레이션)
 *   · 사이징 L = min(10, 리스크% ÷ (손절폭% + 0.1%)), 진입 시점 실현 잔고 기준
 *   · 한 기준 한 포지션, 동시 포지션·리스크 합 상한
 *
 * 상태는 위험한 전이(주문 접수·청산 확정) 직후 즉시 저장한다 —
 * 크래시가 나도 거래소 포지션과 state 가 어긋난 채 재평가·중복 진입으로 가지 않게.
 */
import { CONFIG as cfg } from "./config.mjs";
import { SIGNALS, buildCtx, exitLevels, snapshot } from "./signals.mjs";
import { appendLog, saveState } from "./state-db.mjs";

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const TFS = [...new Set(Object.values(cfg.members).map((m) => m.tf))];

export async function runCycle(client, state) {
  const summary = { mode: state.mode, actions: [], evaluated: [], stale: [] };

  const candlesByTf = {};
  for (const tf of TFS) {
    candlesByTf[tf] = await client.candles(cfg.instId, tf, cfg.candleLimit);
    if (candlesByTf[tf].length < 60) throw new Error(`캔들 부족(${tf}: ${candlesByTf[tf].length}개) — 데이터 응답 이상`);
    // 확정 지연 감지 — 봉 정렬(1D는 UTC+8)에 의존하지 않는 규칙:
    // 다음 봉의 마감시각(last.t + 2×봉주기)에서 30초가 지났는데도 새 확정 봉이 없으면 지연이다.
    // 유예를 길게 잡으면 "방금 마감한 봉의 확정 지연"을 재시도가 영영 못 잡는다.
    const last = candlesByTf[tf][candlesByTf[tf].length - 1];
    if (Date.now() > last.t + 2 * cfg.barMs[tf] + 30_000) summary.stale.push(tf);
  }
  const ctxByTf = Object.fromEntries(TFS.map((tf) => [tf, buildCtx(candlesByTf[tf])]));

  if (state.mode === "paper") await managePaper(state, candlesByTf, summary);
  else await manageLive(client, state, summary);

  for (const [key, m] of Object.entries(cfg.members)) {
    const ctx = ctxByTf[m.tf];
    const candles = ctx.candles;
    const lastIdx = candles.length - 1;
    // 첫 실행이면 최신 봉만 본다. 이후에는 놓친 봉까지 순회하되(꺼져 있던 동안의 기록),
    // 진입은 최신 봉의 신호로만 한다 — 몇 시간 지난 신호를 지금 가격에 사는 건 다른 전략이다.
    const lastEval = state.lastBarTs[key] ?? candles[lastIdx - 1].t;
    for (let i = 1; i <= lastIdx; i += 1) {
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
        } else if (openCount >= cfg.maxConcurrent) {
          action = "skip";
          skip = `동시 포지션 상한 ${cfg.maxConcurrent}개`;
        } else if (openRisk + cfg.riskPct > cfg.maxOpenRiskPct) {
          action = "skip";
          skip = `동시 리스크 상한 ${cfg.maxOpenRiskPct}% 초과(현재 ${openRisk}%)`;
        } else {
          const ok = await enter(client, state, key, m, ctx, i, summary);
          action = ok ? "enter" : "skip";
          if (!ok) skip = "사이징 불가(최소 수량·증거금)";
        }
      }
      // 신호가 없어도 남긴다 — "그때 왜 안 들어갔나"가 고도화의 절반이다.
      await appendLog(state.mode, "decisions", {
        member: key,
        tf: m.tf,
        barTs: candles[i].t,
        fired,
        action,
        skip,
        indicators: snapshot(i, ctx),
      });
      if (isLatest || fired) {
        summary.evaluated.push(
          `${key}@${new Date(candles[i].t).toISOString().slice(0, 16)} ${fired ? "신호" : "-"}${skip ? ` (${skip})` : ""}`,
        );
      }
    }
    state.lastBarTs[key] = candles[lastIdx].t;
  }

  const equity = state.mode === "paper" ? state.equity : await client.equityUsd().catch(() => null);
  await appendLog(state.mode, "equity", { equity, open: Object.keys(state.positions) });
  await saveState(state);
  summary.equity = equity;
  summary.openPositions = Object.keys(state.positions);
  return summary;
}

/* ---------- 진입 ---------- */

async function enter(client, state, key, m, ctx, i, summary) {
  // 마감 직후 실행되므로 지금 가격이 곧 "다음 봉 시가"의 근사다.
  const price = await client.lastPrice(cfg.instId);
  const { stop, target, stopDistPct } = exitLevels(price, m.side, m.exit, ctx.atr[i]);
  const lev = Math.min(cfg.maxLev, cfg.riskPct / (stopDistPct + cfg.feePct));
  const equity = state.mode === "paper" ? state.equity : await client.equityUsd();

  const pos = {
    member: key,
    name: m.name,
    tf: m.tf,
    side: m.side,
    signalTs: ctx.candles[i].t,
    entryTs: ctx.candles[i].t + cfg.barMs[m.tf],
    entryPrice: price,
    stop,
    target,
    stopDistPct: r3(stopDistPct),
    lev, // 반올림 없이 저장 — 손익 계산이 백테스트와 어긋나지 않게. 표시용 반올림은 로그에서.
    riskPct: cfg.riskPct,
    eqAtEntry: r2(equity),
    maxHold: cfg.maxHoldBars[m.tf],
    openedAt: Date.now(),
    // 판정 시점의 지표 — "왜 들어갔나"가 거래 기록에 붙어 다녀야 복기가 된다.
    signal: snapshot(i, ctx),
  };

  if (state.mode !== "paper") {
    const inst = await client.instrument(cfg.instId);
    // 증거금 실현 가능성 — 거래소 레버는 상한(10배)으로 고정하고, 필요 증거금이
    // 가용분(잔고 90% − 열린 포지션 증거금)을 넘으면 명목가를 줄인다. 리스크는 줄어드는 방향.
    const usedMargin = Object.values(state.positions).reduce(
      (s, p) => s + (p.notionalUsd ?? 0) / cfg.maxLev,
      0,
    );
    const availMargin = equity * 0.9 - usedMargin;
    let notional = equity * lev;
    if (notional / cfg.maxLev > availMargin) {
      notional = Math.max(0, availMargin * cfg.maxLev);
      summary.actions.push(`증거금 한도로 명목가 축소: ${m.name} $${r2(equity * lev)} → $${r2(notional)}`);
    }
    const lots = Math.floor(notional / price / inst.ctVal / inst.lotSz);
    const szNum = lots * inst.lotSz;
    if (szNum < inst.minSz || szNum <= 0) {
      // 최소 수량 미달 — 키우면 리스크 상한이 깨진다. 건너뛰는 것이 맞다.
      await appendLog(state.mode, "decisions", { member: key, warn: `주문 수량 미달(sz=${szNum}) — 진입 생략` });
      return false;
    }
    const sz = szNum.toFixed(inst.szDecimals);
    const posSide = m.side;
    await client.setLeverage(cfg.instId, cfg.maxLev, posSide, cfg.marginMode);
    const algoClOrdId = `qa${key}${Date.now()}`;
    pos.posSide = posSide;
    pos.sz = sz;
    pos.notionalUsd = r2(notional);
    pos.algoClOrdId = algoClOrdId;
    pos.ordId = await client.openWithBracket({
      instId: cfg.instId,
      side: m.side === "long" ? "buy" : "sell",
      posSide,
      sz,
      stop,
      target,
      mgnMode: cfg.marginMode,
      algoClOrdId,
      tickSz: inst.tickSz,
      pxDecimals: inst.pxDecimals,
    });
  }

  state.positions[key] = pos;
  await saveState(state); // 주문이 나간 즉시 — 여기서 죽어도 재시작이 포지션을 안다.
  await appendLog(state.mode, "trades", { type: "open", ...pos, lev: r2(lev) });
  summary.actions.push(
    `진입 ${m.name} ${m.side} @ ${price} (레버 ${r2(lev)}배, 손절 ${r2(stop)}, 목표 ${r2(target)})`,
  );
  return true;
}

/* ---------- 페이퍼 — 마감 봉으로 가상 체결 (백테스트와 같은 보수 규칙) ---------- */

async function managePaper(state, candlesByTf, summary) {
  for (const [key, pos] of Object.entries({ ...state.positions })) {
    const bars = candlesByTf[pos.tf].filter((c) => c.t >= pos.entryTs);
    // 진입 봉이 아직 마감 전이면(특히 1D는 진입 후 최대 하루) 기다리는 게 정상이다.
    if (bars.length === 0) continue;
    if (bars[0].t > pos.entryTs) {
      // 캔들 창(300봉)이 진입 봉을 지나쳤다 — 오래 꺼져 있었던 것. 체결을 신뢰할 수 없다.
      await appendLog(state.mode, "decisions", {
        member: key,
        warn: "진입 봉이 캔들 창 밖 — 수동 정리 필요(포지션 유지 중)",
      });
      summary.actions.push(`경고: ${pos.name} 진입 봉이 조회 창 밖 — data/state 수동 확인 필요`);
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
    const netPct = (grossPct - cfg.feePct) * pos.lev;
    // 복리 검토와 같은 회계 — 손익은 "진입 시점 잔고" 기준이다(병행 중 겹칠 때 갈린다).
    state.equity = r2(state.equity + (pos.eqAtEntry * netPct) / 100);
    delete state.positions[key];
    await saveState(state);
    await appendLog(state.mode, "trades", {
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
}

/* ---------- 데모·라이브 — 브래킷 상세(order-algo)로 기준별 대조 ---------- */

async function manageLive(client, state, summary) {
  const keys = Object.keys(state.positions);
  if (keys.length === 0) {
    await warnOrphans(client, state, summary);
    return;
  }

  for (const key of keys) {
    const pos = state.positions[key];
    const det = await client.algoDetails(pos.algoClOrdId);

    if (!det || det.error) {
      // 접수 직후 조회 지연일 수도, 키·권한 문제일 수도 있다 — 원인을 로그에 남긴다.
      // 오류가 반복되면 일일 점검에서 잡아야 한다(브래킷 보호는 거래소에 살아 있다).
      await appendLog(state.mode, "decisions", {
        member: key,
        warn: `브래킷 조회 실패 — 다음 사이클 재시도${det?.error ? ` (${det.error})` : ""}`,
      });
      continue;
    }

    if (det.state === "live" || det.state === "pause") {
      // 아직 열려 있다 — 시한만 본다.
      const deadline = pos.entryTs + pos.maxHold * cfg.barMs[pos.tf];
      if (Date.now() >= deadline) {
        await client.cancelAlgo(cfg.instId, det.algoId);
        await client.closeMarket({ instId: cfg.instId, posSide: pos.posSide, sz: pos.sz, mgnMode: cfg.marginMode });
        await finalizeLive(state, key, pos, { price: await client.lastPrice(cfg.instId), type: "time" }, summary);
      }
      continue;
    }

    if (det.state === "effective") {
      // 손절 또는 목표가 걸렸다 — 어느 다리가 걸렸는지에 맞는 가격을 쓴다.
      const type = det.actualSide === "tp" ? "tp" : det.actualSide === "sl" ? "sl" : "algo";
      const px = Number(
        det.actualPx || (type === "tp" ? det.tpTriggerPx : det.slTriggerPx) || pos.stop,
      );
      await finalizeLive(state, key, pos, { price: px, type }, summary);
      continue;
    }

    // canceled 등 — 브래킷이 걷혔는데 포지션이 남아 있으면 보호가 없다는 뜻이다.
    const open = await client.positions(cfg.instId);
    const still = open.some((p) => p.posSide === pos.posSide && Number(p.pos) > 0);
    if (still) {
      await appendLog(state.mode, "decisions", { member: key, warn: "브래킷 취소됨·포지션 존재 — 즉시 수동 확인 필요" });
      summary.actions.push(`경고: ${pos.name} 보호(브래킷) 없음 — 거래소에서 손절·목표 수동 재설정 필요`);
    } else {
      await finalizeLive(state, key, pos, { price: await client.lastPrice(cfg.instId), type: "unknown" }, summary);
    }
  }

  await warnOrphans(client, state, summary);
}

/** state 가 모르는 거래소 포지션 — 크래시·수동 개입의 흔적. 자동 처리하지 않고 알린다. */
async function warnOrphans(client, state, summary) {
  try {
    const open = await client.positions(cfg.instId);
    for (const side of ["long", "short"]) {
      const exch = open
        .filter((p) => p.posSide === side)
        .reduce((s, p) => s + Number(p.pos), 0);
      const known = Object.values(state.positions)
        .filter((p) => p.posSide === side)
        .reduce((s, p) => s + Number(p.sz ?? 0), 0);
      if (exch > known + 1e-9) {
        await appendLog(state.mode, "decisions", {
          warn: `미추적 ${side} 포지션 ${exch - known} 계약 — 수동 확인 필요`,
        });
        summary.actions.push(`경고: state에 없는 ${side} 포지션 감지(${exch - known} 계약) — 수동 확인 필요`);
      }
    }
  } catch {
    // 조회 실패는 치명적이지 않다 — 다음 사이클에 다시 본다.
  }
}

async function finalizeLive(state, key, pos, closed, summary) {
  const dir = pos.side === "long" ? 1 : -1;
  const grossPct = ((closed.price - pos.entryPrice) / pos.entryPrice) * dir * 100;
  const netPct = (grossPct - cfg.feePct) * pos.lev;
  delete state.positions[key];
  await saveState(state);
  await appendLog(state.mode, "trades", {
    type: "close",
    tradeId: `${key}-${pos.entryTs}`,
    member: key,
    name: pos.name,
    side: pos.side,
    entryTs: pos.entryTs,
    exitTs: Date.now(),
    entryPrice: pos.entryPrice,
    exitPrice: r2(closed.price),
    exitType: closed.type,
    stop: r2(pos.stop),
    target: r2(pos.target),
    signal: pos.signal,
    lev: r2(pos.lev),
    netPct: r3(netPct),
    eqAtEntry: pos.eqAtEntry,
    pnlUsd: r2((pos.eqAtEntry * netPct) / 100),
    note: "실현손익은 거래소 체결 기준이 정본 — 이 수치는 추정치",
  });
  summary.actions.push(`청산 ${pos.name} ${closed.type} @ ${r2(closed.price)}`);
}
