"use client";

import { useEffect, useState } from "react";

import { QuadPane } from "@/app/(app)/quad/quad-pane";
import {
  DRAW_TOOLS,
  DrawToolbar,
  DrawingPopovers,
  useDrawingBoard,
} from "@/components/drawing-board";
import { type Bar } from "@/lib/okx";

/** 4분할의 기본 구성 — 긴 봉이 먼저 온다. 창마다 바꿀 수 있다. */
const DEFAULT_BARS: Bar[] = ["1D", "4H", "1H", "15m"];

/** 봉이 넘어갔는지 보는 주기(ms) — 가장 촘촘한 1분봉이 한 번은 걸리는 간격. */
const REFRESH_MS = 60_000;

/**
 * 4분할 멀티 타임프레임 차트.
 *
 * 그리기 상태는 전부 그리기 판(useDrawingBoard)에 산다. 도형 좌표가 (시각, 가격)이라 봉
 * 단위가 달라도 같은 자리를 가리키므로, 같은 배열을 네 창에 내려보내는 것만으로 "한 창에
 * 그리면 네 창에 같이 그려지는" 동기화가 된다. 저장은 하지 않는다 — 새로고침하면 사라진다.
 */
export function QuadChart({ now: initialNow }: { now: number }) {
  const [symbol, setSymbol] = useState("BTC");
  const [symbolInput, setSymbolInput] = useState("BTC");
  const [paneBars, setPaneBars] = useState<Bar[]>(DEFAULT_BARS);

  /** 지금(ms) — 서버 값에서 출발해 1분마다 올린다. 봉이 넘어가면 창들이 새로 받는다. */
  const [now, setNow] = useState(initialNow);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  /** 혼자 크게 보는 창의 번호 — null이면 4분할. 차트 상태(줌·그림)는 유지된 채 숨긴다. */
  const [maximized, setMaximized] = useState<number | null>(null);

  const board = useDrawingBoard();
  const { tool, problem, notice, positionStep } = board;

  /**
   * Alt+R — 트레이딩뷰의 "차트 초기화"와 같은 단축키.
   *
   * 확대·이동·축 배율을 처음 보기로 되돌린다. 값이 오를 때마다 네 창이 함께
   * 초기화되도록 카운터로 둔다(불리언이면 연타를 구분하지 못한다).
   */
  const [resetTick, setResetTick] = useState(0);
  const setNotice = board.setNotice;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key.toLowerCase() !== "r" && e.code !== "KeyR") return;
      // 입력칸에서 누른 것은 글자 입력의 일부일 수 있다 — 다른 단축키와 같은 규칙.
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      e.preventDefault();
      setResetTick((t) => t + 1);
      // 보기만 되돌리지 않고 최신 봉도 함께 확인한다 — "새로고침"의 기대에 맞춘다.
      setNow(Date.now());
      setNotice("차트 보기를 초기화했습니다.");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setNotice]);

  /* ---------- 심볼 바꾸기 — 도형은 그 심볼의 가격에 붙어 있어 함께 비운다 ---------- */
  const commitSymbol = () => {
    const next = symbolInput.trim().toUpperCase();
    if (next === "" || next === symbol) {
      setSymbolInput(symbol);
      return;
    }
    setSymbol(next);
    setSymbolInput(next);
    board.clear("심볼을 바꿔 그린 내용을 비웠습니다.");
  };

  /**
   * 확대 중이면 그 창만 전체를 차지하고 나머지는 상태를 유지한 채 숨는다.
   *
   * 4분할일 때는 자리를 따로 지정하지 않는다 — 배열 순서(1D→4H→1H→15m)가 그대로
   * 읽는 순서(왼쪽위 → 오른쪽위 → 왼쪽아래 → 오른쪽아래)로 놓인다.
   */
  const paneClass = (i: number) =>
    maximized === null
      ? ""
      : maximized === i
        ? "!h-full md:col-span-2 md:row-span-2"
        : "hidden";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 p-1">
      {/* 도구 막대 — 네 창이 하나의 도구·색·심볼을 공유한다. 제목도 여기 얹어 줄을 아낀다. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        <h1 className="mr-1 text-sm font-semibold tracking-tight">4분할 차트</h1>
        <label className="mr-1 flex items-center gap-1 text-xs text-dim">
          종목
          <input
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value)}
            onBlur={commitSymbol}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitSymbol();
            }}
            className="w-16 rounded-lg border border-border bg-surface px-2 py-1 text-xs text-text uppercase outline-none focus:border-accent"
            aria-label="종목 — OKX USDT 무기한"
          />
        </label>
        <span className="mr-1 text-[11px] text-dim">USDT 무기한 · OKX</span>
        <span className="mx-1 w-px self-stretch bg-border" aria-hidden />
        <DrawToolbar board={board} />
      </div>

      <div className="relative min-h-0 flex-1">
        <div className="grid h-full grid-cols-1 gap-1 overflow-y-auto md:grid-cols-2 md:grid-rows-2 md:overflow-visible">
          {paneBars.map((bar, i) => (
            <QuadPane
              key={i}
              className={paneClass(i)}
              symbol={symbol}
              bar={bar}
              onBarChange={(next) =>
                setPaneBars((prev) => prev.map((b, j) => (j === i ? next : b)))
              }
              now={now}
              resetTick={resetTick}
              maximizedSelf={maximized === i}
              onToggleMax={() => setMaximized((m) => (m === i ? null : i))}
              tool={tool}
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
          ))}
        </div>

        <DrawingPopovers board={board} />
      </div>

      {/* 안내는 한 줄로 최소화한다 — 이 화면의 주인공은 차트 면적이다. */}
      <p className="shrink-0 truncate text-[10px] text-dim">
        {positionStep ? (
          <b className="text-accent">
            {tool === "long" ? "롱" : "숏"} 손익 — {positionStep} (진입 → 손절 → 목표)
          </b>
        ) : tool !== "none" ? (
          <b className="text-accent">
            {DRAW_TOOLS.find((t) => t.tool === tool)?.hint} — 네 창에 같이 그려집니다.
            다시 누르면 끕니다.
          </b>
        ) : problem ? (
          <b className="text-loss">{problem}</b>
        ) : notice ? (
          notice
        ) : (
          <>
            그리면 네 창 동기 · 눌러 고르고 끌어 이동 · 고르면 색·굵기·선 종류 수정 ·{" "}
            <b className="text-text">Del</b> 삭제 · <b className="text-text">Ctrl+Z</b> 되돌리기
            · <b className="text-text">Alt+R</b> 보기 초기화 · 새로고침하면 사라짐
          </>
        )}
      </p>
    </div>
  );
}
