"use client";

import { useState } from "react";

import {
  annualFromMonthly,
  CONTRIBUTIONS,
  dailyFromMonthly,
  DEFAULT_KRW_PER_USD,
  DEFAULT_MONTHLY_CONTRIBUTION,
  HORIZONS_MONTHS,
  monthsToTarget,
  requiredMonthlyRate,
  TARGET_KRW,
  weeklyFromMonthly,
  type PlanTier,
} from "@/lib/compound-plan";
import { num, pct } from "@/lib/format";

const INPUT =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent tnum";
const LABEL = "block text-xs text-dim mb-1";

function months(m: number | null): string {
  if (m === null) return "닿지 않음";
  if (m === 0) return "이미 도달";
  return m >= 24 ? `${m}개월 (${num(m / 12, 1)}년)` : `${m}개월`;
}

/**
 * 필요 수익률 계산기 — 입력을 바꾸면 표가 그 자리에서 다시 계산된다. 저장하지 않는다:
 * 계획(β/α)은 아래 폼이 저장하고, 여기는 "그 계획이 어디쯤인가"를 보는 자다.
 */
export function PlanCalculator({
  start,
  beta,
  alpha,
}: {
  start: number;
  beta: PlanTier;
  alpha: PlanTier;
}) {
  const [startValue, setStartValue] = useState(Math.max(0, Math.round(start * 100) / 100));
  const [monthly, setMonthly] = useState(DEFAULT_MONTHLY_CONTRIBUTION);
  const [fx, setFx] = useState(DEFAULT_KRW_PER_USD);
  const [targetKrw, setTargetKrw] = useState(TARGET_KRW);

  const targetUsd = fx > 0 ? targetKrw / fx : 0;
  const columns = [...new Set<number>([...CONTRIBUTIONS, monthly])].sort((a, b) => a - b);
  const rates: { label: string; rate: number; tone: string }[] = [
    { label: "β", rate: beta.monthly, tone: "text-profit" },
    { label: "α", rate: alpha.monthly, tone: "text-beta" },
    { label: "1%", rate: 0.01, tone: "" },
    { label: "3%", rate: 0.03, tone: "" },
    { label: "10%", rate: 0.1, tone: "" },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className={LABEL} htmlFor="calc_start">
            시작 자금 (USDT)
          </label>
          <input id="calc_start" type="number" min="0" step="1" value={startValue} onChange={(e) => setStartValue(Number(e.target.value))} className={INPUT} />
        </div>
        <div>
          <label className={LABEL} htmlFor="calc_monthly">
            월 납입 (USDT)
          </label>
          <input id="calc_monthly" type="number" min="0" step="10" value={monthly} onChange={(e) => setMonthly(Number(e.target.value))} className={INPUT} />
        </div>
        <div>
          <label className={LABEL} htmlFor="calc_target">
            목표 (KRW)
          </label>
          <input id="calc_target" type="number" min="0" step="1000000" value={targetKrw} onChange={(e) => setTargetKrw(Number(e.target.value))} className={INPUT} />
        </div>
        <div>
          <label className={LABEL} htmlFor="calc_fx">
            환율 (KRW/USD)
          </label>
          <input id="calc_fx" type="number" min="1" step="10" value={fx} onChange={(e) => setFx(Number(e.target.value))} className={INPUT} />
        </div>
      </div>
      <p className="tnum text-[11px] text-dim">
        목표 {num(targetKrw, 0)}원 = <b className="text-text">{num(targetUsd, 0)} USDT</b> · 매월 말 납입, 월 복리 기준
      </p>

      <div className="scroll-x">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-dim">
              <th className="py-1 pr-3 font-normal">기간</th>
              {columns.map((c) => (
                <th key={c} className={`py-1 pr-3 font-normal ${c === monthly ? "text-text" : ""}`}>
                  납입 {num(c, 0)}$
                </th>
              ))}
              <th className="py-1 font-normal">납입 0</th>
            </tr>
          </thead>
          <tbody>
            {HORIZONS_MONTHS.map((n) => (
              <tr key={n} className="border-t border-border">
                <td className="tnum py-1.5 pr-3">
                  {n / 12}년 <span className="text-[11px] text-dim">({n}개월)</span>
                </td>
                {columns.map((c) => {
                  const r = requiredMonthlyRate(startValue, c, targetUsd, n);
                  const within = r <= beta.monthly ? "text-profit" : r <= alpha.monthly ? "text-beta" : "text-loss";
                  return (
                    <td key={c} className={`tnum py-1.5 pr-3 ${within} ${c === monthly ? "font-semibold" : ""}`}>
                      월 {pct(r, 2)}
                    </td>
                  );
                })}
                <td className="tnum py-1.5 text-dim">월 {pct(requiredMonthlyRate(startValue, 0, targetUsd, n), 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] leading-snug text-dim">
        색: <span className="text-profit">β 이내</span> · <span className="text-beta">β~α</span> ·{" "}
        <span className="text-loss">α 초과</span>. 3년 칸이 전부 붉은 것은 계산 오류가 아닙니다 —
        그 자리는 랩에서 기각된 월 10% 위에 있습니다.
      </p>

      <div className="grid gap-2 sm:grid-cols-5">
        {rates.map(({ label, rate, tone }) => (
          <div key={label} className="rounded-lg border border-border bg-surface px-3 py-2">
            <div className={`text-[11px] ${tone || "text-dim"}`}>
              월 {pct(rate, 2)} {label !== `${Math.round(rate * 100)}%` ? `(${label})` : ""}
            </div>
            <div className="tnum mt-0.5 text-sm font-medium">
              {months(monthsToTarget(startValue, monthly, rate, targetUsd))}
            </div>
            <div className="tnum mt-0.5 text-[11px] text-dim">
              주 {pct(weeklyFromMonthly(rate), 2)} · 일 {pct(dailyFromMonthly(rate), 3)} · 연{" "}
              {pct(annualFromMonthly(rate), 0)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
