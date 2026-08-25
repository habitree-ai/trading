/**
 * 시뮬레이터 — 신호 → 진입 → 청산 → 거래 레코드.
 *
 * 체결 규약(README §1-3):
 *  · 신호는 봉 i 마감 판정, 진입은 봉 i+1 시가.
 *  · 손절·목표가 같은 봉에 걸리면 손절. 봉 내부 경로를 모르니 불리하게 본다.
 *  · 전략당 동시 포지션 1개.
 *  · 창 끝에 열려 있으면 exitType="open" — 통계에서 뺀다.
 *
 * MAE(최대 역행폭)를 거래마다 남긴다. 레버리지 단계에서 강제청산 판정이
 * 여기서 나온다 — 사후에 다시 계산할 수 없는 값이라 지금 기록해야 한다.
 */

/** 한 진입의 청산까지 — 손절/목표/추적/시한. */
function walkExit(candles, entryIdx, entry, side, exit, atrAtSignal, maxHold) {
  const dir = side === "long" ? 1 : -1;
  const slDist = exit.sl * atrAtSignal;
  const tpDist = exit.tp !== null ? exit.tp * atrAtSignal : null;
  const trailDist = exit.trail !== null ? exit.trail * atrAtSignal : null;

  let stop = entry - dir * slDist;
  const target = tpDist !== null ? entry + dir * tpDist : null;

  const last = Math.min(entryIdx + maxHold - 1, candles.length - 1);
  let exitIdx = last;
  let exitPrice = candles[last].c;
  let exitType = "time";
  let maePct = 0; // 진입가 대비 역행폭 %(양수)
  let mfePct = 0;
  let best = entry; // 추적손절 기준 극값

  for (let j = entryIdx; j <= last; j += 1) {
    const bar = candles[j];
    const adverse = dir === 1 ? ((entry - bar.l) / entry) * 100 : ((bar.h - entry) / entry) * 100;
    const favor = dir === 1 ? ((bar.h - entry) / entry) * 100 : ((entry - bar.l) / entry) * 100;

    const hitSl = dir === 1 ? bar.l <= stop : bar.h >= stop;
    const hitTp = target !== null && (dir === 1 ? bar.h >= target : bar.l <= target);

    if (hitSl) {
      exitIdx = j;
      // 갭으로 시가가 이미 손절 너머면 시가 체결 — 스톱 가격은 낙관이다.
      exitPrice = dir === 1 ? Math.min(stop, bar.o) : Math.max(stop, bar.o);
      exitType = "sl";
      // 체결가까지의 역행폭. 추적손절이 이익 구간에서 걸리면 이 값은 음수이므로
      // 0으로 자른다 — 이익을 역행폭으로 세면 레버리지·청산 판정이 통째로 망가진다.
      const adverseAtFill = dir === 1 ? ((entry - exitPrice) / entry) * 100 : ((exitPrice - entry) / entry) * 100;
      maePct = Math.max(maePct, adverseAtFill, 0);
      break;
    }
    maePct = Math.max(maePct, adverse);
    mfePct = Math.max(mfePct, favor);

    if (hitTp) {
      exitIdx = j;
      exitPrice = target;
      exitType = "tp";
      break;
    }

    // 추적손절 — 이번 봉의 극값으로 스톱을 당긴다. 당김은 다음 봉부터 유효.
    if (trailDist !== null) {
      best = dir === 1 ? Math.max(best, bar.h) : Math.min(best, bar.l);
      const cand = best - dir * trailDist;
      stop = dir === 1 ? Math.max(stop, cand) : Math.min(stop, cand);
    }
  }

  if (exitType === "time" && exitIdx === candles.length - 1 && exitIdx - entryIdx + 1 < maxHold) {
    exitType = "open";
  }

  return {
    exitIdx,
    exitPrice,
    exitType,
    slDistPct: (slDist / entry) * 100,
    maePct,
    mfePct,
    grossPct: ((exitPrice - entry) / entry) * dir * 100,
  };
}

/**
 * 신호 인덱스 → 거래 배열.
 * signalIdx 는 미리 계산해서 넘긴다 — 청산 기하 6종이 같은 신호를 공유하므로
 * 신호 판정을 6번 다시 하는 것은 순수한 낭비다.
 */
export function simulate(candles, ctx, signalIdx, side, exit, maxHold) {
  const trades = [];
  let openUntil = -1;
  for (const i of signalIdx) {
    if (i <= openUntil) continue;
    if (ctx.atr[i] === null || i + 1 >= candles.length) continue;
    const entryIdx = i + 1;
    const entry = candles[entryIdx].o;
    if (!(entry > 0)) continue;
    const r = walkExit(candles, entryIdx, entry, side, exit, ctx.atr[i], maxHold);
    trades.push({
      side,
      entryAt: candles[entryIdx].t,
      exitAt: candles[r.exitIdx].t,
      entry,
      exit: r.exitPrice,
      exitType: r.exitType,
      holdBars: r.exitIdx - entryIdx + 1,
      slPct: Math.round(r.slDistPct * 1e4) / 1e4,
      maePct: Math.round(r.maePct * 1e4) / 1e4,
      mfePct: Math.round(r.mfePct * 1e4) / 1e4,
      grossPct: Math.round(r.grossPct * 1e4) / 1e4,
    });
    openUntil = r.exitIdx;
  }
  return trades;
}

/** 신호 인덱스 사전 계산 — (계열 × 방향 × 필터) 하나당 한 번. */
export function signalIndices(ctx, fn, filterFn, side, warmup) {
  const out = [];
  const n = ctx.n;
  for (let i = warmup; i < n - 1; i += 1) {
    if (ctx.atr[i] === null) continue;
    if (!fn(i, ctx)) continue;
    if (!filterFn(i, ctx, side)) continue;
    out.push(i);
  }
  return out;
}

/**
 * 거래의 순손익 % (자기자본 1× 기준).
 * 왕복 수수료 + 슬리피지 + 펀딩(보유 기간 실측 누적).
 * 펀딩은 롱이 지불(rate>0), 숏이 수취. fundingCum 은 "롱 기준 %"를 돌려준다.
 */
export function netPct(trade, feePct, slipPct, fundingCum) {
  const fund = fundingCum ? fundingCum(trade.entryAt, trade.exitAt) : 0;
  const fundCost = trade.side === "long" ? fund : -fund;
  return trade.grossPct - feePct - slipPct - fundCost;
}
