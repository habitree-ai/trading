/**
 * 진입 계산기 — 진입가·최초 손절로 1R 수량·명목·레버리지·비용R·위험 배수를 미리 잰다(REQ-0098).
 *
 * 정본 명세: Claude Docs 「R·트레이딩 엣지·CR·E 서비스 반영 명세」 진입 계산기 · 계산 예시 ①.
 *
 * - 왕복 비용(코인 1개당) = (진입가 + 손절) × 수수료율 — `r-multiple.ts` 위험 배수와 같은 식
 * - 1R 수량 = 목표 위험 ÷ (손절폭 + 왕복 비용) — **비용 포함**(11-01 결정). 이 수량이면 손절 시 정확히 목표 위험을 잃는다
 * - 1E 수량 = 기준 R ÷ 손절폭 — 가격만(책 정의). 참고로 같이 보인다
 * - 위험 배수 = (손절폭 + 왕복 비용) × 수량 ÷ 기준 R — 손절되면 기준 R 로 이만큼 잃는다
 * - 축소 단계(REQ-0097 누적 연패)면 목표 위험 = 기준 R × 0.5 — 경고 기준도 같이 낮아진다
 */
import type { Side } from '@/lib/domain';
import { stopDistance } from '@/lib/r-multiple';

type Maybe = number | null;

export type CalcUnmeasured = 'no_entry' | 'no_stop' | 'stop_wrong_side';

export const CALC_UNMEASURED_LABEL: Record<CalcUnmeasured, string> = {
  no_entry: '진입가 없음',
  no_stop: '최초 손절 없음',
  stop_wrong_side: '손절이 이익 쪽',
};

export interface EntryCalcInput {
  side: Side;
  entry: Maybe;
  stop: Maybe;
  /** 기준 R (USDT) */
  rBase: number;
  /** 예상 수수료율(한쪽) — 0.0005 = 0.05% */
  feeRate: number;
  /** 자금(USDT) — 레버리지 분모. 없으면 레버리지를 비운다 */
  equity: Maybe;
  /** 목표 위험 배율 — 평소 1, 축소 단계 0.5 */
  riskFactor: number;
  /** 넣을 수량(코인) — 비면 1R 수량 기준으로만 보인다 */
  qty?: Maybe;
}

export interface Sizing {
  qty: number;
  notional: number;
  leverage: Maybe;
  /** 예상 왕복 비용 ÷ 기준 R */
  costR: number;
  /** 손절되면 기준 R 로 잃는 배수(비용 포함) */
  riskMultiple: number;
}

export type EntryCalc =
  | { measured: false; reason: CalcUnmeasured }
  | {
      measured: true;
      /** 손절폭 */
      d0: number;
      /** 코인 1개당 왕복 비용 */
      costPerUnit: number;
      /** 목표 위험(USDT) = 기준 R × 배율 */
      targetRisk: number;
      /** 목표 위험만큼 거는 수량(비용 포함) */
      target: Sizing;
      /** 1R 수량(비용 포함) — 축소 단계일 때 옆에 작게 보이는 값 */
      full: Sizing;
      /** 1E 수량 — 가격만 */
      oneE: number;
      /** 넣을 수량을 적었을 때 */
      actual: Sizing | null;
      /** 넣을 수량의 위험 배수가 목표 배율을 넘는가 */
      over: boolean;
    };

const pos = (v: Maybe | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v) && v > 0;

const EPS = 1e-9;

export function entryCalc(input: EntryCalcInput): EntryCalc {
  const { side, entry, stop, rBase, equity, riskFactor } = input;
  if (!pos(entry)) return { measured: false, reason: 'no_entry' };
  if (!pos(stop)) return { measured: false, reason: 'no_stop' };
  const d0 = stopDistance(side, entry, stop);
  if (!(d0 > 0)) return { measured: false, reason: 'stop_wrong_side' };

  const feeRate = Number.isFinite(input.feeRate) && input.feeRate > 0 ? input.feeRate : 0;
  const costPerUnit = (entry + stop) * feeRate;
  const size = (qty: number): Sizing => {
    const notional = qty * entry;
    return {
      qty,
      notional,
      leverage: pos(equity) ? notional / equity : null,
      costR: (costPerUnit * qty) / rBase,
      riskMultiple: ((d0 + costPerUnit) * qty) / rBase,
    };
  };

  const targetRisk = rBase * riskFactor;
  const actual = pos(input.qty) ? size(input.qty) : null;
  return {
    measured: true,
    d0,
    costPerUnit,
    targetRisk,
    target: size(targetRisk / (d0 + costPerUnit)),
    full: size(rBase / (d0 + costPerUnit)),
    oneE: rBase / d0,
    actual,
    over: actual !== null && actual.riskMultiple > riskFactor + EPS,
  };
}

/** 입력 칸 문자열 → 양수. 비었거나 숫자가 아니면 null (쉼표 허용). */
export function parsePositive(text: string): Maybe {
  const v = Number(text.trim().replace(/,/g, ''));
  return text.trim() !== '' && Number.isFinite(v) && v > 0 ? v : null;
}
