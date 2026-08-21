"use client";

import { useState, useTransition } from "react";

import { setLiveEnabled } from "@/app/(app)/system/killswitch-actions";
import type { SystemMode } from "@/lib/system-trading";

/**
 * 라이브 킬스위치 — 서버 사이클이 실주문을 낼지 여기서 정한다.
 *
 * 켜는 데는 확인이 필요하고 끄는 데는 필요 없다. 실주문 테스트 패널과 같은 문법이다:
 * 돈이 나가는 방향에만 문턱을 둔다.
 */
export function KillSwitch({ mode, enabled }: { mode: SystemMode; enabled: boolean }) {
  const [ack, setAck] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const flip = (next: boolean) =>
    start(async () => {
      setError(null);
      const result = await setLiveEnabled(mode, next);
      if (result.error) setError(result.error);
      setAck(false);
    });

  return (
    <div className="ml-auto text-right">
      <div className="text-[11px] text-dim">킬스위치</div>
      <div className={`mt-0.5 text-sm font-semibold ${enabled ? "text-profit" : "text-dim"}`}>
        {enabled ? "실주문 허용" : "실주문 차단"}
      </div>

      {enabled ? (
        <button
          type="button"
          onClick={() => flip(false)}
          disabled={pending}
          className="mt-1 rounded border border-loss px-2 py-1 text-[11px] font-medium text-loss disabled:opacity-50"
        >
          {pending ? "…" : "실주문 차단하기"}
        </button>
      ) : (
        <div className="mt-1 flex items-center justify-end gap-2">
          <label className="flex items-center gap-1 text-[11px] text-dim">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="accent-loss"
            />
            실주문을 허용합니다
          </label>
          <button
            type="button"
            onClick={() => flip(true)}
            disabled={pending || !ack}
            className="rounded border border-profit px-2 py-1 text-[11px] font-medium text-profit disabled:opacity-40"
          >
            {pending ? "…" : "허용"}
          </button>
        </div>
      )}

      {error ? <p className="mt-1 max-w-xs text-[11px] text-loss">{error}</p> : null}
    </div>
  );
}
