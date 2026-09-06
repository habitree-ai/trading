"use client";

import { useMemo } from "react";

import { draftAnnotationStore, noteAnnotationStore, type AnnotationStore } from "@/components/annotation-store";
import { TradeChart } from "@/components/trade-chart";
import type { Trade, TradeAnnotation } from "@/lib/domain";
import { activeTargetPrices, activeTargetShares } from "@/lib/exit-plan";

/**
 * 기록 화면의 차트 두 가지 — 포지션 차트와 종목 현재 차트.
 *
 * 둘 다 복기 차트(TradeChart)다. 포지션은 거래 목록의 행이 펼치는 것과 같은 props 로,
 * 종목은 진입 없이 최근 구간만 보는 live 모드로 연다. 폼과 목록이 같은 것을 쓴다.
 */

/** 종목 현재 차트가 보는 구간 — 지금부터 3일 전. 자동 봉 선택이 1시간봉쯤을 고른다. */
const LIVE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** 고른 포지션의 차트 — 보유중이면 진입~현재, 청산됐으면 진입~청산. 메모는 그 거래에 저장된다. */
export function PositionChart({ trade, now }: { trade: Trade; now: number }) {
  return (
    <TradeChart
      tradeId={trade.id}
      symbol={trade.symbol}
      side={trade.side}
      entryAt={trade.entry_at}
      exitAt={trade.exit_at}
      entryPrice={trade.entry_price}
      exitPrice={trade.exit_price}
      stopPrice={trade.okx_stop_price ?? trade.stop_price}
      targets={activeTargetPrices(trade)}
      targetShares={activeTargetShares(trade)}
      notional={trade.notional}
      now={now}
    />
  );
}

function LiveSymbolChart({ symbol, now, store }: { symbol: string; now: number; store: AnnotationStore }) {
  return (
    <TradeChart
      live
      store={store}
      symbol={symbol}
      side="long"
      entryAt={new Date(now - LIVE_WINDOW_MS).toISOString()}
      exitAt={null}
      entryPrice={null}
      exitPrice={null}
      stopPrice={null}
      now={now}
    />
  );
}

/** 저장된 일반 기록의 종목 차트 — 메모는 그 기록에 저장된다. */
export function NoteChart({ noteId, symbol, now }: { noteId: string; symbol: string; now: number }) {
  const store = useMemo(() => noteAnnotationStore(noteId), [noteId]);
  return <LiveSymbolChart symbol={symbol} now={now} store={store} />;
}

/**
 * 저장 전 일반 기록의 종목 차트 — 메모는 브라우저에만 쌓이고 폼이 실어 보낸다.
 *
 * 부르는 쪽이 종목이 바뀔 때 key 를 바꿔 새로 시작한다. 차트를 접었다 다시 펴면 `initial` 로
 * 그 사이 들고 있던 메모를 이어받는다 — 접었다고 그린 것이 사라지면 안 된다.
 */
export function DraftChart({
  symbol,
  now,
  initial,
  onChange,
}: {
  symbol: string;
  now: number;
  initial: TradeAnnotation[];
  onChange: (annotations: TradeAnnotation[]) => void;
}) {
  // 처음 마운트될 때의 값만 쓴다 — 그 뒤로는 store 가 정본이고 onChange 로 올려 보낸다.
  const store = useMemo(
    () => draftAnnotationStore(onChange, initial),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return <LiveSymbolChart symbol={symbol} now={now} store={store} />;
}
