import { type Candle } from '@/lib/okx';

/** 표준 ATR 기간. 바꾸면 화면에 뜨는 배수의 뜻이 달라지므로 한 곳에서만 정한다. */
export const ATR_PERIOD = 14;

/**
 * 손절을 둘 만한 폭 — 평균 흔들림의 1.5~2.5배. 아래로 내려가면 시장이 정상적으로
 * 숨 쉬는 폭 안쪽에 손절이 들어가고, 방향이 맞아도 가는 길에 먼저 밟힌다.
 *
 * 이 범위는 **안내이지 규칙이 아니다** — 진입을 막지 않는다(REQ-0056).
 */
export const ATR_STOP_MIN = 1.5;
export const ATR_STOP_MAX = 2.5;

/**
 * True Range — 봉의 고저폭과 전봉 종가까지의 간격 중 큰 것. 갭을 흔들림에 포함시키려고
 * 단순 고저폭 대신 쓴다.
 */
function trueRange(cur: Candle, prevClose: number): number {
  return Math.max(cur.h - cur.l, Math.abs(cur.h - prevClose), Math.abs(cur.l - prevClose));
}

/**
 * ATR(14) 를 마지막 봉 종가 대비 백분율로 돌려준다 — 가격이 얼마든 같은 눈금으로 읽으려고
 * 절대값이 아니라 %로 낸다. 봉이 모자라면 null.
 *
 * 캔들은 시간 오름차순이라고 본다(`fetchCandles` 가 그렇게 준다).
 */
export function atrPercent(candles: readonly Candle[], period = ATR_PERIOD): number | null {
  if (candles.length < period + 1) return null;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(trueRange(candles[i], candles[i - 1].c));
  }

  let sum = 0;
  for (let i = trs.length - period; i < trs.length; i++) sum += trs[i];
  const atr = sum / period;

  const lastClose = candles[candles.length - 1].c;
  if (!Number.isFinite(atr) || !Number.isFinite(lastClose) || lastClose <= 0) return null;
  return (atr / lastClose) * 100;
}

/**
 * 손절 폭이 ATR 의 몇 배인가. 진입가·손절가가 비었거나 ATR 이 없으면 null.
 *
 * 손절 폭은 진입가 기준 백분율로 잡는다 — 화면의 「손절 시 −X USDT」 계산과 같은 기준이다.
 */
export function stopAtrMultiple(
  entryPrice: number | null,
  stopPrice: number | null,
  atrPct: number | null,
): number | null {
  if (entryPrice === null || stopPrice === null || atrPct === null) return null;
  if (entryPrice <= 0 || atrPct <= 0) return null;
  const stopPct = (Math.abs(stopPrice - entryPrice) / entryPrice) * 100;
  if (!Number.isFinite(stopPct) || stopPct <= 0) return null;
  return stopPct / atrPct;
}
