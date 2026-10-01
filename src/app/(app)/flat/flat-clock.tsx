"use client";

import { useEffect, useState } from "react";

import { formatDuration } from "@/components/measure-tool";
import { impulseIndex, impulseTone, type PrevExit } from "@/lib/impulse";

/**
 * 흐르는 지금 — 서버가 그린 시각에서 출발해 브라우저 시계로 넘어간다.
 *
 * 처음 값을 서버와 같게 둬야 하이드레이션이 어긋나지 않는다(`nowMs` 주석).
 */
function useNow(initial: number): number {
  const [now, setNow] = useState(initial);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** 어떤 시각부터 지금까지 — 포지션의 보유 시간처럼 계속 흐른다. */
export function Elapsed({ since, now: initialNow }: { since: number; now: number }) {
  const now = useNow(initialNow);
  return <>{formatDuration(Math.max(now - since, 0))}</>;
}

/**
 * 기다림의 수치(규칙 쪽) — 직전 청산 뒤 권장 대기를 얼마나 채웠고, 지금 들어가면 지수가 얼마인가.
 *
 * 산식은 거래 표·노트와 같은 `impulseIndex`(REQ-0076)다. 아직 없는 진입이라 증거금은 직전과 같다고
 * 둔다 — 그래서 규모항은 0 이고, 지수는 직전 손실과 흐른 시간만으로 움직인다.
 */
export function WaitGauge({
  exitMs,
  prev,
  now: initialNow,
}: {
  exitMs: number;
  prev: PrevExit;
  now: number;
}) {
  const now = useNow(initialNow);
  const impulse = impulseIndex(prev, now - exitMs, prev.margin);
  const leftMs = impulse.waitMs - impulse.gapMs;
  const waiting = leftMs > 0;
  const filled = Math.min(1, Math.max(0, impulse.gapMs / impulse.waitMs));

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-border bg-surface-2 p-3">
          <div className="text-xs text-dim">직전 청산 후</div>
          <div className="tnum mt-1 text-xl font-semibold">{formatDuration(impulse.gapMs)}</div>
          <div className="mt-1 text-xs text-dim">가장 늦은 청산부터 — 종목을 가리지 않습니다</div>
        </div>
        <div className="rounded-xl border border-border bg-surface-2 p-3">
          <div className="text-xs text-dim">권장 대기</div>
          <div className="tnum mt-1 text-xl font-semibold">{formatDuration(impulse.waitMs)}</div>
          <div className="mt-1 text-xs text-dim">60분 + 직전 손실 비례 (최대 4시간)</div>
        </div>
        <div className="rounded-xl border border-border bg-surface-2 p-3">
          <div className="text-xs text-dim">{waiting ? "남은 대기" : "권장 대기를 넘긴 시간"}</div>
          <div className={`tnum mt-1 text-xl font-semibold ${waiting ? "text-loss" : "text-profit"}`}>
            {formatDuration(leftMs)}
          </div>
          <div className={`mt-1 text-xs ${waiting ? "text-loss" : "text-dim"}`}>
            {waiting ? "지금은 기다릴 때입니다" : "권장 대기를 채웠습니다"}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface-2 p-3">
          <div className="text-xs text-dim">지금 들어가면 뇌동지수</div>
          <div className={`tnum mt-1 text-xl font-semibold ${impulseTone(impulse.score)}`}>
            {impulse.score}
            <span className="text-xs font-normal text-dim"> / 100</span>
          </div>
          <div className="mt-1 text-xs text-dim">직전과 같은 증거금 가정 · 60 이상이면 높음</div>
        </div>
      </div>

      <div
        role="progressbar"
        aria-label="권장 대기 진행"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(filled * 100)}
        className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className={`h-full rounded-full ${waiting ? "bg-loss" : "bg-profit"}`}
          style={{ width: `${filled * 100}%` }}
        />
      </div>
      <div className="mt-1 text-xs text-dim">권장 대기의 {Math.round(filled * 100)}% 를 채웠습니다</div>
    </div>
  );
}
