/**
 * 전체 차트 — 거래 목록의 모든 거래를 한 캔들 차트에 올릴 때 쓰는 계산.
 *
 * 행마다 펼치는 "당시 차트"는 거래 한 건이 구간을 정하지만, 여기서는 **첫 진입부터
 * 마지막 청산(보유중이면 지금)** 까지가 구간이다. 캔들은 종목별이라 한 장에는 한 종목만
 * 올라간다 — 어느 종목을 먼저 보여줄지도 여기서 정한다.
 */
import type { Trade } from "@/lib/domain";
import { type Bar, floorToBar, pickBar, windowFor } from "@/lib/okx";

/**
 * 전체 구간이 담길 봉 수의 목표.
 *
 * 행 차트(60봉)보다 훨씬 촘촘해야 화살표가 서로 다른 봉에 떨어진다. OKX 한 구간 상한이
 * 4,000봉이고 `pickBar` 는 목표에 가장 가까운 단위를 고르므로, 600 이면 아무리 어긋나도
 * 상한의 절반 안이다.
 */
export const OVERVIEW_BARS = 600;

/** 앞뒤 여유 봉 — 첫 진입과 마지막 청산이 화면 가장자리에 붙지 않을 만큼만. */
export const OVERVIEW_PAD_BARS = 10;

export type OverviewTrade = Pick<
  Trade,
  "id" | "seq" | "symbol" | "side" | "entry_at" | "exit_at" | "entry_price" | "exit_price"
>;

/**
 * 거래가 가장 많은 종목 — 패널을 열었을 때 먼저 보여줄 종목.
 *
 * 동률이면 먼저 나온 종목이다(목록은 순번 순이라 "먼저 거래한 종목"이 된다). 빈 목록은 null.
 */
export function mostTradedSymbol(trades: readonly Pick<Trade, "symbol">[]): string | null {
  const counts = new Map<string, number>();
  for (const t of trades) counts.set(t.symbol, (counts.get(t.symbol) ?? 0) + 1);

  let best: string | null = null;
  let bestCount = 0;
  for (const [symbol, count] of counts) {
    if (count > bestCount) {
      best = symbol;
      bestCount = count;
    }
  }
  return best;
}

export interface OverviewWindow {
  from: number;
  to: number;
  bar: Bar;
}

/**
 * 한 종목의 거래 전부가 들어가는 구간과 봉 단위.
 *
 * 끝은 마지막 청산이지만 보유중인 거래가 하나라도 있으면 **지금**이다 — 그 거래가 들어간
 * 뒤 시세가 어디로 갔는지가 빠지면 안 된다. 지금은 봉 눈금에 맞춰 내린다(캐시 안정, `floorToBar`).
 */
export function overviewWindow(
  trades: readonly Pick<Trade, "entry_at" | "exit_at">[],
  now: number,
): OverviewWindow | null {
  if (trades.length === 0) return null;

  let start = Infinity;
  let end = -Infinity;
  let open = false;
  for (const t of trades) {
    const entry = Date.parse(t.entry_at);
    start = Math.min(start, entry);
    if (t.exit_at === null) {
      open = true;
    } else {
      end = Math.max(end, Date.parse(t.exit_at));
    }
  }
  if (open) end = Math.max(end, now);

  const bar = pickBar(Math.max(end - start, 1), OVERVIEW_BARS);
  const { from, to } = windowFor(start, open ? floorToBar(end, bar) : end, bar, OVERVIEW_PAD_BARS);
  return { from, to, bar };
}
