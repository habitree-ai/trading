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

/* ============ 매매 진단 ============ */

/** 발견이 얼마나 단단한가. */
export type Confidence = 'confirmed' | 'likely' | 'hypothesis';

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  confirmed: '확정',
  likely: '유력',
  hypothesis: '가설',
};

/** 정렬용 — 작을수록 단단하다. */
export const CONFIDENCE_RANK: Record<Confidence, number> = {
  confirmed: 0,
  likely: 1,
  hypothesis: 2,
};

/*
 * 확정의 표본 하한 — 100건.
 *
 * 이 원장의 거래당 손익 표준편차는 122달러다. n=100 이면 표준오차가 12.2 로 기준선의
 * 크기(10.64)와 같은 자리다. 그보다 얇은 칸은 자기 자신을 기준선 하나 폭만큼도
 * 갈라내지 못한다.
 */
const CONFIRM_N = 100;

/*
 * 확정의 t 하한 — 3.0.
 *
 * 이 진단은 한 회차에 150개 넘는 칸을 동시에 검정한다. 관행값 |t|≥2(p≈0.05)를 쓰면
 * 우연히 통과하는 칸이 150×0.05 ≈ 7.5개 나와 확정 목록의 상당수가 거짓이 된다.
 * |t|≥3 은 p≈0.0027 이라 같은 검정 수에서 기대 오탐이 0.4개다.
 */
const CONFIRM_T = 3;

/*
 * 유력의 t 하한 — 2.0.
 *
 * 관행적 양측 5%. 다중검정 보정이 안 된 값이라 "스무 번에 한 번은 이렇게 보인다"가
 * 그대로 남는다 — 그래서 확정이 아니라 유력이다.
 */
const LIKELY_T = 2;

/*
 * 표본 밖 검증에 필요한 한쪽 최소 표본 — 30건.
 *
 * 칸을 기간으로 다시 가르면 한쪽이 한 자릿수가 되는 일이 흔하다. 그때 "부호가 같다"는
 * 정보가 아니라 잡음이므로 검정 자체를 하지 않은 것으로 둔다.
 */
const MIN_SPLIT_N = RELIABLE_SAMPLE;

/** 발견 하나가 들고 있는 근거 — 등급과 문장이 같은 입력에서 나와야 서로 어긋나지 않는다. */
export interface FindingEvidence {
  n: number;
  /** 이 칸의 거래당 손익 − 같은 코호트의 거래당 손익 */
  lift: number;
  /** 리프트를 표준오차로 나눈 값. 표본이 없어 못 내면 null */
  t: number | null;
  /** 기간 앞·뒤 절반의 리프트. 표본이 얇으면 null */
  inLift: number | null;
  outLift: number | null;
  inN: number;
  outN: number;
  /** 정의에 결과가 들어 있는가 — true 면 t 검정이 구조적으로 무효다 */
  tautological: boolean;
}

/** 앞뒤 절반이 같은 부호인가. 한쪽이라도 표본이 얇으면 null(검정 못 함). */
export function heldOutOfSample(ev: FindingEvidence): boolean | null {
  if (ev.inLift === null || ev.outLift === null) return null;
  if (ev.inN < MIN_SPLIT_N || ev.outN < MIN_SPLIT_N) return null;
  return Math.sign(ev.inLift) === Math.sign(ev.outLift);
}

/**
 * 발견의 등급 — 표본·크기·기간 셋을 모두 본다.
 *
 * 셋 중 하나만 봐서는 안 되는 이유가 각각 있다. 표본만 보면 4,000건짜리의 거래당 0.3
 * 차이가 확정이 된다. 크기만 보면 12건짜리 종목의 +70이 확정이 된다. 기간만 보면
 * 우연히 앞뒤가 같은 방향으로 흔들린 축이 확정이 된다.
 *
 * 결과로 정의된 라벨은 절대 확정이 되지 않는다 — 리프트가 0이 아닌 것이 정의상 보장되어
 * t 검정이 성립하지 않기 때문이다.
 */
export function gradeFinding(ev: FindingEvidence): Confidence {
  if (ev.n < RELIABLE_SAMPLE) return 'hypothesis';
  if (ev.t === null) return 'hypothesis';

  const held = heldOutOfSample(ev);
  // 기간 밖에서 부호가 뒤집힌 것은 "검정 안 한 것"보다 못하다 — 검정했고 떨어졌다.
  if (held === false) return 'hypothesis';

  const strong = Math.abs(ev.t) >= CONFIRM_T && ev.n >= CONFIRM_N && held === true;
  if (strong && !ev.tautological) return 'confirmed';
  if (Math.abs(ev.t) >= LIKELY_T) return 'likely';
  return 'hypothesis';
}

/**
 * 발견 하나를 문장으로 — 등급과 그 등급이 나온 이유를 함께 말한다.
 *
 * 배지가 「가설」이라고만 하면 왜 가설인지를 매번 되짚어야 한다. 표본이 얇아서인지,
 * 차이가 작아서인지, 기간 밖에서 뒤집혀서인지에 따라 다음에 할 일이 다르다.
 */
export function readFinding(ev: FindingEvidence): Verdict {
  if (ev.tautological) {
    return {
      tone: 'neutral',
      text: '결과로 정의된 분류입니다 — 이 값은 효과가 아니라 그런 결과가 얼마나 잦았는지를 셉니다.',
    };
  }
  if (ev.n < RELIABLE_SAMPLE) {
    return { tone: 'warn', text: `표본 ${ev.n}건 — ${RELIABLE_SAMPLE}건이 안 돼 차이가 크게 흔들립니다.` };
  }
  if (ev.t === null) {
    return { tone: 'neutral', text: '흔들리는 폭을 잴 수 없어 등급을 매기지 못합니다.' };
  }

  const held = heldOutOfSample(ev);
  if (held === false) {
    return {
      tone: 'bad',
      text: `앞 절반 ${signed(ev.inLift, 2)} / 뒤 절반 ${signed(ev.outLift, 2)} — 기간 밖에서 부호가 뒤집혔습니다. 발견이 아니라 그 구간의 사건이었습니다.`,
    };
  }
  if (Math.abs(ev.t) < LIKELY_T) {
    return {
      tone: 'neutral',
      text: `차이 ${signed(ev.lift, 2)}가 흔들리는 폭의 ${num(Math.abs(ev.t), 1)}배뿐입니다 — 표본 뽑기 운으로 설명되는 크기입니다.`,
    };
  }
  if (held === null) {
    return {
      tone: 'warn',
      text: `표본 ${ev.n}건은 충분하지만 기간을 반으로 가르면 ${ev.inN}건 / ${ev.outN}건이라 확정으로 올리지 못합니다.`,
    };
  }
  if (Math.abs(ev.t) < CONFIRM_T || ev.n < CONFIRM_N) {
    return {
      tone: 'warn',
      text: `기간 양쪽 부호는 같지만 차이가 흔들리는 폭의 ${num(Math.abs(ev.t), 1)}배로, 확정 기준 ${CONFIRM_T}배에 못 미칩니다.`,
    };
  }
  return {
    tone: ev.lift > 0 ? 'good' : 'bad',
    text: `표본 ${ev.n}건에 기간 양쪽이 같은 부호이고 차이가 흔들리는 폭의 ${num(Math.abs(ev.t), 1)}배입니다 — 이 원장에서 가장 단단한 축에 듭니다.`,
  };
}

/*
 * 청산이 성적을 정하는 경계 — 손실의 절반.
 *
 * `COST_DOMINANT` 와 같은 논리다. 한 항목이 손실의 절반을 넘게 만들면 나머지를 다 고쳐도
 * 성적은 그 항목이 정한다.
 */
const EXIT_DOMINANT = 0.5;

/**
 * 진입과 청산 중 어디가 더 비쌌나.
 *
 * 성적이 나쁠 때 사람은 진입을 먼저 의심한다 — 진입은 고른 것이고 청산은 당한 것처럼
 * 느껴지기 때문이다. 하지만 이미 이익 구간에 닿았던 거래가 손실로 닫혔다면 그 손실에
 * 진입은 관여하지 않았다. 그 몫을 갈라 보여 준다.
 */
export function readExitGap(input: {
  /** 보유 중 문턱 이상 평가익에 닿은 거래 수 */
  reached: number;
  /** 그중 손실로 닫은 거래 수 */
  gaveBack: number;
  /** 그 거래들의 실현손익 합 — 보통 음수 */
  gaveBackPnl: number;
  /** 전 구간 순손익 */
  netPnl: number;
  /** 평가익 문턱 — 0.2 = 증거금의 +20% */
  threshold: number;
}): Verdict {
  const { reached, gaveBack, gaveBackPnl, netPnl, threshold } = input;
  if (reached === 0) {
    return { tone: 'neutral', text: '이익 구간에 닿은 거래가 기록되지 않았습니다.' };
  }
  if (netPnl >= 0) {
    return { tone: 'neutral', text: '전 구간이 흑자라 손실을 갈라 볼 뜻이 없습니다.' };
  }

  const rate = gaveBack / reached;
  const share = Math.abs(gaveBackPnl) / Math.abs(netPnl);
  const head = `증거금 대비 ${pct(threshold, 0)}까지 갔던 거래 ${num(reached, 0)}건 가운데 ${num(gaveBack, 0)}건(${pct(rate, 0)})이 손실로 닫혔고, 그것만으로 ${signed(gaveBackPnl, 0)}`;

  if (share >= EXIT_DOMINANT) {
    return {
      tone: 'bad',
      text: `${head} — 순손실의 ${pct(share, 0)}입니다. 진입 기준을 고쳐도 이 몫은 그대로 남습니다.`,
    };
  }
  return { tone: 'warn', text: `${head} — 순손실의 ${pct(share, 0)}입니다.` };
}

/** 회차 사이에 발견이 어떻게 움직였나. */
export type FindingChange = 'new' | 'held' | 'strengthened' | 'weakened' | 'resolved' | 'reversed' | 'gone';

/**
 * 회차 변화 — "좋아졌다"를 함부로 말하지 않는다.
 *
 * 차이가 줄었다는 것만으로는 고쳐진 게 아니다. 그 구간을 덜 거래해서 줄었을 수도, 이번
 * 회차 표본이 얇아 흔들린 것일 수도 있다. 해결은 차이가 줄고 **거래 수도 줄었을 때만**
 * 말한다 — 피했다는 증거가 있어야 한다.
 */
export function readFindingChange(input: {
  change: FindingChange;
  prevLift: number | null;
  nowLift: number | null;
  prevN: number | null;
  nowN: number | null;
}): Verdict {
  const { change, prevLift, nowLift, prevN, nowN } = input;

  switch (change) {
    case 'new':
      return { tone: 'neutral', text: '이번 회차에 새로 잡힌 항목입니다 — 다음 회차가 확인해야 등급이 올라갑니다.' };
    case 'resolved':
      return {
        tone: 'good',
        text: `차이가 ${signed(prevLift, 2)} → ${signed(nowLift, 2)}로 줄었고 거래 수도 ${num(prevN, 0)}→${num(nowN, 0)}건으로 줄었습니다 — 피한 것이 맞습니다.`,
      };
    case 'weakened':
      return {
        tone: 'warn',
        text: `차이는 줄었지만 거래 수가 ${num(nowN, 0)}건으로 그대로입니다 — 고쳐진 것인지 이번 표본이 흔들린 것인지 아직 갈리지 않습니다.`,
      };
    case 'strengthened':
      return { tone: 'bad', text: `차이가 ${signed(prevLift, 2)} → ${signed(nowLift, 2)}로 더 벌어졌습니다.` };
    case 'reversed':
      return { tone: 'bad', text: '부호가 뒤집혔습니다 — 지난 회차의 발견이 발견이 아니었습니다. 지우지 않고 남겨 둡니다.' };
    case 'gone':
      return { tone: 'neutral', text: '이번 회차에는 이 칸에 거래가 없습니다.' };
    default:
      return { tone: 'warn', text: '그대로입니다 — 회차를 한 번 더 지나며 아무것도 바뀌지 않았습니다.' };
  }
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
