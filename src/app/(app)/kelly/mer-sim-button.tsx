"use client";

import { useState } from "react";

import { runMerSimulation, type MerSimFailure, type MerSimResult } from "@/app/(app)/kelly/mer-actions";

/** 직전 실행 결과 — 새로 불러온 화면이 주소(`sim=넣음.남음.실패`)에서 읽어 보인다. */
export interface MerSimLast {
  done: number;
  remaining: number;
  failed: number;
}

/**
 * 「시뮬 갱신」 — 한 번에 7초까지 돌고 남은 건수를 알려 준다(REQ-0102 D6). 다시 누르면 이어서 한다.
 *
 * 넣은 게 있으면 페이지를 새로 불러온다(REQ-0103). router.refresh·액션 응답 갱신은 연속 실행 때 이 앱에서
 * 적용이 멈춰 「미계산」·MER 표가 옛 값으로 남았다(실측). 새로 불러오면 숫자는 언제나 DB 와 같다.
 */
export function MerSimButton({
  pending: pendingCount,
  excluded,
  last,
}: {
  pending: number;
  excluded: MerSimFailure[];
  last: MerSimLast | null;
}) {
  const [running, setRunning] = useState(false);
  // 새로 불러오지 않는 경우(넣은 것 없음·오류)만 여기 담는다
  const [result, setResult] = useState<MerSimResult | null>(null);

  const run = async () => {
    setRunning(true);
    const res = await runMerSimulation().catch(
      (e: unknown): MerSimResult => ({
        done: 0,
        remaining: 0,
        failed: 0,
        failures: [],
        error: e instanceof Error ? e.message : "시뮬을 실행하지 못했습니다",
      }),
    );
    if (res.done > 0 && !res.error) {
      const q = new URLSearchParams(window.location.search);
      q.set("sim", `${res.done}.${res.remaining}.${res.failed}`);
      window.location.assign(`${window.location.pathname}?${q.toString()}`);
      return; // 새 화면이 뜰 때까지 「시뮬 중…」 유지
    }
    setResult(res);
    setRunning(false);
  };

  const shown: (MerSimLast & { failures: MerSimFailure[]; error?: string }) | null = result
    ? result
    : last
      ? { ...last, failures: [] }
      : null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        disabled={running || pendingCount === 0}
        onClick={run}
        className="rounded-lg border border-border bg-surface px-2.5 py-1 text-accent disabled:opacity-40"
      >
        {running ? "시뮬 중…" : "시뮬 갱신"}
      </button>
      <span className="text-dim">미계산 {pendingCount}건</span>
      {excluded.length > 0 ? (
        <span className="text-dim" title={excluded.map((f) => `#${f.seq} ${f.symbol}: ${f.reason}`).join("\n")}>
          · 제외 {excluded.length}건(첫 진입가 기준으로 구간을 못 정함)
        </span>
      ) : null}
      {shown ? (
        shown.error ? (
          <span className="text-loss">{shown.error}</span>
        ) : (
          <span className="text-dim">
            이번 {shown.done}건 넣음
            {shown.remaining > 0 ? ` · 시간이 다 돼 ${shown.remaining}건 남음(다시 누르면 이어서)` : ""}
            {shown.failed > 0 ? (
              <span className="text-beta" title={shown.failures.map((f) => `#${f.seq} ${f.symbol}: ${f.reason}`).join("\n")}>
                {" "}
                · 실패 {shown.failed}건
                {shown.failures.length > 0
                  ? ` — ${shown.failures.slice(0, 2).map((f) => `#${f.seq} ${f.reason}`).join(", ")}${shown.failed > 2 ? " …" : ""}`
                  : " — 다시 누르면 재시도"}
              </span>
            ) : null}
          </span>
        )
      ) : null}
    </div>
  );
}
