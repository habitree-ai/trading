/**
 * 근거 게이트 주문의 계산부 — 화면과 서버 액션이 같은 숫자·같은 판정을 봐야 한다.
 *
 * 화면은 버튼을 열지 말지, 서버는 주문을 낼지 말지를 정하는데 둘이 다른 규칙을 쓰면
 * 화면에서 열린 버튼이 서버에서 거절되거나(짜증) 그 반대(사고)가 된다. 그래서 규칙은
 * 전부 여기 순수 함수로 두고 양쪽이 같은 함수를 부른다. 거래소·DB 는 모른다.
 */
import type { Side, Trade } from '@/lib/domain';
import { dayKey, isOpenTrade, netOf } from '@/lib/metrics';
import { positionMetrics } from '@/lib/position-tool';
import { DAILY_MAX_LOSSES, DAILY_MAX_TRADES } from '@/lib/trade-rules';

/**
 * 근거로 인정하는 최소 글자 수.
 *
 * 빈칸만 막으면 "ㅇ" 한 글자가 통과한다. 한 문장은 써야 근거다 — 20자는 "4시간봉 지지선
 * 되돌림에서 거래량 실림" 정도의 길이다.
 */
export const MIN_RATIONALE_CHARS = 20;

/**
 * 증거금에 얹는 여유 — 수수료(테이커 0.05%×2)와 시장가 체결 미끄러짐 몫.
 *
 * 격리 마진은 명목가÷레버리지가 그대로 잠기고 수수료는 잔고에서 따로 나간다.
 * 여유가 없으면 주문이 "증거금 부족"으로 거절되는데, 그 거절은 이미 근거를 다 적은 뒤에
 * 온다 — 화면에서 미리 막는 편이 낫다.
 */
export const MARGIN_BUFFER = 1.1;

/** OKX 무기한이 허용하는 레버리지 범위 — 종목마다 상한이 다르지만 BTC·ETH 는 100 이 넘는다. */
export const MAX_LEVERAGE = 100;

export interface SizingInput {
  /** 사람이 적는 투입 — 명목가(USDT) */
  notionalUsd: number;
  price: number;
  ctVal: number;
  lotSz: number;
  szDecimals: number;
}

export interface Sizing {
  /** 계약 수 — lotSz 단위로 내림 */
  contracts: number;
  /** 거래소에 보내는 문자열 — 소수 자리를 상품 규격에 맞춘다 */
  sz: string;
  /** 실제로 실리는 명목가 — 내림 때문에 적은 값보다 조금 작다 */
  notional: number;
}

/**
 * 명목가를 계약 수로 — 상품의 lot 단위로 내린다.
 *
 * 나눗셈을 그대로 두면 `0.30000000000000004` 같은 값이 나와 `toFixed` 가 반올림으로
 * 한 lot 을 더 실을 수 있다. lot 수를 정수로 만든 뒤 곱한다.
 */
export function sizeOrder(input: SizingInput): Sizing {
  const { notionalUsd, price, ctVal, lotSz, szDecimals } = input;
  const perContract = ctVal * price;
  if (!(perContract > 0) || !(lotSz > 0) || !(notionalUsd > 0)) {
    return { contracts: 0, sz: (0).toFixed(szDecimals), notional: 0 };
  }
  // 1e-9: 부동소수 오차로 정확히 n lot 인 값이 n−1 로 내려가는 것을 막는다.
  const lots = Math.floor(notionalUsd / perContract / lotSz + 1e-9);
  const contracts = Number((lots * lotSz).toFixed(szDecimals));
  return {
    contracts,
    sz: contracts.toFixed(szDecimals),
    notional: contracts * perContract,
  };
}

/** 격리 증거금과, 그 주문을 내기 위해 잔고에 있어야 하는 금액. */
export function marginNeeded(notional: number, leverage: number): { margin: number; need: number } {
  const margin = leverage > 0 ? notional / leverage : Number.POSITIVE_INFINITY;
  return { margin, need: margin * MARGIN_BUFFER };
}

export interface OrderPlan {
  side: Side;
  /** 기준 가격 — 시장가라 지금 시세다. 손절·목표의 방향 판정과 손익비의 분모 */
  price: number;
  stop: number | null;
  /** TP1·TP2·TP3 순. 비어 있는 단은 null */
  targets: readonly (number | null)[];
  notionalUsd: number | null;
  leverage: number | null;
  setup: string;
  rationale: string;
}

export interface GateItem {
  key: 'setup' | 'rationale' | 'stop' | 'target' | 'size';
  label: string;
  ok: boolean;
  /** 왜 열렸는지·막혔는지 — 숫자와 함께 */
  detail: string;
}

/** 손절·목표가 방향에 맞게 놓였는가 — 롱은 손절 아래·목표 위, 숏은 반대. */
function beyond(side: Side, price: number, level: number, toward: 'profit' | 'loss'): boolean {
  const up = side === 'long' ? toward === 'profit' : toward === 'loss';
  return up ? level > price : level < price;
}

/**
 * 근거 게이트 — 다섯 항목이 전부 열려야 주문 버튼이 열린다.
 *
 * 계좌 일치·잔고는 여기 없다. 그 둘은 거래소를 물어야 아는 값이라 부르는 쪽이 따로
 * 판정해 붙인다. 여기는 사람이 적은 계획만 본다.
 */
export function planGate(plan: OrderPlan, ctx: { minNotional: number | null }): GateItem[] {
  const { side, price, stop, targets, notionalUsd, leverage } = plan;
  const setup = plan.setup.trim();
  const rationale = plan.rationale.trim();
  const [tp1, ...rest] = targets;

  const stopOk = stop !== null && Number.isFinite(stop) && beyond(side, price, stop, 'loss');

  let targetOk = tp1 !== null && tp1 !== undefined && Number.isFinite(tp1) && beyond(side, price, tp1, 'profit');
  let targetDetail = targetOk ? `TP1 ${tp1}` : tp1 === null || tp1 === undefined ? 'TP1 이 비어 있습니다' : '목표가 진입 반대쪽에 있습니다';
  if (targetOk) {
    // TP2·TP3 은 앞 단보다 더 멀어야 한다 — 순서가 뒤집힌 분할 계획은 계획이 아니다.
    let prev = tp1 as number;
    rest.forEach((tp, i) => {
      if (tp === null || !targetOk) return;
      if (!beyond(side, prev, tp, 'profit')) {
        targetOk = false;
        targetDetail = `TP${i + 2}(${tp})가 TP${i + 1}(${prev})보다 안쪽입니다`;
        return;
      }
      prev = tp;
    });
  }

  const notionalOk = notionalUsd !== null && notionalUsd > 0;
  const leverageOk = leverage !== null && leverage >= 1 && leverage <= MAX_LEVERAGE;
  const minOk = ctx.minNotional === null || (notionalUsd !== null && notionalUsd >= ctx.minNotional);
  const sizeOk = notionalOk && leverageOk && minOk;
  const sizeDetail = !notionalOk
    ? '투입(명목가)을 적어 주세요'
    : !leverageOk
      ? `레버리지는 1~${MAX_LEVERAGE}배`
      : !minOk
        ? `최소 명목가 ≈ ${ctx.minNotional?.toFixed(2)} USDT`
        : `${notionalUsd} USDT · ${leverage}배`;

  return [
    {
      key: 'setup',
      label: '기준(셋업)',
      ok: setup !== '',
      detail: setup !== '' ? setup : '어떤 셋업인지 고르거나 적어 주세요',
    },
    {
      key: 'rationale',
      label: `근거 ${MIN_RATIONALE_CHARS}자 이상`,
      ok: rationale.length >= MIN_RATIONALE_CHARS,
      detail: `${rationale.length}/${MIN_RATIONALE_CHARS}자`,
    },
    {
      key: 'stop',
      label: '손절가',
      ok: stopOk,
      detail: stopOk ? `손절 ${stop}` : stop === null ? '손절가가 비어 있습니다' : '손절이 진입 반대쪽에 있습니다',
    },
    { key: 'target', label: '목표가', ok: targetOk, detail: targetDetail },
    { key: 'size', label: '투입 · 레버리지', ok: sizeOk, detail: sizeDetail },
  ];
}

export function gateOpen(items: readonly GateItem[]): boolean {
  return items.every((g) => g.ok);
}

/**
 * 브래킷에 함께 걸 목표 — TP 가 정확히 하나일 때만.
 *
 * 둘 이상이면 "TP1 에서 전량 청산"이 되어 분할 계획을 거래소가 덮어쓴다. 그때는 손절만 걸고
 * 익절은 거래소에서 직접 건다(화면이 그렇게 말한다).
 */
export function attachedTarget(targets: readonly (number | null)[]): number | undefined {
  const present = targets.filter((t): t is number => t !== null && Number.isFinite(t));
  return present.length === 1 ? present[0] : undefined;
}

export interface PlanRisk {
  /** 손절에 걸렸을 때 잃는 금액(양수) — 명목가 × 손절폭 */
  riskAmount: number;
  /** 잔고 대비 % */
  riskPctOfEquity: number | null;
  /** 손익비 — TP1 기준 */
  rr: number | null;
  rewardPct: number;
  riskPct: number;
}

/** 계획의 리스크 — 화면의 "이 주문에서 잃을 수 있는 돈" 한 줄. 계획이 덜 찼으면 null. */
export function planRisk(plan: OrderPlan, equity: number | null): PlanRisk | null {
  const tp1 = plan.targets[0];
  if (plan.stop === null || tp1 === null || tp1 === undefined || plan.notionalUsd === null) return null;
  const m = positionMetrics({
    side: plan.side,
    entry: plan.price,
    stop: plan.stop,
    target: tp1,
    notional: plan.notionalUsd,
  });
  if (m === null || m.problem !== null) return null;
  const riskAmount = m.lossAmount === null ? plan.notionalUsd * m.riskPct : Math.abs(m.lossAmount);
  return {
    riskAmount,
    riskPctOfEquity: equity !== null && equity > 0 ? (riskAmount / equity) * 100 : null,
    rr: m.rr,
    rewardPct: m.rewardPct,
    riskPct: m.riskPct,
  };
}

export interface DailyStatus {
  entriesToday: number;
  lossesToday: number;
  /** 이 주문이 그날 몇 번째 진입이 되는가 */
  nextEntryNo: number;
  overEntries: boolean;
  overLosses: boolean;
}

/**
 * 하루 규칙(진단서 규칙 6) — 지금 들어가면 어떻게 되는지.
 *
 * 판정은 `judgeTradeRules` 와 같은 잣대(한국 시간 하루, 손실은 청산 시각 기준)지만 저 함수는
 * 이미 있는 거래를 판정하고 여기는 **아직 없는** 거래를 판정한다. 그래서 같은 상수를 쓰되
 * 따로 센다. 차단하지 않고 경고만 한다 — 차단은 사용자 결정으로 남긴다.
 */
export function dailyStatus(trades: readonly Trade[], nowIso: string): DailyStatus {
  const today = dayKey(nowIso);
  const entriesToday = trades.filter((t) => dayKey(t.entry_at) === today).length;
  const lossesToday = trades.filter(
    (t) => !isOpenTrade(t) && t.exit_at !== null && dayKey(t.exit_at) === today && netOf(t) < 0,
  ).length;
  return {
    entriesToday,
    lossesToday,
    nextEntryNo: entriesToday + 1,
    overEntries: entriesToday + 1 > DAILY_MAX_TRADES,
    overLosses: lossesToday >= DAILY_MAX_LOSSES,
  };
}
