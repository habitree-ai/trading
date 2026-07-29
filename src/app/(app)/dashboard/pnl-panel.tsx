"use client";

import { useState } from "react";

import { PnlBars, type PnlBar } from "@/components/charts";

type Unit = "day" | "month";

const UNIT_LABEL: Record<Unit, string> = { day: "일별", month: "월별" };

/**
 * 기간별 손익 — 일별/월별 전환.
 *
 * 두 묶음 다 서버에서 미리 계산해 받는다. 거래 수가 수백 건이라 클라이언트에서
 * 다시 묶어도 되지만, 그러면 집계 산식이 서버와 두 벌이 된다.
 */
export function PnlPanel({
  daily,
  monthly,
  currency,
}: {
  daily: PnlBar[];
  monthly: PnlBar[];
  currency: string;
}) {
  const [unit, setUnit] = useState<Unit>("month");
  const data = unit === "day" ? daily : monthly;

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">
          {UNIT_LABEL[unit]} 손익{" "}
          <span className="font-normal text-dim">
            — 0선 위가 이익, 아래가 손실 ({currency})
          </span>
        </h2>
        <div className="ml-auto flex rounded-lg border border-border p-0.5">
          {(["day", "month"] as const).map((u) => (
            <button
              key={u}
              type="button"
              aria-pressed={unit === u}
              onClick={() => setUnit(u)}
              className={`rounded-md px-2.5 py-1 text-xs ${
                unit === u ? "bg-accent text-white" : "text-dim hover:text-text"
              }`}
            >
              {UNIT_LABEL[u]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3">
        {data.length === 0 ? (
          <p className="py-10 text-center text-sm text-dim">표시할 거래가 없습니다.</p>
        ) : (
          <PnlBars data={data} currency={currency} />
        )}
      </div>
    </section>
  );
}
