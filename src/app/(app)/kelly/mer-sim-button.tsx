"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { runMerSimulation, type MerSimResult } from "@/app/(app)/kelly/mer-actions";

/** 「시뮬 갱신」 — 한 번에 7초까지 돌고 남은 건수를 알려 준다(REQ-0102 D6). 다시 누르면 이어서 한다. */
export function MerSimButton({ pending: pendingCount }: { pending: number }) {
  // 트랜지션으로 감싸면 두 번째 실행부터 화면 갱신이 끝나지 않아 버튼이 「시뮬 중…」에 멈췄다 — 액션이 끝나면 바로 풀고 갱신은 따로.
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<MerSimResult | null>(null);
  const router = useRouter();

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        disabled={running || pendingCount === 0}
        onClick={async () => {
          setRunning(true);
          try {
            setResult(await runMerSimulation());
          } finally {
            setRunning(false);
            router.refresh();
          }
        }}
        className="rounded-lg border border-border bg-surface px-2.5 py-1 text-accent disabled:opacity-40"
      >
        {running ? "시뮬 중…" : "시뮬 갱신"}
      </button>
      <span className="text-dim">미계산 {pendingCount}건</span>
      {result ? (
        result.error ? (
          <span className="text-loss">{result.error}</span>
        ) : (
          <span className="text-dim">
            이번 {result.done}건 넣음
            {result.remaining > 0 ? ` · 시간이 다 돼 ${result.remaining}건 남음(다시 누르면 이어서)` : ""}
            {result.failed > 0 ? (
              <span className="text-beta" title={result.failures.map((f) => `#${f.seq} ${f.symbol}: ${f.reason}`).join("\n")}>
                {" "}
                · 실패 {result.failed}건 — {result.failures.slice(0, 2).map((f) => `#${f.seq} ${f.reason}`).join(", ")}
                {result.failed > 2 ? " …" : ""}
              </span>
            ) : null}
          </span>
        )
      ) : null}
    </div>
  );
}
