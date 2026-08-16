"use client";

import { useState, useTransition } from "react";

import { syncSystemBook, type SystemSyncState } from "@/app/(app)/books/system-actions";

/**
 * 시스템 트레이딩(자동매매 봇) 패널 — 두 데이터 북을 오가는 허브.
 *
 * 봇의 지금 상태를 보여주고, 완결 거래를 시스템 북으로 가져온다. 어느 북을 보고
 * 있어도 떠 있어야 한다 — 봇은 북이 아니라 머신에 붙어 있는 것이고, 이 패널이
 * 없으면 "가져올 게 쌓였다"는 사실이 화면 어디에도 드러나지 않는다.
 */
export function SystemPanel({
  mode,
  equity,
  openPositions,
  lastEvalAt,
  closedCount,
  importedCount,
  isSystemBookActive,
}: {
  mode: string;
  /** 페이퍼 가상 잔고 — 데모·라이브는 null(거래소가 정본) */
  equity: number | null;
  openPositions: string[];
  /** 마지막으로 평가한 마감 봉 시각(ms) — 봇이 살아 있는지의 근거 */
  lastEvalAt: number | null;
  closedCount: number;
  importedCount: number;
  /** 지금 보고 있는 북이 시스템 북인가 — 안내 문구가 바뀐다 */
  isSystemBookActive: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<SystemSyncState>({});
  const unsynced = Math.max(0, closedCount - importedCount);

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div>
          <h2 className="text-sm font-medium">
            시스템 트레이딩{" "}
            <span className="rounded border border-accent px-1.5 py-0.5 text-[10px] font-semibold text-accent uppercase">
              {mode}
            </span>
          </h2>
          <p className="mt-0.5 text-[11px] text-dim">
            쿼드 공격형 봇 · 4시간마다 자동 평가
            {lastEvalAt !== null
              ? ` · 마지막 평가 ${new Date(lastEvalAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`
              : " · 아직 실행 전"}
          </p>
        </div>

        <div className="tnum text-[11px] leading-relaxed text-dim">
          {equity !== null ? (
            <>
              봇 잔고 <b className="text-text">${equity}</b>
              <br />
            </>
          ) : null}
          열린 포지션 <b className="text-text">{openPositions.length ? openPositions.join(", ") : "없음"}</b> · 완결{" "}
          <b className="text-text">{closedCount}건</b>
          {unsynced > 0 ? <b className="text-beta"> (미반영 {unsynced}건)</b> : null}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setState({});
                setState(await syncSystemBook());
              })
            }
            className="rounded-lg border border-border px-3 py-2 text-sm text-dim hover:text-text disabled:opacity-50"
          >
            {pending ? "가져오는 중…" : "시스템 북으로 가져오기"}
          </button>
        </div>
      </div>

      {state.error ? <p className="mt-2 text-xs text-loss">{state.error}</p> : null}
      {state.message ? <p className="mt-2 text-xs text-dim">{state.message}</p> : null}
      <p className="mt-2 text-[11px] text-dim">
        {isSystemBookActive
          ? "지금 시스템 북을 보고 있습니다 — 상단 북 선택에서 기존 북으로 돌아갈 수 있습니다."
          : "가져온 거래는 별도의 “시스템 트레이딩 (페이퍼)” 북에 쌓입니다 — 상단 북 선택으로 기존 거래와 나눠 봅니다."}
      </p>
    </section>
  );
}
