"use client";

import { useState, useTransition } from "react";

import {
  closeLiveTestPosition,
  placeLiveTestOrder,
  type LiveTestState,
} from "@/app/(app)/trades/live-test-actions";

/**
 * 실주문 테스트 패널 — 진짜 돈이 나가는 버튼이다.
 *
 * 그래서 이 패널의 문법은 앱의 다른 버튼과 다르다: 접혀 있고, 펼쳐야 하고,
 * 확인에 체크해야 실행된다. 수량은 항상 최소(0.01계약)로 고정 — 목적은 왕복 검증이다.
 * 여기서 검증된 경로가 이후 라이브 시스템 트레이딩 제어의 공용 통로가 된다.
 */
export function LiveTestPanel({
  equity,
  price,
  minNotional,
  needBalance,
  openPositions,
  statusError,
}: {
  equity: number | null;
  price: number | null;
  minNotional: number | null;
  needBalance: number | null;
  openPositions: { posSide: "long" | "short"; pos: number; avgPx: number; upl: number }[];
  statusError: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [side, setSide] = useState<"long" | "short">("long");
  const [ack, setAck] = useState(false);
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<LiveTestState>({});
  const [lastAlgoId, setLastAlgoId] = useState("");

  const ready = statusError === null && equity !== null && needBalance !== null && equity >= needBalance;

  const submit = (action: "open" | "close") =>
    startTransition(async () => {
      setState({});
      try {
        const fd = new FormData();
        fd.set("side", side);
        if (action === "open") {
          fd.set("ack", ack ? "on" : "");
          const next = await placeLiveTestOrder({}, fd);
          if (next.ok?.algoClOrdId) setLastAlgoId(next.ok.algoClOrdId);
          setState(next);
        } else {
          fd.set("algoClOrdId", lastAlgoId);
          setState(await closeLiveTestPosition({}, fd));
        }
      } catch {
        // 액션이 던지면 주문이 나갔는지 모호하다 — 재클릭 유도 전에 확인부터 시키는 문구.
        setState({ error: "요청이 중단됐습니다 — 주문 접수 여부가 불확실합니다. 거래소 포지션을 확인한 뒤 다시 시도하세요." });
      } finally {
        // 성공이든 실패든 다음 주문은 다시 확인부터 — 연타로 나가는 실주문은 없다.
        setAck(false);
      }
    });

  return (
    <section className="rounded-xl border border-loss/40 bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-sm font-medium">
            실주문 테스트{" "}
            <span className="rounded border border-loss px-1.5 py-0.5 text-[10px] font-semibold text-loss">
              LIVE
            </span>
          </h2>
          <p className="mt-0.5 text-[11px] text-dim">
            시스템 배선 검증 — 최소 수량(≈${minNotional?.toFixed(2) ?? "?"}) · 레버리지 10배 ·
            손절 −0.1% / 목표 +0.15% 브래킷 자동 부착
          </p>
        </div>
        <div className="tnum ml-auto text-[11px] text-dim">
          {statusError ? (
            <span className="text-loss">{statusError}</span>
          ) : (
            <>
              잔고 <b className="text-text">${equity?.toFixed(2)}</b> · 현재가{" "}
              <b className="text-text">{price?.toLocaleString()}</b>
              {openPositions.length > 0 ? (
                <>
                  {" "}
                  · 포지션{" "}
                  <b className="text-beta">
                    {openPositions.map((p) => `${p.posSide === "long" ? "롱" : "숏"} ${p.pos}계약`).join(", ")}
                  </b>
                </>
              ) : (
                " · 포지션 없음"
              )}
            </>
          )}
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-dim hover:text-text"
        >
          {expanded ? "접기" : "열기"}
        </button>
      </div>

      {expanded ? (
        <div className="mt-3 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex overflow-hidden rounded-lg border border-border text-xs">
              {(["long", "short"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  className={`px-3 py-1.5 ${side === s ? (s === "long" ? "bg-profit text-white" : "bg-loss text-white") : "text-dim hover:text-text"}`}
                >
                  {s === "long" ? "롱" : "숏"}
                </button>
              ))}
            </span>
            <label className="flex items-center gap-1.5 text-xs text-dim">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              실제 자금으로 주문됨을 확인했습니다
            </label>
            <button
              type="button"
              disabled={pending || !ack || !ready}
              onClick={() => submit("open")}
              className="rounded-lg bg-loss px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {pending ? "실행 중…" : `실주문 실행 (${side === "long" ? "롱" : "숏"})`}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => submit("close")}
              className="rounded-lg border border-border px-3 py-2 text-sm text-dim hover:text-text disabled:opacity-40"
            >
              포지션 정리
            </button>
          </div>

          {state.error ? <p className="mt-2 text-xs text-loss">{state.error}</p> : null}
          {state.ok ? <p className="mt-2 text-xs text-profit">{state.ok.detail}</p> : null}
          <p className="mt-2 text-[11px] text-dim">
            진입하면 손절·목표가 거래소에 함께 걸린다 — 이 창을 닫아도 보호는 유지된다.
            브래킷이 먼저 걸리면 「포지션 정리」는 &ldquo;정리할 것 없음&rdquo;으로 답한다.
            모든 사건은 <code className="rounded bg-surface-2 px-1">system-trading/data</code>에
            기록되어 테스트 리포트에 들어간다.
          </p>
        </div>
      ) : null}
    </section>
  );
}
