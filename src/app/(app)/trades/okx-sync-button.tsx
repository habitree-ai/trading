"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";

import { runOkxSync, type SyncState } from "@/app/(app)/trades/actions";

/** 옆의 `기록 추가`(강조)에 눌리지 않게 한 단계 낮춘 버튼 톤. */
const SECONDARY = "rounded-lg border border-border px-3 py-2 text-sm text-dim hover:text-text";

/**
 * `auto` 면 화면이 뜰 때 한 번 스스로 받아 온다 — 무포지션 화면(REQ-0087)이 쓴다. 그 화면의 종결은
 * 새 진입이 동기화돼야 잡히는데, 버튼을 눌러야만 한다면 "저절로 끝난다"가 성립하지 않는다.
 */
export function OkxSyncButton({ auto = false }: { auto?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<SyncState>({});
  // 동기화가 끝나면 화면이 다시 그려지며 `auto` 가 바뀔 수 있다 — 그래도 한 번만 돈다.
  const autoRan = useRef(false);

  useEffect(() => {
    if (!auto || autoRan.current) return;
    autoRan.current = true;
    startTransition(async () => {
      setState(await runOkxSync());
    });
  }, [auto]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setState({});
            setState(await runOkxSync());
          })
        }
        className={`${SECONDARY} disabled:opacity-50`}
      >
        {pending ? "받는 중…" : "OKX 동기화"}
      </button>
      {state.error ? <span className="text-xs text-loss">{state.error}</span> : null}
      {state.message ? <span className="text-xs text-dim">{state.message}</span> : null}
    </div>
  );
}

/**
 * 동기화 자리 — 계정이 붙었으면 버튼, 아니면 연결하러 갈 링크.
 *
 * 계정이 안 붙은 북에서 이 자리를 비워 두면 동기화라는 기능이 있다는 것도, 쓰려면 뭘
 * 해야 하는지도 화면에 드러나지 않는다 — 설정을 이미 아는 사람만 찾아갈 수 있었다.
 *
 * 대시보드와 거래 목록이 같은 자리에 같은 걸 놓으므로 모양을 여기 한 벌만 둔다.
 */
export function SyncAction({ linked, auto = false }: { linked: boolean; auto?: boolean }) {
  if (linked) return <OkxSyncButton auto={auto} />;

  return (
    <Link href="/settings" className={SECONDARY}>
      거래소 연결
    </Link>
  );
}
