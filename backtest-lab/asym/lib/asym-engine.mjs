/**
 * 비대칭 페이오프 엔진 — "손실은 하방으로 고정, 수익은 위로 열어둔다".
 *
 * 기존 lib/engine.mjs 와 갈라지는 지점은 셋이다.
 *  ① 상방 무제한: 고정 목표가(tp)가 기본값 null. 청산은 추적손절·시간·창끝만.
 *  ② 보유 무제한(에 가까움): maxHold 를 기존의 10~60배로 연다. 러너가 살 수 있는 우리.
 *  ③ 포지션이 변한다: 부분익절(줄임)과 피라미딩(늘림)을 같은 회계로 다룬다.
 *
 * 회계 규약 — 모든 손익은 "진입 시점 명목(1유닛)" 대비 %다.
 *   로트 i 가 가중치 w_i 로 열려 있을 때, 가격 p 에서의 미실현 포함 손익:
 *     openPnl(p) = 실현% + Σ w_i · (p − e_i)/e_i · dir · 100
 *   피라미딩으로 w 합이 3이 되면 손익도 최대 3배가 된다 — 위험도 3배라는 뜻이고,
 *   그 위험은 MAE 에 그대로 잡힌다. 사이징은 진입 시점 1유닛 손절폭으로 한다(실전과 동일).
 *
 * 봉 내부 순서(비관적): 손절 → 시간컷 → 부분익절 → 증량 → 추적 갱신.
 * 손절과 익절이 같은 봉에 걸리면 손절이 이긴다. 봉 안의 경로를 모르기 때문이다.
 */

const x = (v) => v !== null && v !== undefined && Number.isFinite(v);

/**
 * @param ext { atrN, chHigh, chLow, dcHigh, dcLow } — 추적손절이 참조하는 배열.
 *            전부 "현재 봉 제외" 극값이므로 봉 j 마감 후 j+1 값을 쓰면 미래 참조가 없다.
 */
export function walkAsym(candles, ext, entryIdx, entry, side, plan, N, maxHold) {
  const dir = side === "long" ? 1 : -1;
  const initSlDist = plan.initSl * N;
  const R = (initSlDist / entry) * 100; // 초기 리스크 % = 1R
  if (!(R > 0)) return null;

  let lots = [{ e: entry, w: 1 }];
  let realized = 0;
  let stop = entry - dir * initSlDist;
  const stopFloor = stop; // 하방 고정선 — 절대 되돌리지 않는다(검증용으로 남긴다)
  const target = plan.tp !== null && plan.tp !== undefined ? entry + dir * plan.tp * N : null;

  const openPnl = (p) => realized + lots.reduce((s, lo) => s + (lo.w * ((p - lo.e) / lo.e) * dir * 100), 0);

  const last = Math.min(entryIdx + maxHold - 1, candles.length - 1);
  let exitIdx = last;
  let exitType = "time";
  let maePct = 0;
  let mfePct = 0;
  let peakW = 1;
  let addCount = 0;
  let lastAddPx = entry;
  let partialDone = false;
  let beArmed = false;
  let trailArmed = plan.trailArmR === 0 || plan.trailArmR === null || plan.trailArmR === undefined;
  let exitPrice = entry;
  let stopClamps = 0; // 검증용 — 추적선이 느슨해지려 한 횟수. 바닥이 막아낸 횟수다.

  for (let j = entryIdx; j <= last; j += 1) {
    const bar = candles[j];
    const advPx = dir === 1 ? bar.l : bar.h;
    const favPx = dir === 1 ? bar.h : bar.l;

    maePct = Math.max(maePct, -openPnl(advPx));
    mfePct = Math.max(mfePct, openPnl(favPx));

    const hitSl = dir === 1 ? bar.l <= stop : bar.h >= stop;
    if (hitSl) {
      // 갭으로 시가가 이미 스톱 너머면 시가 체결. 스톱 가격 체결은 낙관이다.
      const fill = dir === 1 ? Math.min(stop, bar.o) : Math.max(stop, bar.o);
      realized = openPnl(fill);
      exitPrice = fill;
      lots = [];
      exitIdx = j;
      exitType = stop === stopFloor ? "sl" : "trail";
      maePct = Math.max(maePct, -realized, 0);
      break;
    }

    if (target !== null && (dir === 1 ? bar.h >= target : bar.l <= target)) {
      realized = openPnl(target);
      exitPrice = target;
      lots = [];
      exitIdx = j;
      exitType = "tp";
      break;
    }

    // 시간컷 — K봉 안에 최소 전진(needR)을 못 하면 죽은 돈으로 보고 종가 청산.
    if (plan.timeCut && j - entryIdx + 1 >= plan.timeCut.bars && mfePct < plan.timeCut.needR * R) {
      realized = openPnl(bar.c);
      exitPrice = bar.c;
      lots = [];
      exitIdx = j;
      exitType = "cut";
      break;
    }

    // 부분익절 — 1R 도달분의 frac 을 덜어낸다. 남은 몫이 러너다.
    if (plan.partial && !partialDone) {
      const trig = entry + dir * plan.partial.atR * initSlDist;
      if (dir === 1 ? bar.h >= trig : bar.l <= trig) {
        const f = plan.partial.frac;
        for (const lo of lots) {
          realized += lo.w * f * ((trig - lo.e) / lo.e) * dir * 100;
          lo.w *= 1 - f;
        }
        partialDone = true;
      }
    }

    // 피라미딩 — 직전 증량가에서 stepN 만큼 더 갔을 때 1유닛 추가(최대 max회).
    if (plan.pyramid && addCount < plan.pyramid.max) {
      const trig = lastAddPx + dir * plan.pyramid.stepN * N;
      if (dir === 1 ? bar.h >= trig : bar.l <= trig) {
        lots.push({ e: trig, w: 1 });
        lastAddPx = trig;
        addCount += 1;
        peakW = Math.max(peakW, lots.reduce((s, lo) => s + lo.w, 0));
        // 터틀 규약: 스톱은 최근 유닛 기준 initSl 만큼 뒤로. 뒤로 물러나지는 않는다.
        const cand = trig - dir * initSlDist;
        stop = dir === 1 ? Math.max(stop, cand) : Math.min(stop, cand);
        // capRisk — 증량 후에도 총 하방이 초기 1R을 넘지 않도록 스톱을 끌어올린다.
        // openPnl(p) = realized + dir·100·(p·A − B) 는 p에 대해 단조이므로 역산이 닫힌다.
        if (plan.capRisk) {
          const A = lots.reduce((s2, lo) => s2 + lo.w / lo.e, 0);
          const B = lots.reduce((s2, lo) => s2 + lo.w, 0);
          if (A > 0) {
            const pCap = (B + (-R - realized) / (dir * 100)) / A;
            stop = dir === 1 ? Math.max(stop, pCap) : Math.min(stop, pCap);
          }
        }
      }
    }

    if (plan.beArmR !== null && plan.beArmR !== undefined && !beArmed && mfePct >= plan.beArmR * R) {
      beArmed = true;
      stop = dir === 1 ? Math.max(stop, entry) : Math.min(stop, entry);
    }
    if (!trailArmed && mfePct >= plan.trailArmR * R) trailArmed = true;

    // 추적 갱신 — 봉 j 마감 후. j+1 인덱스의 "현재 봉 제외" 극값이 곧 [.., j] 구간이다.
    if (trailArmed && plan.trail && j + 1 < candles.length) {
      let cand = null;
      const k = j + 1;
      if (plan.trail.type === "chandelier") {
        const a = ext.atrN[j];
        const hh = dir === 1 ? ext.chHigh[k] : ext.chLow[k];
        if (x(a) && x(hh)) cand = dir === 1 ? hh - plan.trail.mult * a : hh + plan.trail.mult * a;
      } else if (plan.trail.type === "atr") {
        const a = ext.atrN[j];
        const hh = dir === 1 ? ext.chHigh[k] : ext.chLow[k];
        if (x(a) && x(hh)) cand = dir === 1 ? Math.max(hh, bar.h) - plan.trail.mult * a : Math.min(hh, bar.l) + plan.trail.mult * a;
      } else if (plan.trail.type === "donchian") {
        const dv = dir === 1 ? ext.dcLow[k] : ext.dcHigh[k];
        if (x(dv)) cand = dv;
      }
      if (cand !== null) {
        if (dir === 1 ? cand < stop : cand > stop) stopClamps += 1;
        stop = dir === 1 ? Math.max(stop, cand) : Math.min(stop, cand);
      }
    }
  }

  if (lots.length) {
    const p = candles[exitIdx].c;
    realized = openPnl(p);
    exitPrice = p;
    lots = [];
    if (exitIdx === candles.length - 1 && exitIdx - entryIdx + 1 < maxHold) exitType = "open";
  }

  return {
    exitIdx,
    exitPrice,
    exitType,
    grossPct: realized,
    rMultiple: realized / R,
    slDistPct: R,
    maePct: Math.max(0, maePct),
    mfePct: Math.max(0, mfePct),
    peakUnits: peakW,
    adds: addCount,
    stopClamps,
  };
}

/** 신호 인덱스 → 거래 배열. 한 전략당 동시 포지션 1개(기존 규약 유지). */
export function simulateAsym(candles, ctx, ext, signalIdx, side, plan, maxHold) {
  const trades = [];
  let openUntil = -1;
  for (const i of signalIdx) {
    if (i <= openUntil) continue;
    if (!x(ctx.atr[i]) || i + 1 >= candles.length) continue;
    const entryIdx = i + 1;
    const entry = candles[entryIdx].o;
    if (!(entry > 0)) continue;
    const r = walkAsym(candles, ext, entryIdx, entry, side, plan, ctx.atr[i], maxHold);
    if (!r) continue;
    trades.push({
      side,
      entryAt: candles[entryIdx].t,
      exitAt: candles[r.exitIdx].t,
      entry,
      exit: Math.round(r.exitPrice * 100) / 100,
      exitType: r.exitType,
      holdBars: r.exitIdx - entryIdx + 1,
      slPct: Math.round(r.slDistPct * 1e4) / 1e4,
      maePct: Math.round(r.maePct * 1e4) / 1e4,
      mfePct: Math.round(r.mfePct * 1e4) / 1e4,
      grossPct: Math.round(r.grossPct * 1e4) / 1e4,
      rMultiple: Math.round(r.rMultiple * 1e3) / 1e3,
      peakUnits: r.peakUnits,
      stopClamps: r.stopClamps,
    });
    openUntil = r.exitIdx;
  }
  return trades;
}

/**
 * 순손익 % — 왕복 비용은 "실제로 오간 명목"에 비례해야 한다.
 * 피라미딩 3유닛은 왕복 수수료도 3배다. 이것을 빼먹으면 피라미딩이 공짜로 이긴다.
 */
export function netPctAsym(trade, feePct, slipPct, fundingCum) {
  const turnover = trade.peakUnits ?? 1;
  const fund = fundingCum ? fundingCum(trade.entryAt, trade.exitAt) : 0;
  const fundCost = (trade.side === "long" ? fund : -fund) * turnover;
  return trade.grossPct - (feePct + slipPct) * turnover - fundCost;
}
