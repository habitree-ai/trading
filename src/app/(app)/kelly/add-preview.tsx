"use client";

import { useState } from "react";

import { qtyText } from "@/app/(app)/kelly/entry-calc";
import type { Side } from "@/lib/domain";
import { parsePositive } from "@/lib/entry-calc";
import { DASH, num, price } from "@/lib/format";
import { previewAdd, type PositionState } from "@/lib/position-r";

const INPUT = "w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm tnum outline-none focus:border-accent";
const LABEL = "mb-1 block text-xs text-dim";

export interface AddPreviewProps {
  side: Side;
  rBase: number;
  oneE: number | null;
  /** 진입 때 CR */
  cr0: number | null;
  qty: number;
  avgPx: number;
  stopPx: number | null;
  /** 추가 가격 기본값 — 현재가. 조회 실패면 빈 칸 */
  livePrice: number | null;
}

/**
 * 추가 진입 미리 보기 — 지금 손절을 그대로 둔 채 더 사면 평단·E·CR 이 어떻게 되나(REQ-0098).
 * 손절을 올리지 않고 추가해 CR 이 커지는 것을 진입 전에 보이려는 칸이다.
 */
export function AddPreviewPanel(props: AddPreviewProps) {
  const { stopPx, cr0 } = props;
  const [addPrice, setAddPrice] = useState(props.livePrice === null ? "" : String(props.livePrice));
  const [addQty, setAddQty] = useState("");

  const p = parsePositive(addPrice);
  const q = parsePositive(addQty);
  const preview = p !== null && q !== null ? previewAdd({ ...props, addPrice: p, addQty: q }) : null;

  return (
    <details className="mt-3 rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-sm">
        추가 미리 보기{" "}
        <span className="text-xs text-dim">— 손절 {stopPx === null ? "없음" : price(stopPx)} 그대로 둘 때</span>
      </summary>
      <div className="space-y-3 border-t border-border p-3">
        <div className="grid grid-cols-2 gap-3 sm:max-w-md">
          <label>
            <span className={LABEL}>추가 가격</span>
            <input
              className={INPUT}
              inputMode="decimal"
              value={addPrice}
              onChange={(e) => setAddPrice(e.target.value)}
            />
          </label>
          <label>
            <span className={LABEL}>추가 수량</span>
            <input
              className={INPUT}
              inputMode="decimal"
              value={addQty}
              placeholder="코인 개수"
              onChange={(e) => setAddQty(e.target.value)}
            />
          </label>
        </div>
        {preview === null ? (
          <p className="text-xs text-dim">추가 가격과 수량을 넣으면 추가 뒤 CR·E 가 나옵니다.</p>
        ) : (
          <>
            <table className="tnum text-sm">
              <thead>
                <tr className="text-xs text-dim">
                  <th className="py-1 pr-4 text-left font-normal" />
                  <th className="px-3 py-1 text-right font-normal">지금</th>
                  <th className="px-3 py-1 text-right font-normal">추가 뒤</th>
                </tr>
              </thead>
              <tbody>
                <Row label="수량" pick={(s) => `${qtyText(s.qty)}개`} preview={preview} />
                <Row label="평단" pick={(s) => price(s.avgPx)} preview={preview} />
                <Row label="E" pick={(s) => plain(s.e)} preview={preview} />
                <Row label="CR" pick={(s) => plain(s.cr)} preview={preview} warn={preview.riskUp} />
                <Row label="잠긴 R" pick={(s) => plain(s.lockedR)} preview={preview} />
              </tbody>
            </table>
            {preview.riskUp ? (
              <p className="text-sm text-loss">
                손절을 {price(stopPx)}에 둔 채 추가하면 CR {plain(preview.after.cr)} — 처음 위험({plain(cr0)})의{" "}
                {cr0 !== null && cr0 > 0 && preview.after.cr !== null ? num(preview.after.cr / cr0, 1) : DASH}배입니다.
                손절을 먼저 옮기거나 수량을 줄여야 합니다.
              </p>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}

const plain = (v: number | null) => (v === null ? DASH : num(v, 2));

function Row({
  label,
  pick,
  preview,
  warn = false,
}: {
  label: string;
  pick: (s: PositionState) => string;
  preview: { before: PositionState; after: PositionState };
  warn?: boolean;
}) {
  return (
    <tr className="border-t border-border/60">
      <td className="py-1 pr-4 text-dim">{label}</td>
      <td className="px-3 py-1 text-right">{pick(preview.before)}</td>
      <td className={`px-3 py-1 text-right font-medium ${warn ? "text-loss" : ""}`}>{pick(preview.after)}</td>
    </tr>
  );
}
