"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { type AnnotationDraft } from "@/components/chart-annotations";
import {
  describeUndo,
  pushChange,
  type AnnotationChange,
} from "@/lib/annotation-history";
import { ANNOTATION_DOT_CLASS, normalizePoints, pointCount } from "@/lib/annotations";
import {
  ANNOTATION_COLORS,
  ANNOTATION_COLOR_LABEL,
  ANNOTATION_KIND_LABEL,
  ANNOTATION_LINE_STYLES,
  ANNOTATION_LINE_STYLE_LABEL,
  isPositionKind,
  type AnnotationColor,
  type AnnotationKind,
  type ChartPoint,
  type TradeAnnotation,
} from "@/lib/domain";
import { formatLevel, levelFields, parseLevel } from "@/lib/annotation-levels";
import { positionProblemOf } from "@/lib/position-tool";

/**
 * 세션 메모리 그리기 판 — 4분할 차트에서 시작한 "저장 없는 그리기"의 상태 머신.
 *
 * 4분할 차트와 주문 화면이 같은 도구·같은 손놀림(누르기·끌기·고르기·옮기기·되돌리기·
 * 수치 입력)을 쓴다. 상태 머신을 두 벌 두면 한쪽만 고쳐지는 사고가 나므로 여기 한 벌로
 * 모으고, 창(QuadPane)은 좌표 변환과 포인터만 맡긴다. 서버 저장은 없다 — 주문 화면은
 * 주문이 나가는 순간 이 배열을 통째로 거래에 붙인다.
 */

/** trade-chart와 같은 도구 목록 — 측정만 뺐다(창마다 따로 재는 건 이 판의 일이 아니다). */
export const DRAW_TOOLS: { tool: AnnotationKind; label: string; hint: string }[] = [
  { tool: "text", label: "T 텍스트", hint: "차트를 눌러 그 자리에 메모를 답니다" },
  { tool: "hline", label: "— 수평선", hint: "차트를 눌러 그 가격에 가로선을 긋습니다" },
  { tool: "line", label: "／ 추세선", hint: "두 지점을 끌어 선을 긋습니다" },
  { tool: "rect", label: "□ 박스", hint: "끌어서 구간을 감쌉니다" },
  { tool: "long", label: "▲ 롱 손익", hint: "진입 → 손절 → 목표를 차례로 누릅니다" },
  { tool: "short", label: "▼ 숏 손익", hint: "진입 → 손절 → 목표를 차례로 누릅니다" },
];

export const POSITION_STEPS = ["진입가를 누르세요", "손절가를 누르세요", "목표가를 누르세요"];

/** trade-chart와 같은 기준 — 이보다 덜 움직였으면 옮긴 게 아니라 고른 것이다. */
const MIN_MOVE_PX = 3;

/** 스타일 바에서 고를 수 있는 선 굵기(px). */
const LINE_WIDTHS = [1, 2, 3];

export type DrawTool = "none" | AnnotationKind;

export interface DrawingBoard {
  tool: DrawTool;
  /** 도구를 갈아 끼운다 — 같은 것을 다시 누르면 끈다. 그리던 것은 버린다. */
  pickTool: (next: DrawTool) => void;
  color: AnnotationColor;
  setColor: (c: AnnotationColor) => void;
  /** 저장된 도형 원본 — 집기(히트 판정)의 기준. */
  annotations: TradeAnnotation[];
  /** 화면에 그릴 도형 — 끌고 있는 것만 새 좌표로 갈아 끼운 배열. */
  shown: TradeAnnotation[];
  draft: AnnotationDraft | null;
  selected: string | null;
  /** 텍스트 라벨 입력 중 — 그동안 새 도형을 시작하지 않는다. */
  asking: boolean;
  problem: string | null;
  notice: string | null;
  setNotice: (text: string | null) => void;
  /** 손익 툴에서 지금 무엇을 찍을 차례인지 — 아니면 null. */
  positionStep: string | null;
  /** 고른 도형이 스타일을 고칠 수 있는 종류(박스·수평선·추세선)면 그 도형. */
  styleTarget: TradeAnnotation | null;
  /** 수치 입력이 열려 있는가 — 팝오버 겹침을 가르는 데 쓴다. */
  levelsOpen: boolean;
  /* 창(QuadPane)에 그대로 넘기는 처리기 */
  onClickPoint: (point: ChartPoint) => void;
  onDragDraft: (points: [ChartPoint, ChartPoint]) => void;
  onDragCommit: (points: [ChartPoint, ChartPoint]) => void;
  resetDraft: () => void;
  onSelect: (id: string | null) => void;
  openLevels: (target: TradeAnnotation) => void;
  onMovePreview: (id: string, points: ChartPoint[]) => void;
  onMoveEnd: (
    id: string,
    kind: AnnotationKind,
    origin: ChartPoint[],
    points: ChartPoint[],
    movedPx: number,
  ) => void;
  /** 전부 비운다 — 심볼을 바꿀 때처럼 도형이 붙어 있던 가격이 뜻을 잃을 때. */
  clear: (notice: string | null) => void;
  /** 팝오버 전용 — 화면이 직접 부를 일은 없다. */
  popover: {
    label: string;
    setLabel: (text: string) => void;
    saveText: () => void;
    levels: { target: TradeAnnotation; values: string[] } | null;
    setLevelValue: (index: number, value: string) => void;
    saveLevels: () => void;
    closeLevels: () => void;
    updateStyle: (
      patch: Partial<Pick<TradeAnnotation, "color" | "line_width" | "line_style">>,
    ) => void;
  };
}

export function useDrawingBoard(): DrawingBoard {
  const [tool, setTool] = useState<DrawTool>("none");
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
  /** 더블클릭으로 연 수치 입력 — 값을 손이 아니라 숫자로 넣는다(당시 차트와 같은 흐름). */
  const [levels, setLevels] = useState<{ target: TradeAnnotation; values: string[] } | null>(
    null,
  );

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

  const pickTool = (next: DrawTool) => {
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
    if (id === null) {
      setProblem(null);
      setLevels(null);
    }
  };

  const openLevels = (target: TradeAnnotation) => {
    setLevels({
      target,
      values: levelFields(target.kind).map((f) => formatLevel(target.points[f.index]?.p)),
    });
    setAsking(false);
    setProblem(null);
  };

  const setLevelValue = (index: number, value: string) => {
    setLevels((state) =>
      state === null
        ? state
        : { ...state, values: state.values.map((v, j) => (j === index ? value : v)) },
    );
  };

  /** 숫자로 적은 값을 좌표에 얹는다 — 시각은 그대로 두고 가격만 바꾼다. */
  const saveLevels = () => {
    if (!levels) return;
    const { target, values } = levels;

    const points = target.points.map((point) => ({ ...point }));
    const fields = levelFields(target.kind);
    for (let i = 0; i < fields.length; i += 1) {
      const price = parseLevel(values[i] ?? "");
      if (price === null) {
        setProblem(`${fields[i].label}를 숫자로 입력해 주세요.`);
        return;
      }
      points[fields[i].index] = { t: points[fields[i].index].t, p: price };
    }

    if (isPositionKind(target.kind)) {
      const p = positionProblemOf(target.kind, points);
      if (p !== null) {
        setProblem(p);
        return;
      }
    }

    setAnnotations((prev) =>
      prev.map((a) =>
        a.id === target.id ? { ...a, points, updated_at: new Date().toISOString() } : a,
      ),
    );
    record({ type: "move", id: target.id, kind: target.kind, before: target.points });
    setProblem(null);
    setLevels(null);
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
        setLevels(null);
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

  const clear = (text: string | null) => {
    setAnnotations([]);
    setHistory([]);
    setSelected(null);
    setMoving(null);
    resetDraft();
    setProblem(null);
    setNotice(text);
  };

  const positionStep =
    tool !== "none" && isPositionKind(tool) && !asking
      ? (POSITION_STEPS[draft?.points.length ?? 0] ?? null)
      : null;

  const styleTarget =
    selected !== null
      ? (annotations.find(
          (a) =>
            a.id === selected &&
            (a.kind === "hline" || a.kind === "line" || a.kind === "rect"),
        ) ?? null)
      : null;

  const updateStyle = (
    patch: Partial<Pick<TradeAnnotation, "color" | "line_width" | "line_style">>,
  ) => {
    if (selected === null) return;
    setAnnotations((prev) =>
      prev.map((a) =>
        a.id === selected ? { ...a, ...patch, updated_at: new Date().toISOString() } : a,
      ),
    );
  };

  return {
    tool,
    pickTool,
    color,
    setColor,
    annotations,
    shown,
    draft,
    selected,
    asking,
    problem,
    notice,
    setNotice,
    positionStep,
    styleTarget,
    levelsOpen: levels !== null,
    onClickPoint,
    onDragDraft,
    onDragCommit,
    resetDraft,
    onSelect,
    openLevels,
    onMovePreview: (id, points) => setMoving({ id, points }),
    onMoveEnd,
    clear,
    popover: {
      label,
      setLabel,
      saveText,
      levels,
      setLevelValue,
      saveLevels,
      closeLevels: () => setLevels(null),
      updateStyle,
    },
  };
}

/** 도구 버튼 + (손익 툴이 아닐 때) 색 점 — 창 위 도구 막대에 그대로 얹는다. */
export function DrawToolbar({ board }: { board: DrawingBoard }) {
  const { tool, color } = board;
  return (
    <>
      {DRAW_TOOLS.map((t) => (
        <button
          key={t.tool}
          type="button"
          onClick={() => board.pickTool(t.tool)}
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
              onClick={() => board.setColor(c)}
              className={`size-4 rounded-full ${ANNOTATION_DOT_CLASS[c]} ${
                color === c ? "ring-2 ring-text ring-offset-1 ring-offset-surface" : ""
              }`}
            />
          ))}
        </span>
      ) : null}
    </>
  );
}

/**
 * 차트 아래쪽에 겹치는 세 팝오버 — 텍스트 내용 · 수치 입력 · 스타일 바.
 *
 * 부모가 `relative` 여야 한다. 한 번에 하나만 뜬다: 텍스트 입력 > 수치 입력 > 스타일 바.
 */
export function DrawingPopovers({ board }: { board: DrawingBoard }) {
  const { asking, draft, problem, styleTarget } = board;
  const { label, setLabel, saveText, levels, setLevelValue, saveLevels, closeLevels, updateStyle } =
    board.popover;

  return (
    <>
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
                if (e.key === "Escape") board.resetDraft();
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
              onClick={board.resetDraft}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-dim"
            >
              취소
            </button>
          </div>
          {problem ? <p className="mt-1 text-[11px] text-loss">{problem}</p> : null}
        </div>
      ) : null}

      {/* 더블클릭 — 값을 숫자로 넣는다. 픽셀로는 못 맞추는 자리가 있다. */}
      {levels ? (
        <div
          className="absolute inset-x-2 bottom-2 rounded-lg border border-border bg-surface p-2 shadow-lg"
          style={{ zIndex: 8 }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-dim">
              {ANNOTATION_KIND_LABEL[levels.target.kind]}
            </span>
            {levelFields(levels.target.kind).map((field, i) => (
              <label key={field.index} className="text-[11px] text-dim">
                {field.label}
                <input
                  autoFocus={i === 0}
                  inputMode="decimal"
                  value={levels.values[i] ?? ""}
                  onChange={(e) => setLevelValue(i, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveLevels();
                    if (e.key === "Escape") closeLevels();
                  }}
                  className="tnum mt-0.5 block w-28 rounded-lg border border-border bg-bg px-2 py-1 text-sm outline-none focus:border-accent"
                />
              </label>
            ))}
            <button
              type="button"
              onClick={saveLevels}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white"
            >
              적용
            </button>
            <button
              type="button"
              onClick={closeLevels}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-dim"
            >
              취소
            </button>
          </div>
          {problem ? <p className="mt-1 text-[11px] text-loss">{problem}</p> : null}
        </div>
      ) : null}

      {/* 스타일 바 — 박스·수평선·추세선을 고르면 색·굵기·선 종류를 바로 고친다. */}
      {styleTarget && !asking && !levels ? (
        <div
          className="absolute inset-x-2 bottom-2 rounded-lg border border-border bg-surface p-2 shadow-lg"
          style={{ zIndex: 7 }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-dim">
              {ANNOTATION_KIND_LABEL[styleTarget.kind]}
            </span>
            <span className="flex items-center gap-1">
              {ANNOTATION_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={ANNOTATION_COLOR_LABEL[c]}
                  aria-pressed={styleTarget.color === c}
                  title={ANNOTATION_COLOR_LABEL[c]}
                  onClick={() => updateStyle({ color: c })}
                  className={`size-4 rounded-full ${ANNOTATION_DOT_CLASS[c]} ${
                    styleTarget.color === c
                      ? "ring-2 ring-text ring-offset-1 ring-offset-surface"
                      : ""
                  }`}
                />
              ))}
            </span>
            <span className="mx-1 w-px self-stretch bg-border" aria-hidden />
            {LINE_WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={(styleTarget.line_width ?? 1) === w}
                onClick={() => updateStyle({ line_width: w })}
                className={`rounded border px-2 py-0.5 text-[11px] ${
                  (styleTarget.line_width ?? 1) === w
                    ? "border-accent text-accent"
                    : "border-border text-dim hover:text-text"
                }`}
              >
                {w}px
              </button>
            ))}
            <span className="mx-1 w-px self-stretch bg-border" aria-hidden />
            {ANNOTATION_LINE_STYLES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={(styleTarget.line_style ?? "solid") === s}
                onClick={() => updateStyle({ line_style: s })}
                className={`rounded border px-2 py-0.5 text-[11px] ${
                  (styleTarget.line_style ?? "solid") === s
                    ? "border-accent text-accent"
                    : "border-border text-dim hover:text-text"
                }`}
              >
                {ANNOTATION_LINE_STYLE_LABEL[s]}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
