"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { type AnnotationDraft } from "@/components/chart-annotations";
import { QuadPane } from "@/app/(app)/quad/quad-pane";
import {
  describeUndo,
  pushChange,
  type AnnotationChange,
} from "@/lib/annotation-history";
import { ANNOTATION_DOT_CLASS, normalizePoints, pointCount } from "@/lib/annotations";
import {
  ANNOTATION_COLORS,
  ANNOTATION_COLOR_LABEL,
  isPositionKind,
  type AnnotationColor,
  type AnnotationKind,
  type ChartPoint,
  type TradeAnnotation,
} from "@/lib/domain";
import { positionProblemOf } from "@/lib/position-tool";
import { type Bar } from "@/lib/okx";

/** trade-chart와 같은 도구 목록 — 측정만 뺐다(창마다 따로 재는 건 이 화면의 일이 아니다). */
const DRAW_TOOLS: { tool: AnnotationKind; label: string; hint: string }[] = [
  { tool: "text", label: "T 텍스트", hint: "차트를 눌러 그 자리에 메모를 답니다" },
  { tool: "hline", label: "— 수평선", hint: "차트를 눌러 그 가격에 가로선을 긋습니다" },
  { tool: "line", label: "／ 추세선", hint: "두 지점을 끌어 선을 긋습니다" },
  { tool: "rect", label: "□ 박스", hint: "끌어서 구간을 감쌉니다" },
  { tool: "long", label: "▲ 롱 손익", hint: "진입 → 손절 → 목표를 차례로 누릅니다" },
  { tool: "short", label: "▼ 숏 손익", hint: "진입 → 손절 → 목표를 차례로 누릅니다" },
];

const POSITION_STEPS = ["진입가를 누르세요", "손절가를 누르세요", "목표가를 누르세요"];

/** trade-chart와 같은 기준 — 이보다 덜 움직였으면 옮긴 게 아니라 고른 것이다. */
const MIN_MOVE_PX = 3;

/** 4분할의 기본 구성 — 요구된 15분/1시간/4시간/일봉. 창마다 바꿀 수 있다. */
const DEFAULT_BARS: Bar[] = ["15m", "1H", "4H", "1D"];

/** 봉이 넘어갔는지 보는 주기(ms) — 가장 촘촘한 1분봉이 한 번은 걸리는 간격. */
const REFRESH_MS = 60_000;

/**
 * 4분할 멀티 타임프레임 차트.
 *
 * 그리기 상태는 전부 여기 산다. 도형 좌표가 (시각, 가격)이라 봉 단위가 달라도 같은
 * 자리를 가리키므로, 같은 배열을 네 창에 내려보내는 것만으로 "한 창에 그리면 네 창에
 * 같이 그려지는" 동기화가 된다. 저장은 하지 않는다 — 새로고침하면 사라진다.
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

  const [tool, setTool] = useState<"none" | AnnotationKind>("none");
  const [color, setColor] = useState<AnnotationColor>("accent");
  const [annotations, setAnnotations] = useState<TradeAnnotation[]>([]);
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  /** 손익 툴처럼 여러 번 눌러 완성하는 도형의 중간 좌표 — trade-chart와 같은 ref 설계. */
  const stepsRef = useRef<ChartPoint[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ id: string; points: ChartPoint[] } | null>(null);
  /** 텍스트 도구의 내용 입력창 — 텍스트만 내용이 필수라 이때만 묻는다. */
  const [asking, setAsking] = useState(false);
  const [label, setLabel] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<AnnotationChange[]>([]);

  /**
   * Alt+R — 트레이딩뷰의 "차트 초기화"와 같은 단축키.
   *
   * 확대·이동·축 배율을 처음 보기로 되돌린다. 값이 오를 때마다 네 창이 함께
   * 초기화되도록 카운터로 둔다(불리언이면 연타를 구분하지 못한다).
   */
  const [resetTick, setResetTick] = useState(0);
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
  }, []);

  const record = (change: AnnotationChange) => {
    setHistory((stack) => pushChange(stack, change));
    setNotice(null);
  };

  /** 화면에 그릴 도형 — 끌고 있는 것만 새 좌표로 갈아 끼운다(trade-chart와 동일). */
  const shown = useMemo(
    () =>
      moving === null
        ? annotations
        : annotations.map((a) => (a.id === moving.id ? { ...a, points: moving.points } : a)),
    [annotations, moving],
  );

  const resetDraft = () => {
    stepsRef.current = [];
    setDraft(null);
    setAsking(false);
  };

  /** 도구를 갈아 끼운다 — 같은 것을 다시 누르면 끈다. 그리던 것은 버린다. */
  const pickTool = (next: "none" | AnnotationKind) => {
    setTool((current) => (current === next ? "none" : next));
    resetDraft();
    setSelected(null);
    setProblem(null);
  };

  const addAnnotation = (kind: AnnotationKind, points: ChartPoint[], text: string | null) => {
    const at = new Date().toISOString();
    const item: TradeAnnotation = {
      // 서버에 없는 도형이라 id는 화면에서 만든다 — 되돌리기가 이 id로 짚는다.
      id: crypto.randomUUID(),
      trade_id: "",
      user_id: "",
      kind,
      points: normalizePoints(kind, points),
      text,
      color,
      locked: false,
      created_at: at,
      updated_at: at,
    };
    setAnnotations((prev) => [...prev, item]);
    record({ type: "create", id: item.id, kind });
    resetDraft();
    setProblem(null);
    // 하나 그리면 커서로 돌아간다 — trade-chart와 같은 이유(방금 그린 것을 바로 옮길 수 있게).
    setTool("none");
  };

  /* ---------- 창에서 올라오는 그리기 이벤트 ---------- */

  const onClickPoint = (point: ChartPoint) => {
    if (tool === "none") return;
    const kind = tool;
    const placed = [...stepsRef.current, point];
    stepsRef.current = placed;
    setDraft({ kind, points: placed, text: null, color });
    if (placed.length < pointCount(kind)) return;

    if (kind === "text") {
      // 텍스트는 내용이 전부다 — 여기서만 입력창을 연다.
      setLabel("");
      setProblem(null);
      setAsking(true);
      return;
    }
    if (isPositionKind(kind)) {
      const p = positionProblemOf(kind, placed);
      if (p !== null) {
        // 어긋난 손익비는 남기지 않는다 — 도구는 켜 둔 채 다시 찍게 한다.
        setProblem(p);
        resetDraft();
        return;
      }
    }
    addAnnotation(kind, placed, null);
  };

  const onDragDraft = (points: [ChartPoint, ChartPoint]) => {
    if (tool === "none") return;
    setDraft({ kind: tool, points, text: null, color });
  };

  const onDragCommit = (points: [ChartPoint, ChartPoint]) => {
    if (tool === "none") return;
    addAnnotation(tool, points, null);
  };

  const saveText = () => {
    if (!draft || draft.kind !== "text") return;
    const text = label.trim();
    if (text === "") {
      setProblem("메모 내용을 입력해 주세요.");
      return;
    }
    addAnnotation("text", draft.points, text);
  };

  /* ---------- 창에서 올라오는 선택·이동 ---------- */

  const onSelect = (id: string | null) => {
    setSelected(id);
    if (id === null) setProblem(null);
  };

  const onMoveEnd = (
    id: string,
    kind: AnnotationKind,
    origin: ChartPoint[],
    points: ChartPoint[],
    movedPx: number,
  ) => {
    // 거의 안 움직였으면 옮긴 게 아니라 고른 것이다 — 고른 표시만 남긴다.
    if (movedPx < MIN_MOVE_PX) {
      setMoving(null);
      return;
    }
    // 옮긴 자리가 방향과 어긋나면 되돌린다 — 뒤집힌 손익비를 남기지 않는다.
    if (isPositionKind(kind)) {
      const p = positionProblemOf(kind, points);
      if (p !== null) {
        setMoving(null);
        setProblem(p);
        return;
      }
    }
    setAnnotations((prev) =>
      prev.map((a) =>
        a.id === id ? { ...a, points, updated_at: new Date().toISOString() } : a,
      ),
    );
    record({ type: "move", id, kind, before: origin });
    setMoving(null);
  };

  /* ---------- 되돌리기 — 서버가 없으니 역연산도 화면 안에서 끝난다 ---------- */

  const undo = (): boolean => {
    const last = history[history.length - 1];
    if (last === undefined) return false;

    setHistory((stack) => stack.slice(0, -1));
    setProblem(null);

    switch (last.type) {
      case "create":
        setAnnotations((prev) => prev.filter((a) => a.id !== last.id));
        setSelected((s) => (s === last.id ? null : s));
        break;
      case "delete":
        // 지워진 id를 그대로 되쓴다 — 앞선 기록들이 이 id를 가리킨다.
        setAnnotations((prev) => [...prev, last.before]);
        break;
      case "move":
        setAnnotations((prev) =>
          prev.map((a) => (a.id === last.id ? { ...a, points: last.before } : a)),
        );
        break;
      case "text":
        setAnnotations((prev) =>
          prev.map((a) => (a.id === last.id ? { ...a, text: last.before } : a)),
        );
        break;
      case "lock":
        setAnnotations((prev) =>
          prev.map((a) => (a.id === last.id ? { ...a, locked: last.before } : a)),
        );
        break;
    }
    setNotice(describeUndo(last));
    return true;
  };

  const undoRef = useRef(undo);
  useEffect(() => {
    undoRef.current = undo;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "z") return;
      if (!e.ctrlKey && !e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (undoRef.current()) e.preventDefault();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---------- Del·Esc — trade-chart와 같은 규칙, 저장만 로컬 ---------- */
  useEffect(() => {
    if (selected === null && tool === "none") return;

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (e.key === "Escape") {
        stepsRef.current = [];
        setDraft(null);
        setAsking(false);
        setProblem(null);
        setSelected(null);
        setTool("none");
        return;
      }

      if (selected === null) return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      e.preventDefault();

      const before = annotations.find((a) => a.id === selected);
      setAnnotations((prev) => prev.filter((a) => a.id !== selected));
      if (before) record({ type: "delete", before });
      setSelected(null);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, tool, annotations]);

  /* ---------- 심볼 바꾸기 — 도형은 그 심볼의 가격에 붙어 있어 함께 비운다 ---------- */
  const commitSymbol = () => {
    const next = symbolInput.trim().toUpperCase();
    if (next === "" || next === symbol) {
      setSymbolInput(symbol);
      return;
    }
    setSymbol(next);
    setSymbolInput(next);
    setAnnotations([]);
    setHistory([]);
    setSelected(null);
    setMoving(null);
    resetDraft();
    setProblem(null);
    setNotice("심볼을 바꿔 그린 내용을 비웠습니다.");
  };

  const positionStep =
    tool !== "none" && isPositionKind(tool) && !asking
      ? POSITION_STEPS[draft?.points.length ?? 0] ?? null
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* 도구 막대 — 네 창이 하나의 도구·색·심볼을 공유한다. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1">
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
        {DRAW_TOOLS.map((t) => (
          <button
            key={t.tool}
            type="button"
            onClick={() => pickTool(t.tool)}
            className={`rounded-lg border px-2.5 py-1 text-xs ${
              tool === t.tool
                ? "border-accent bg-accent text-white"
                : "border-border text-dim hover:text-text"
            }`}
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
        {tool !== "none" && !isPositionKind(tool) ? (
          <span className="ml-1 flex items-center gap-1">
            {ANNOTATION_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={ANNOTATION_COLOR_LABEL[c]}
                aria-pressed={color === c}
                title={ANNOTATION_COLOR_LABEL[c]}
                onClick={() => setColor(c)}
                className={`size-4 rounded-full ${ANNOTATION_DOT_CLASS[c]} ${
                  color === c ? "ring-2 ring-text ring-offset-1 ring-offset-surface" : ""
                }`}
              />
            ))}
          </span>
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1">
        <div className="grid h-full grid-cols-1 gap-2 overflow-y-auto md:grid-cols-2 md:grid-rows-2 md:overflow-visible">
          {paneBars.map((bar, i) => (
            <QuadPane
              key={i}
              symbol={symbol}
              bar={bar}
              onBarChange={(next) =>
                setPaneBars((prev) => prev.map((b, j) => (j === i ? next : b)))
              }
              now={now}
              resetTick={resetTick}
              tool={tool}
              asking={asking}
              annotations={annotations}
              shown={shown}
              draft={draft}
              selected={selected}
              onClickPoint={onClickPoint}
              onDragDraft={onDragDraft}
              onDragCommit={onDragCommit}
              onDragCancel={resetDraft}
              onSelect={onSelect}
              onMovePreview={(id, points) => setMoving({ id, points })}
              onMoveEnd={onMoveEnd}
            />
          ))}
        </div>

        {/* 텍스트 내용 입력 — 그리드 아래쪽에 고정한다. */}
        {asking && draft ? (
          <div
            className="absolute inset-x-2 bottom-2 rounded-lg border border-border bg-surface p-2 shadow-lg"
            style={{ zIndex: 7 }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveText();
                  if (e.key === "Escape") resetDraft();
                }}
                placeholder="메모 내용"
                className="min-w-40 flex-1 rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={saveText}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white"
              >
                남기기
              </button>
              <button
                type="button"
                onClick={resetDraft}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-dim"
              >
                취소
              </button>
            </div>
            {problem ? <p className="mt-1 text-[11px] text-loss">{problem}</p> : null}
          </div>
        ) : null}
      </div>

      <p className="shrink-0 text-[11px] text-dim">
        {positionStep ? (
          <b className="text-accent">
            {tool === "long" ? "롱" : "숏"} 손익 — {positionStep} (진입 → 손절 → 목표).
            창을 옮겨 다니며 찍어도 됩니다.
          </b>
        ) : tool !== "none" ? (
          <b className="text-accent">
            {DRAW_TOOLS.find((t) => t.tool === tool)?.hint} — 어느 창에 그리든 네 창 모두에
            같이 그려집니다. 다시 누르면 끕니다.
          </b>
        ) : (
          <>
            한 창에 그리면 네 창 모두에 실시간으로 같이 그려집니다 — 도형이 (시각, 가격)에
            붙기 때문입니다. 그린 것은 눌러서 고르고 끌어 옮기며 <b className="text-text">Del</b>{" "}
            로 지우고 <b className="text-text">Ctrl+Z</b> 로 무릅니다.{" "}
            <b className="text-text">Alt+R</b> 은 트레이딩뷰처럼 네 창의 확대·이동을 처음
            보기로 되돌립니다. 봉 단위가 큰 창에서는 시간축이 그 봉 단위로 뭉뚱그려
            보입니다. 그린 내용은 새로고침하면 사라집니다.
          </>
        )}
      </p>

      {problem && !asking ? (
        <p className="shrink-0 text-[11px] text-loss">{problem}</p>
      ) : notice ? (
        <p className="shrink-0 text-[11px] text-dim">{notice}</p>
      ) : null}
    </div>
  );
}
