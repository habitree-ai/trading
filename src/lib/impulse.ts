/**
 * 뇌동매매지수(REQ-0076) — 청산 뒤 다음 진입까지의 공백을 기간과 금액으로 재서 0~100 으로 낸다.
 *
 * 파괴 패턴은 「손실 직후, 더 크게, 빨리」 다시 들어가는 것이다(REQ-0054). 세 축을 따로 재서
 * 가중합한다 — 직전 손실이 잔고 대비 얼마였나, 다음 증거금이 직전보다 얼마나 커졌나, 공백이
 * 얼마나 짧았나. 지수와 함께 권장 대기시간을 낸다: 기본 60분(REQ-0058 규칙) + 손실이 클수록 더.
 * 경고용이다 — 주문을 막지 않는다.
 */

import { formatDuration } from "@/components/measure-tool";

/** 가중치·만점 기준 — 초기값. 과거 거래 분포를 보고 조정한다. */
export const IMPULSE = {
  weightLoss: 40,
  weightSize: 30,
  weightTime: 30,
  /** 직전 손실이 잔고의 이만큼이면 손실항 만점 — 현재 거래당 리스크(10%) */
  lossFull: 0.1,
  /** 공백이 이보다 길면 시간항 0 */
  timeFullMs: 4 * 60 * 60_000,
  /** 청산 뒤 기본 대기 — docs/repeatable §2.2 의 60분 규칙 */
  baseWaitMs: 60 * 60_000,
  /** 손실항 만점일 때 더 기다릴 시간 */
  extraWaitMs: 180 * 60_000,
} as const;

/** 직전 청산 거래 — 기산점이 된 그 거래 */
export interface PrevExit {
  /** 계좌가 실제로 움직인 금액(`netOf`) */
  net: number;
  /** 그 거래 진입 직전 자금 — 손실을 잔고 대비로 재는 분모 */
  equityBefore: number | null;
  /** 그 거래의 증거금(`marginOf`) */
  margin: number | null;
}

export interface Impulse {
  /** 0~100 */
  score: number;
  /** 각 항 0~1 */
  loss: number;
  size: number;
  time: number;
  gapMs: number;
  /** 직전 손익의 잔고 대비 비율(음수 = 손실). 잔고를 모르면 null */
  prevNetPct: number | null;
  /** 다음 증거금 ÷ 직전 증거금. 둘 중 하나를 모르면 null */
  marginRatio: number | null;
  /** 이 진입에 권장됐던 대기시간 */
  waitMs: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 손실항 — 이익이거나 잔고를 모르면 0 (모르는 값을 손실로 치지 않는다) */
function lossTerm(prev: PrevExit): { loss: number; prevNetPct: number | null } {
  const eq = prev.equityBefore;
  const prevNetPct = eq !== null && eq > 0 ? prev.net / eq : null;
  const loss = prevNetPct !== null && prevNetPct < 0 ? clamp01(-prevNetPct / IMPULSE.lossFull) : 0;
  return { loss, prevNetPct };
}

/** 직전 청산 뒤 권장 대기시간 — 기본 60분 + 손실항 × 180분 */
export function requiredWaitMs(prev: PrevExit): number {
  return IMPULSE.baseWaitMs + lossTerm(prev).loss * IMPULSE.extraWaitMs;
}

/** 공백 `gapMs` 뒤 증거금 `nextMargin` 으로 들어갈 때(또는 들어갔을 때)의 지수 */
export function impulseIndex(prev: PrevExit, gapMs: number, nextMargin: number | null): Impulse {
  const { loss, prevNetPct } = lossTerm(prev);
  const marginRatio =
    prev.margin !== null && prev.margin > 0 && nextMargin !== null && nextMargin > 0
      ? nextMargin / prev.margin
      : null;
  const size = marginRatio === null ? 0 : clamp01(marginRatio - 1);
  const time = clamp01(1 - Math.max(gapMs, 0) / IMPULSE.timeFullMs);
  const score = Math.round(IMPULSE.weightLoss * loss + IMPULSE.weightSize * size + IMPULSE.weightTime * time);
  return { score, loss, size, time, gapMs, prevNetPct, marginRatio, waitMs: requiredWaitMs(prev) };
}

/** 지수 구간 — 색·문구를 한 곳에서 */
export function impulseLevel(score: number): "low" | "mid" | "high" {
  if (score >= 60) return "high";
  if (score >= 30) return "mid";
  return "low";
}

/** 지수 구간 색(Tailwind) — 표·노트·무포지션 화면이 같은 색을 쓴다. 낮으면 흐리게, 높을수록 진하게 */
export function impulseTone(score: number): string {
  return { low: "text-dim", mid: "text-beta", high: "font-medium text-loss" }[impulseLevel(score)];
}

/** 지수의 재료를 한 줄로 — 표의 툴팁과 노트 상세가 같은 문구를 쓴다 */
export function describeImpulse(i: Impulse): string {
  const parts = [
    `직전 손익 ${i.prevNetPct === null ? "잔고 모름" : `${i.prevNetPct > 0 ? "+" : ""}${(i.prevNetPct * 100).toFixed(1)}%`}`,
    `증거금 ${i.marginRatio === null ? "비교 불가" : `×${i.marginRatio.toFixed(2)}`}`,
    `공백 ${formatDuration(i.gapMs)}`,
    `권장 대기 ${formatDuration(i.waitMs)}`,
  ];
  return parts.join(" · ");
}
