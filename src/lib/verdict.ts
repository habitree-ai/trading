/**
 * 지표 해석 — 숫자 하나를 "그래서 어떻다"로 옮긴다.
 *
 * 대시보드에 숫자만 늘어놓으면 읽는 사람이 매번 기준을 머리에 들고 있어야 한다.
 * MDD −18%가 괜찮은 건지, 승률 55%가 충분한 건지는 다른 숫자와 같이 봐야 정해진다.
 * 그 판단을 여기 한곳에 모아 둔다 — 화면마다 기준이 갈리지 않게.
 *
 * 경계값은 관행에서 가져왔고, 근거는 각 함수에 적어 둔다. 절대 기준이 아니므로
 * 문구는 항상 왜 그렇게 봤는지를 함께 말한다.
 */

import { num, pct, signed } from '@/lib/format';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export interface Verdict {
  tone: Tone;
  text: string;
}

/** 화면에서 쓰는 색 — 손익 색(적/녹)과 같은 축에 둔다. */
export const TONE_CLASS: Record<Tone, string> = {
  good: 'text-profit',
  warn: 'text-beta',
  bad: 'text-loss',
  neutral: 'text-dim',
};

/**
 * 손익분기 승률 — 이 손익비에서 본전이 되는 승률.
 *
 * 승률만으로는 좋고 나쁨이 정해지지 않는다. 손익비 3이면 승률 30%로도 벌고,
 * 손익비 0.5면 승률 60%로도 잃는다. 비교 기준은 이 값이다.
 */
export function breakEvenWinRate(payoffRatio: number | null): number | null {
  if (payoffRatio === null || !Number.isFinite(payoffRatio) || payoffRatio <= 0) return null;
  return 1 / (1 + payoffRatio);
}

/**
 * 낙폭에서 원금으로 돌아오는 데 필요한 수익률.
 *
 * 50% 잃으면 50%를 벌어서는 못 돌아온다(100%가 필요하다). 낙폭이 깊어질수록
 * 회복에 드는 힘이 급격히 커진다는 걸 이 숫자가 그대로 보여 준다.
 */
export function recoveryNeeded(maxDrawdownPct: number): number | null {
  if (!Number.isFinite(maxDrawdownPct) || maxDrawdownPct >= 0) return null;
  if (maxDrawdownPct <= -1) return null; // 자금이 0 이하 — 회복률이 정의되지 않는다
  return 1 / (1 + maxDrawdownPct) - 1;
}

/** 표본이 이만큼은 돼야 승률·기대치가 흔들리지 않는다고 보는 관행값. */
export const RELIABLE_SAMPLE = 30;

export function readSample(closedCount: number): Verdict {
  if (closedCount >= RELIABLE_SAMPLE) {
    return { tone: 'neutral', text: `청산 ${closedCount}건 — 지표를 믿고 볼 만한 표본입니다.` };
  }
  return {
    tone: 'warn',
    text: `청산 ${closedCount}건 — ${RELIABLE_SAMPLE}건이 안 돼 승률·기대치가 크게 흔들립니다.`,
  };
}

/**
 * 기대치값 — 한 거래를 반복했을 때 남는 R.
 *
 * 부호가 전부다. 양수면 반복할수록 늘고 음수면 반복할수록 준다.
 */
export function readExpectancy(expectancy: number | null): Verdict {
  if (expectancy === null) return { tone: 'neutral', text: '청산된 거래가 없어 아직 계산되지 않습니다.' };
  if (expectancy > 0) {
    return {
      tone: 'good',
      text: `같은 방식으로 100번 반복하면 ${signed(expectancy * 100, 0)}R을 기대할 수 있습니다.`,
    };
  }
  if (expectancy < 0) {
    return {
      tone: 'bad',
      text: `반복할수록 줄어드는 구조입니다 — 100번이면 ${signed(expectancy * 100, 0)}R입니다.`,
    };
  }
  return { tone: 'neutral', text: '벌지도 잃지도 않는 지점입니다.' };
}

/**
 * 승률 — 손익분기 승률과 견줘 읽는다.
 *
 * 여유 5%p를 좋음의 경계로 둔다. 그보다 얇으면 수수료·슬리피지가 조금만 커져도
 * 부호가 뒤집힌다.
 */
export function readWinRate(winRate: number | null, payoffRatio: number | null): Verdict {
  const breakEven = breakEvenWinRate(payoffRatio);
  if (winRate === null || breakEven === null) {
    return { tone: 'neutral', text: '손익비가 없어 기준 승률을 잡을 수 없습니다.' };
  }

  const margin = winRate - breakEven;
  const head = `이 손익비의 본전 승률은 ${pct(breakEven, 1)}`;

  if (margin > 0.05) return { tone: 'good', text: `${head} — ${pct(margin, 1)}p 앞서 있습니다.` };
  if (margin > 0) {
    return {
      tone: 'warn',
      text: `${head} — 여유가 ${pct(margin, 1)}p뿐이라 비용이 조금만 커져도 뒤집힙니다.`,
    };
  }
  return { tone: 'bad', text: `${head} — ${pct(-margin, 1)}p 모자랍니다.` };
}

/** 손익비 — 이기는 거래가 지는 거래보다 몇 배 큰가. */
export function readPayoff(payoffRatio: number | null): Verdict {
  if (payoffRatio === null) return { tone: 'neutral', text: '승·패가 모두 있어야 계산됩니다.' };
  if (payoffRatio >= 2) {
    return { tone: 'good', text: `이기는 거래가 지는 거래보다 ${num(payoffRatio, 1)}배 큽니다.` };
  }
  if (payoffRatio >= 1) {
    return { tone: 'neutral', text: `이길 때가 조금 더 큽니다 — 승률이 받쳐 줘야 합니다.` };
  }
  return {
    tone: 'warn',
    text: `지는 거래가 더 큽니다 — 승률로 메워야 하는 구조입니다.`,
  };
}

/*
 * 낙폭 경계 — 10% / 20%.
 *
 * 20%를 넘으면 원금 회복에 25% 이상이 필요해지고, 그 지점부터 "벌어서 메운다"가
 * 현실적으로 어려워진다. 10%는 흔들려도 계획을 유지할 수 있는 폭으로 본다.
 */
const DD_OK = -0.1;
const DD_LIMIT = -0.2;

export function readDrawdown(maxDrawdownPct: number): Verdict {
  const recovery = recoveryNeeded(maxDrawdownPct);
  const tail = recovery === null ? '' : ` 원금으로 돌아오려면 ${pct(recovery, 1)}가 필요합니다.`;

  if (maxDrawdownPct >= DD_OK) {
    return { tone: 'good', text: `고점에서 ${pct(DD_OK, 0)} 안쪽으로 버텼습니다.${tail}` };
  }
  if (maxDrawdownPct >= DD_LIMIT) {
    return { tone: 'warn', text: `${pct(DD_OK, 0)}를 넘긴 낙폭입니다.${tail}` };
  }
  return { tone: 'bad', text: `${pct(DD_LIMIT, 0)}를 넘긴 낙폭입니다.${tail}` };
}

/*
 * 거래당 리스크 경계 — 2% / 5%.
 *
 * 2%는 널리 쓰이는 상한이다. 5%를 넘으면 연패 몇 번에 계좌가 절반이 된다
 * (5%씩 10연패면 −40%).
 */
const RISK_OK = 0.02;
const RISK_LIMIT = 0.05;

export function readRisk(avgRiskPct: number | null): Verdict {
  if (avgRiskPct === null) {
    return { tone: 'neutral', text: '손절가가 적힌 거래가 없어 계산되지 않습니다.' };
  }
  if (avgRiskPct <= RISK_OK) {
    return { tone: 'good', text: `한 거래에 거는 폭이 ${pct(RISK_OK, 0)} 이내입니다.` };
  }
  if (avgRiskPct <= RISK_LIMIT) {
    return { tone: 'warn', text: `한 거래에 ${pct(RISK_OK, 0)}보다 넓게 걸고 있습니다.` };
  }
  return {
    tone: 'bad',
    text: `한 거래에 ${pct(avgRiskPct, 1)}를 겁니다 — 10연패면 원금의 절반 가까이 사라집니다.`,
  };
}

/**
 * 연패 — 몇 번을 연달아 져 봤나.
 *
 * 길다고 나쁜 게 아니다. 기대치가 양수여도 연패는 온다. 여기서 알아야 할 건
 * "그 구간을 견딜 수 있게 걸었는가"이므로, 리스크와 곱해 실제로 깎인 폭을 보여 준다.
 */
export function readLossStreak(maxLossStreak: number, avgRiskPct: number | null): Verdict {
  if (maxLossStreak === 0) return { tone: 'neutral', text: '아직 연패가 없습니다.' };

  const drop = avgRiskPct === null ? null : 1 - (1 - avgRiskPct) ** maxLossStreak;
  const tail = drop === null ? '' : ` 같은 폭으로 다시 겪으면 자금의 ${pct(drop, 1)}가 깎입니다.`;

  return {
    tone: maxLossStreak >= 5 ? 'warn' : 'neutral',
    text: `${maxLossStreak}번 연달아 진 구간을 견뎠습니다.${tail}`,
  };
}

/**
 * 켈리 비율 — 한 거래에서 잃어도 되는 자금 비율의 상한.
 *
 * 켈리는 승률·손익비의 추정 오차를 그대로 키운다(둘 다 표본이 얇으면 크게 흔들린다).
 * 그래서 표본 경고를 다른 지표보다 앞에 두고, 실전 상한은 절반 켈리로 말한다 —
 * 문헌은 절반 켈리가 성장의 약 75%를 절반의 변동으로 얻는다고 본다.
 */
export function readKelly(kelly: number | null, closedCount: number): Verdict {
  if (kelly === null) return { tone: 'neutral', text: '승·패가 모두 있어야 계산됩니다.' };
  if (kelly <= 0) {
    return {
      tone: 'bad',
      text: '기대치가 0 이하라 켈리로는 걸 수 있는 폭이 없습니다 — 크기보다 방식을 먼저 고쳐야 합니다.',
    };
  }
  if (closedCount < RELIABLE_SAMPLE) {
    return {
      tone: 'warn',
      text: `청산 ${closedCount}건 — 켈리는 승률·손익비 오차를 그대로 키우는 지표라 ${RELIABLE_SAMPLE}건 전에는 상한 참고로만 봅니다.`,
    };
  }
  return {
    tone: 'good',
    text: `한 거래에서 자금의 ${pct(kelly, 1)}까지 잃어도 장기 성장이 최대입니다 — 실전 상한은 절반인 ${pct(kelly / 2, 1)}로 봅니다.`,
  };
}

/**
 * 실제로 잃어 온 폭을 켈리와 견준다.
 *
 * 켈리를 넘기면 거는 만큼 성장률이 깎이고, 2배를 넘기면 기대치가 양수여도 자금이 준다.
 * 절반 켈리까지가 추정이 어긋나도 버티는 폭이다.
 */
export function readKellyFit(kelly: number | null, avgLossPctOfEquity: number | null): Verdict {
  if (kelly === null || avgLossPctOfEquity === null) {
    return { tone: 'neutral', text: '잃은 폭과 켈리가 모두 있어야 견줄 수 있습니다.' };
  }
  const actual = pct(avgLossPctOfEquity, 1);
  if (kelly <= 0) {
    return {
      tone: 'bad',
      text: `켈리가 0 이하인데 한 번에 ${actual}씩 잃고 있습니다 — 걸수록 줄어드는 구간입니다.`,
    };
  }
  if (avgLossPctOfEquity > kelly) {
    return {
      tone: 'bad',
      text: `실제로 잃는 폭 ${actual}가 켈리 상한 ${pct(kelly, 1)}를 넘습니다 — 거는 만큼 성장률이 오히려 깎입니다.`,
    };
  }
  if (avgLossPctOfEquity > kelly / 2) {
    return {
      tone: 'warn',
      text: `절반 켈리 ${pct(kelly / 2, 1)}를 넘습니다 — 승률·손익비가 조금만 나빠져도 상한 밖입니다.`,
    };
  }
  return {
    tone: 'good',
    text: `절반 켈리 ${pct(kelly / 2, 1)} 안쪽입니다 — 추정이 어긋나도 여유가 있습니다.`,
  };
}

/*
 * 비용이 성적을 정하는 경계 — 손실의 절반.
 *
 * 비용이 손실의 절반을 넘으면 방향을 더 잘 맞히는 것보다 덜 자주 들어가는 쪽이
 * 먼저다. 진입 하나를 고쳐도 회전이 그대로면 같은 자리로 돌아온다.
 */
const COST_DOMINANT = 0.5;

/**
 * 비용 — 수수료·펀딩비가 성적에 얼마나 개입했나.
 *
 * 가격만 놓고 본 손익과 계좌가 실제로 움직인 금액의 차이가 비용이다. 레버리지가 높고
 * 회전이 잦으면 이 차이가 성적 전체를 뒤집는다 — 그 사실이 화면에 없으면, 자금이 왜
 * 줄었는지를 매매 실력에서만 찾게 된다.
 */
export function readCost(input: {
  pnlBeforeCost: number;
  /** 수수료 + 펀딩비 — 대개 음수 */
  cost: number;
  netPnl: number;
  /** 가격으로는 이겼는데 비용 때문에 진 거래 수 */
  flipped: number;
}): Verdict {
  const { pnlBeforeCost, cost, netPnl, flipped } = input;
  if (cost === 0) {
    return { tone: 'neutral', text: '수수료가 기록되지 않아 비용을 가를 수 없습니다.' };
  }

  const spent = Math.abs(cost);
  const tail =
    flipped === 0 ? '' : ` 가격으로는 이겼는데 비용에 밀려 진 거래가 ${flipped}건입니다.`;

  // 가격으로는 벌었는데 계좌가 줄었다 — 비용이 성적을 통째로 뒤집은 경우다.
  if (pnlBeforeCost > 0 && netPnl <= 0) {
    return {
      tone: 'bad',
      text: `가격으로는 ${signed(pnlBeforeCost, 0)}를 벌었지만 비용 ${num(spent, 0)}이 그보다 커서 계좌는 줄었습니다.${tail}`,
    };
  }

  if (netPnl < 0) {
    const share = spent / Math.abs(netPnl);
    if (share >= COST_DOMINANT) {
      return {
        tone: 'bad',
        text: `손실 ${num(Math.abs(netPnl), 0)} 가운데 ${num(spent, 0)}(${pct(share, 0)})이 비용입니다 — 방향보다 회전율이 성적을 정하고 있습니다.${tail}`,
      };
    }
    return {
      tone: 'warn',
      text: `손실 ${num(Math.abs(netPnl), 0)} 가운데 ${num(spent, 0)}(${pct(share, 0)})이 비용입니다.${tail}`,
    };
  }

  return {
    tone: 'good',
    text: `비용 ${num(spent, 0)}을 내고도 ${signed(netPnl, 0)} 남았습니다.${tail}`,
  };
}

/*
 * 계산 자금과 거래소 잔고의 차이 — 0.5% / 2%.
 *
 * 수수료 반올림 정도는 늘 남는다. 2%를 넘으면 놓친 거래나 입출금이 있다고 본다.
 */
export const GAP_OK = 0.005;
export const GAP_LIMIT = 0.02;

/**
 * 계산 자금과 거래소 잔고를 견준다 — 미청산 포지션의 손익은 걷어내고.
 *
 * 거래소 잔고에는 아직 안 닫힌 포지션이 남긴 금액(미실현 가격손익 + 이미 낸 수수료)이
 * 들어 있지만, 계산 자금은 청산이 끝난 거래만 더한다. 그대로 빼면 포지션을 들고 있는
 * 내내 벌어져 보인다 — 분 단위로 매매하는 계좌에서는 거의 항상이라, 진짜 누락이 생겨도
 * 그 경고에 묻혀 버린다.
 *
 * 그 값을 모르면(예전 스냅샷) 예전처럼 총액끼리 견준다.
 */
export function readBalanceGap(
  computed: number,
  actual: number | null,
  unrealizedPnl: number | null = null,
): Verdict {
  if (actual === null) {
    return { tone: 'neutral', text: '거래소에서 읽어 온 잔고가 아직 없습니다.' };
  }
  if (actual === 0 || !Number.isFinite(actual)) {
    return { tone: 'neutral', text: '거래소 잔고가 0이라 대조할 수 없습니다.' };
  }

  // 미실현분을 뺀 잔고가 청산분만 더한 계산 자금과 같은 기준이다.
  const settled = unrealizedPnl === null ? actual : actual - unrealizedPnl;
  const diff = computed - settled;
  const ratio = Math.abs(diff) / Math.abs(actual);

  const held =
    unrealizedPnl === null || unrealizedPnl === 0
      ? ''
      : ` (미청산 ${signed(unrealizedPnl, 2)} 제외)`;

  if (ratio <= GAP_OK) return { tone: 'good', text: `거래소 잔고와 일치합니다.${held}` };
  if (ratio <= GAP_LIMIT) {
    return { tone: 'warn', text: `거래소 잔고와 ${signed(diff, 2)} 차이납니다.${held}` };
  }
  return {
    tone: 'bad',
    text: `거래소 잔고와 ${signed(diff, 2)}(${pct(ratio, 1)}) 벌어져 있습니다 — 놓친 거래나 입출금이 있습니다.${held}`,
  };
}
