"use client";

import { useState } from "react";

import { QuadPane } from "@/app/(app)/quad/quad-pane";
import { DrawingPopovers, type DrawingBoard } from "@/components/drawing-board";
import { type Bar } from "@/lib/okx";

/**
 * 주문 화면의 차트 — 4분할의 창 하나를 그리기 판에 붙인 것.
 *
 * 그리기 상태는 패널이 들고 있다(주문이 나갈 때 도형을 통째로 거래에 붙여야 하므로).
 * 여기는 창과 팝오버를 놓는 자리만 잡는다.
 */
export function OrderChart({
  symbol,
  now,
  board,
}: {
  symbol: string;
  now: number;
  board: DrawingBoard;
}) {
  const [bar, setBar] = useState<Bar>("1H");

  return (
    <div className="relative grid h-[440px] lg:h-[560px]">
      <QuadPane
        className="!h-full"
        symbol={symbol}
        bar={bar}
        onBarChange={setBar}
        now={now}
        resetTick={0}
        tool={board.tool}
        asking={board.asking}
        annotations={board.annotations}
        shown={board.shown}
        draft={board.draft}
        selected={board.selected}
        onClickPoint={board.onClickPoint}
        onDragDraft={board.onDragDraft}
        onDragCommit={board.onDragCommit}
        onDragCancel={board.resetDraft}
        onSelect={board.onSelect}
        onOpenLevels={board.openLevels}
        onMovePreview={board.onMovePreview}
        onMoveEnd={board.onMoveEnd}
      />
      <DrawingPopovers board={board} />
    </div>
  );
}
