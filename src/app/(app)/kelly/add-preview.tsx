"use client";

import { useState } from "react";

import { AddChecklist, useTraderLevel } from "@/app/(app)/kelly/add-checklist";
import { qtyText } from "@/app/(app)/kelly/entry-calc";
import type { Side } from "@/lib/domain";
import { EDGE_MIN_SAMPLE } from "@/lib/edge";
import { parsePositive } from "@/lib/entry-calc";
import { DASH, num, price } from "@/lib/format";
import { MER_ZONES_R, zonePrice, type MerZoneRow, type ZoneR } from "@/lib/mer";
import { evaluateAddChecklist, type AccelSignal } from "@/lib/mer-check";
import { previewAdd, type PositionState } from "@/lib/position-r";
import { stopDistance } from "@/lib/r-multiple";
import type { ThresholdReport } from "@/lib/threshold/types";

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
  /* ── MER 피라미딩 판정 재료(REQ-0102) ── */
  tradeId: string;
  /** 최초 손절 — 구간 가격의 손절폭 d₀ */
  stop0: number | null;
  /** 첫 진입 체결가 — 구간·공통 손절의 기준 */
  entry0: number | null;
  feeRate: number | null;
  merRows: MerZoneRow[] | null;
  threshold: ThresholdReport | null;
  accel: AccelSignal[];
}

/**
 * 추가 진입 미리 보기 — 지금 손절을 그대로 둔 채 더 사면 평단·E·CR 이 어떻게 되나(REQ-0098).
 * 손절을 올리지 않고 추가해 CR 이 커지는 것을 진입 전에 보이려는 칸이다.
 *
 * 구간 칩(+1~+3R)을 누르면 그 가격과 공통 손절 기준 1R 수량이 들어가고, 아래에 추가 체크리스트 8줄과
 * 「다리 기록」이 붙는다(REQ-0102). 수량을 비우면 1R 수량으로 판정한다.
 */
export function AddPreviewPanel(props: AddPreviewProps) {
  const { side, stopPx, cr0, entry0, stop0, feeRate } = props;
  const [addPrice, setAddPrice] = useState(props.livePrice === null ? "" : String(props.livePrice));
  const [addQty, setAddQty] = useState("");
  const [zone, setZone] = useState<ZoneR | null>(null);
  const [level, setLevel] = useTraderLevel();

  const p = parsePositive(addPrice);
  const q = parsePositive(addQty);

  // 구간은 첫 진입가·최초 손절이 있어야 잰다
  const d0 = entry0 !== null && stop0 !== null ? stopDistance(side, entry0, stop0) : null;
  const zones = d0 !== null && d0 > 0 && entry0 !== null ? MER_ZONES_R.map((k) => ({ k, px: zonePrice(side, entry0, d0, k) })) : [];

  const check =
    p !== null && entry0 !== null && feeRate !== null
      ? evaluateAddChecklist({
          side,
          rBase: props.rBase,
          oneE: props.oneE,
          cr0,
          qty: props.qty,
          avgPx: props.avgPx,
          stopPx,
          entry0,
          feeRate,
          addPrice: p,
          addQty: q,
          zoneR: zone,
          merRows: props.merRows,
          threshold: props.threshold,
          level,
          accel: props.accel,
        })
      : null;
  // 수량을 적었으면 그대로, 비웠으면 1R 수량(체크리스트가 정한 값)
  const usedQty = q ?? check?.addQty ?? null;
  const preview = p !== null && usedQty !== null ? previewAdd({ ...props, addPrice: p, addQty: usedQty }) : null;

  const pickZone = (k: ZoneR, px: number) => {
    setZone(k);
    setAddPrice(String(Number(px.toPrecision(8))));
    setAddQty("");
  };
  const rowOf = (k: ZoneR) => props.merRows?.find((r) => r.zoneR === k) ?? null;

  return (
    <details className="mt-3 rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-sm">
        추가 미리 보기{" "}
        <span className="text-xs text-dim">— 손절 {stopPx === null ? "없음" : price(stopPx)} 그대로 둘 때 · 구간·체크리스트</span>
      </summary>
      <div className="space-y-3 border-t border-border p-3">
        {zones.length > 0 ? (
          <div>
            <span className={LABEL}>구간 — 최초 손절폭 {price(d0)} 의 배수, 첫 진입가 {price(entry0)} 기준</span>
            <div className="flex flex-wrap gap-1.5">
              {zones.map(({ k, px }) => {
                const row = rowOf(k);
                const n = row?.stats.n ?? 0;
                const thin = n < EDGE_MIN_SAMPLE;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => pickZone(k, px)}
                    className={`rounded-lg border px-2.5 py-1 text-left text-xs tnum ${
                      zone === k ? "border-accent" : row?.pass ? "border-profit/60" : "border-border"
                    } ${thin ? "text-dim" : ""}`}
                    title={row ? `MER ${num(row.mer, 2)} · N ${n}` : "MER 표 없음"}
                  >
                    <div className={`font-medium ${row?.pass ? "text-profit" : ""}`}>
                      +{k}R{row?.pass ? " ✓" : ""}
                    </div>
                    <div>{price(px)}</div>
                    <div>{row === null ? "MER —" : thin ? `N ${n}/${EDGE_MIN_SAMPLE}` : `MER ${num(row.mer, 2)}`}</div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="text-xs text-dim">
            {stop0 === null ? "최초 손절이 없어 구간(+1~+3R)을 잴 수 없습니다." : "첫 진입가를 몰라 구간을 잴 수 없습니다."}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3 sm:max-w-md">
          <label>
            <span className={LABEL}>추가 가격</span>
            <input
              className={INPUT}
              inputMode="decimal"
              value={addPrice}
              onChange={(e) => {
                setAddPrice(e.target.value);
                setZone(null);
              }}
            />
          </label>
          <label>
            <span className={LABEL}>추가 수량</span>
            <input
              className={INPUT}
              inputMode="decimal"
              value={addQty}
              placeholder={check?.sizing ? `1R ${qtyText(check.sizing.qty)}` : "코인 개수"}
              onChange={(e) => setAddQty(e.target.value)}
            />
          </label>
        </div>

        {check ? (
          <p className="text-xs text-dim tnum">
            공통 손절 {price(check.commonStop)} · 다리 1R {num(props.rBase, 2)} USDT
            {check.sizing ? ` · 1R 수량 ${qtyText(check.sizing.qty)}개 · 비용 ${num(check.sizing.costR, 2)}R` : " · 추가가가 공통 손절보다 불리"}
            {preview ? ` · 추가 뒤 CR ${plain(preview.after.cr)} · E ${plain(preview.after.e)}` : ""}
          </p>
        ) : null}

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

        {check ? (
          <div className="border-t border-border pt-3">
            <h3 className="mb-2 text-sm font-medium">
              추가 체크리스트 <span className="font-normal text-dim">— 8줄 모두 예일 때만 추가</span>
            </h3>
            <AddChecklist
              items={check.items}
              level={level}
              onLevelChange={setLevel}
              leg={
                p !== null && usedQty !== null
                  ? { tradeId: props.tradeId, price: p, qty: usedQty, zoneR: zone, commonStop: check.commonStop }
                  : null
              }
            />
          </div>
        ) : (
          <p className="text-xs text-dim">
            {feeRate === null ? "수수료율 설정이 없어 공통 손절을 잴 수 없습니다." : "첫 진입가를 몰라 체크리스트를 판정할 수 없습니다."}
          </p>
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
