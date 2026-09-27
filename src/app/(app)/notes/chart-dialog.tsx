"use client";

import { useRef, useState } from "react";

import { TradePathChart } from "@/app/(app)/notes/trade-path-view";
import { SIDE_LABEL, type Trade } from "@/lib/domain";

/**
 * 매매 노트의 차트 팝업(REQ-0078) — 누르면 그 거래 구간의 차트를 모달로 띄운다. 차트 아래에
 * TP 도달 경로 복기(REQ-0077)가 붙는다.
 *
 * 앱에 모달이 없어 네이티브 `<dialog>` 를 쓴다(Esc·포커스 가두기가 딸려 온다). 차트는 열렸을
 * 때만 마운트한다 — 목록의 행마다 버튼이 있으니 닫힌 동안 캔들을 부르지 않게.
 */
export function ChartDialogButton({
  trade,
  now,
  className,
  children,
}: {
  trade: Trade;
  /** 페이지를 그린 시각 — `TradeChart` 가 보유중 거래를 어디까지 그릴지 정한다 */
  now: number;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          ref.current?.showModal();
        }}
        className={className}
      >
        {children}
      </button>
      <dialog
        ref={ref}
        aria-label={`#${trade.seq} ${trade.symbol} 차트`}
        onClose={() => setOpen(false)}
        // 백드롭은 dialog 자신이 받는다 — 안쪽 상자 밖을 누르면 닫는다.
        onClick={(e) => {
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
        className="m-auto max-h-[90vh] w-[min(1100px,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-0 text-text backdrop:bg-black/60"
      >
        <div className="space-y-2 p-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">
              #{trade.seq} {trade.symbol}{" "}
              <span className={trade.side === "long" ? "text-profit" : "text-loss"}>{SIDE_LABEL[trade.side]}</span>
            </span>
            <button
              type="button"
              onClick={() => ref.current?.close()}
              className="ml-auto rounded-lg border border-border px-2 py-0.5 text-xs text-dim hover:text-text"
            >
              닫기
            </button>
          </div>
          {open ? (
            <TradePathChart trade={trade} now={now} />
          ) : null}
        </div>
      </dialog>
    </>
  );
}
