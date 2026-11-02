"use client";

import { useState } from "react";

import type { Side } from "@/lib/domain";
import { CALC_UNMEASURED_LABEL, entryCalc, parsePositive, type Sizing } from "@/lib/entry-calc";
import { DASH, num, pct, price } from "@/lib/format";

const INPUT = "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm tnum outline-none focus:border-accent";
const LABEL = "mb-1 block text-xs text-dim";

/** 코인 수량 — 크기에 맞춰 자릿수를 바꾼다(BTC 0.00909 · ONDO 1,190). */
export function qtyText(q: number | null): string {
  if (q === null || !Number.isFinite(q)) return DASH;
  const abs = Math.abs(q);
  return num(q, abs >= 100 ? 0 : abs >= 1 ? 2 : 5);
}

export interface EntryCalcProps {
  rBase: number;
  feeRate: number;
  equity: number | null;
  /** 축소 단계(누적 연패)면 목표 위험 배율 0.5 */
  riskFactor: number;
  /** 연속 손실 상태 문구 — 축소·당일 중단·휴식. 없으면 null */
  streakNote: string | null;
}

/**
 * 진입 계산기 — 진입가·최초 손절 → 1R 수량·명목·레버리지·비용R, 넣을 수량의 위험 배수(REQ-0098).
 * 계산만 한다. 주문도 저장도 하지 않는다.
 */
export function EntryCalcPanel({ rBase, feeRate, equity, riskFactor, streakNote }: EntryCalcProps) {
  const [side, setSide] = useState<Side>("long");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [qty, setQty] = useState("");

  const calc = entryCalc({
    side,
    entry: parsePositive(entry),
    stop: parsePositive(stop),
    rBase,
    feeRate,
    equity,
    riskFactor,
    qty: parsePositive(qty),
  });
  const shrink = riskFactor < 1;
  const touched = entry.trim() !== "" || stop.trim() !== "";

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">
          진입 계산기{" "}
          <span className="font-normal text-dim">
            — 기준 R {num(rBase, 2)} USDT · 수수료 {pct(feeRate, 3)} · 자금{" "}
            {equity === null ? DASH : `${num(equity, 2)} USDT`}
          </span>
        </h2>
        {streakNote ? (
          <span
            className={`rounded-md px-2 py-0.5 text-xs ${shrink ? "bg-beta/10 text-beta" : "bg-loss/10 text-loss"}`}
          >
            {streakNote}
          </span>
        ) : null}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <span className={LABEL}>방향</span>
          <div className="flex gap-1" role="group" aria-label="방향">
            {(["long", "short"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                aria-pressed={side === s}
                className={`flex-1 rounded-lg border px-2 py-2 text-sm ${
                  side === s
                    ? s === "long"
                      ? "border-profit/50 bg-profit/10 text-profit"
                      : "border-loss/50 bg-loss/10 text-loss"
                    : "border-border text-dim hover:bg-surface-2"
                }`}
              >
                {s === "long" ? "롱" : "숏"}
              </button>
            ))}
          </div>
        </div>
        <label>
          <span className={LABEL}>진입가</span>
          <input className={INPUT} inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} />
        </label>
        <label>
          <span className={LABEL}>최초 손절</span>
          <input className={INPUT} inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} />
        </label>
        <label>
          <span className={LABEL}>넣을 수량 (선택)</span>
          <input
            className={INPUT}
            inputMode="decimal"
            value={qty}
            placeholder="코인 개수"
            onChange={(e) => setQty(e.target.value)}
          />
        </label>
      </div>

      {!touched ? (
        <p className="mt-3 text-xs text-dim">진입가와 최초 손절을 넣으면 1R 수량이 나옵니다.</p>
      ) : !calc.measured ? (
        <p className="mt-3 text-sm text-beta">R 미측정 — {CALC_UNMEASURED_LABEL[calc.reason]}</p>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <SizeCard
              title={shrink ? `${riskFactor}R 수량 (축소 단계)` : "1R 수량"}
              note={`손절되면 ${num(calc.targetRisk, 2)} USDT(수수료 포함)를 잃는 수량`}
              size={calc.target}
              strong
            />
            {calc.actual ? (
              <SizeCard
                title="넣을 수량"
                note={`손절되면 −${num(calc.actual.riskMultiple, 2)}R (${num(calc.actual.riskMultiple * rBase, 2)} USDT)`}
                size={calc.actual}
                warn={calc.over}
              />
            ) : null}
          </div>
          {calc.over && calc.actual ? (
            <p className="text-sm text-loss">
              기준 R 의 {num(calc.actual.riskMultiple, 2)}배 — {shrink ? `축소 단계 목표 ${riskFactor}R` : "1R"} 을
              넘습니다. {qtyText(calc.target.qty)}개 이하로 줄이거나 손절을 좁혀야 합니다.
            </p>
          ) : null}
          <p className="text-xs leading-relaxed text-dim">
            손절폭 {price(calc.d0)} · 왕복 비용 개당 {price(calc.costPerUnit)}
            {shrink ? ` · 1R 수량 ${qtyText(calc.full.qty)}개` : ""} · 1E(가격만) {qtyText(calc.oneE)}개 — 1R 수량은
            수수료까지 넣어 손절 시 손실이 목표 위험과 같게 맞춘 값입니다.
          </p>
        </div>
      )}
    </section>
  );
}

function SizeCard({
  title,
  note,
  size,
  strong = false,
  warn = false,
}: {
  title: string;
  note: string;
  size: Sizing;
  strong?: boolean;
  warn?: boolean;
}) {
  return (
    <div className={`rounded-lg border p-3 ${warn ? "border-loss/50 bg-loss/5" : "border-border bg-surface-2/40"}`}>
      <div className="text-xs text-dim">{title}</div>
      <div className={`tnum mt-1 text-xl ${strong ? "font-semibold" : ""} ${warn ? "text-loss" : ""}`}>
        {qtyText(size.qty)}개
      </div>
      <dl className="tnum mt-2 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-dim">명목</dt>
          <dd>{num(size.notional, 2)} USDT</dd>
        </div>
        <div>
          <dt className="text-dim">레버리지</dt>
          <dd>{size.leverage === null ? DASH : `${num(size.leverage, 2)}배`}</dd>
        </div>
        <div>
          <dt className="text-dim">비용R</dt>
          <dd>{num(size.costR, 2)}R</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-dim">{note}</p>
    </div>
  );
}
