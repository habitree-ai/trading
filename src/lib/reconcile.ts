/**
 * 자금 대조 — 화면의 `현재자금`이 거래소 잔고와 왜 다른지를 가른다.
 *
 * 화면이 쓰는 자금은 계산값이다:
 *
 *     초기자금 + 누적 실현손익 + 거래계좌 순이체 − 출금 = 현재자금
 *
 * 그래서 어긋나는 자리는 넷 중 하나다. 어느 항이 틀렸는지 말해 주지 않으면
 * "거래소와 다릅니다"라는 경고만 남고 손댈 곳을 못 찾는다. 여기서는 차이를 낸
 * 항을 짚고, 초기자금을 얼마로 두면 맞아떨어지는지까지 계산한다.
 *
 * 판정 경계는 `verdict`의 것을 그대로 쓴다 — 같은 화면에서 두 기준이 갈리지 않게.
 */

import { num, pct, signed } from '@/lib/format';
import { GAP_LIMIT, GAP_OK, type Tone } from '@/lib/verdict';

export type ReconcileCode =
  | 'match'
  | 'no-balance'
  | 'initial-double-counted'
  | 'pre-window'
  | 'foreign-ccy'
  | 'manual-equity'
  | 'never-synced'
  | 'unexplained';

export interface ReconcileNote {
  code: ReconcileCode;
  tone: Tone;
  text: string;
  /** 손댈 곳 — 화면이 그대로 안내 문구로 쓴다 */
  fix?: string;
}

export interface ReconcileInput {
  /** 시트의 `초기자금` */
  initialCapital: number;
  /** 누적 실현손익 */
  netPnl: number;
  /** 거래계좌 순이체 — 부호 포함 */
  netTransfer: number;
  /** 거래 행에 적힌 출금 누계 — 항상 양수 */
  tradeWithdrawal: number;
  /** 화면이 `현재자금`으로 쓰는 값 */
  computedEquity: number;
  /** 거래소에서 읽어 온 잔고 */
  actual: number | null;
  /** 그 잔고에 섞여 있는 미청산 손익. 모르면 null */
  unrealizedPnl: number | null;
  /** 기준 통화가 아닌 입출금·이체 건수 */
  foreignFlowCount: number;
  baseCurrency: string;
  /** 북 시작일 (YYYY-MM-DD) */
  startDate: string;
  /** 거래소가 내역을 돌려주는 가장 이른 시각(ms) */
  historyFloorMs: number;
  /** 마지막으로 성공한 동기화 시각. 없으면 null */
  lastSyncAt: string | null;
  /** 거래소 계정이 붙어 있는 북인가 */
  linked: boolean;
}

export interface EquityReconcile {
  initialCapital: number;
  netPnl: number;
  netTransfer: number;
  tradeWithdrawal: number;
  /** 초기자금 + 실현손익 + 순이체 − 출금 */
  ledgerEquity: number;
  computedEquity: number;
  actual: number | null;
  unrealizedPnl: number | null;
  /** 미청산분을 걷어낸 거래소 잔고 — 계산 자금과 기준이 같아진다 */
  settled: number | null;
  /** 계산 자금 − 정산 잔고. 양수면 화면이 더 크다 */
  diff: number | null;
  /** 차이의 크기 — 거래소 잔고 대비 */
  diffPct: number | null;
  tone: Tone;
  /** 초기자금을 이 값으로 바꾸면 차이가 사라진다. 대조할 잔고가 없으면 null */
  suggestedInitialCapital: number | null;
  notes: ReconcileNote[];
}

/** 원장 합계와 화면 자금이 갈렸다고 볼 최소 금액 — 부동소수점 찌꺼기는 넘긴다. */
const LEDGER_EPSILON = 0.01;

/**
 * 차이가 순이체와 '거의 같다'고 볼 폭.
 *
 * 초기자금에 이체분이 들어 있으면 차이가 순이체만큼 통째로 뜬다. 딱 맞아떨어지지는
 * 않는다 — 조회 구간 앞뒤에 걸친 거래의 손익이 잔차로 남기 때문이다(실계좌: 이체
 * 96.47에 차이 94.47, 잔차 2.00 = 그 사이 거래 손익). 잔차가 이 정도로 남아도
 * 짚어 줘야 하므로 이체 금액의 5%까지 연다. 다른 원인들은 순이체와 무관한 크기라
 * 이만큼 열어도 서로 겹치지 않는다.
 */
function transferTolerance(netTransfer: number, actual: number): number {
  return Math.max(Math.abs(netTransfer) * 0.05, Math.abs(actual) * GAP_LIMIT);
}

export function reconcileEquity(input: ReconcileInput): EquityReconcile {
  const {
    initialCapital,
    netPnl,
    netTransfer,
    tradeWithdrawal,
    computedEquity,
    actual,
    unrealizedPnl,
    foreignFlowCount,
    baseCurrency,
    startDate,
    historyFloorMs,
    lastSyncAt,
    linked,
  } = input;

  const ledgerEquity = initialCapital + netPnl + netTransfer - tradeWithdrawal;
  const base = {
    initialCapital,
    netPnl,
    netTransfer,
    tradeWithdrawal,
    ledgerEquity,
    computedEquity,
    actual,
    unrealizedPnl,
  };

  if (actual === null || actual === 0 || !Number.isFinite(actual)) {
    return {
      ...base,
      settled: null,
      diff: null,
      diffPct: null,
      tone: 'neutral',
      suggestedInitialCapital: null,
      notes: [
        {
          code: 'no-balance',
          tone: 'neutral',
          text: '거래소 잔고를 아직 받지 못해 대조할 수 없습니다.',
          fix: linked
            ? 'OKX 동기화를 한 번 돌리면 잔고 스냅샷이 함께 저장됩니다.'
            : '설정에서 이 북에 거래소 계정을 연결하면 잔고를 자동으로 받아 옵니다.',
        },
      ],
    };
  }

  // 미실현분을 뺀 잔고가 청산분만 더한 계산 자금과 같은 기준이다.
  const settled = unrealizedPnl === null ? actual : actual - unrealizedPnl;
  const diff = computedEquity - settled;
  const diffPct = Math.abs(diff) / Math.abs(actual);
  const suggestedInitialCapital = initialCapital - diff;

  const notes: ReconcileNote[] = [];

  if (diffPct <= GAP_OK) {
    notes.push({
      code: 'match',
      tone: 'good',
      text: `거래소 잔고와 일치합니다 (차이 ${signed(diff)} ${baseCurrency}).`,
    });
  } else {
    let explained = false;

    // 초기자금에 이미 이체분이 들어 있는 경우 — 차이가 순이체만큼 통째로 뜬다.
    const residual = diff - netTransfer;
    if (netTransfer !== 0 && Math.abs(residual) <= transferTolerance(netTransfer, actual)) {
      explained = true;
      notes.push({
        code: 'initial-double-counted',
        tone: 'bad',
        text: `차이 ${signed(diff)}가 거래계좌 순이체 ${signed(netTransfer)}와 거의 같습니다(잔차 ${signed(residual)}) — 초기자금 안에 이미 들어 있는 이체를 동기화가 한 번 더 더하고 있습니다.`,
        fix: `초기자금은 시작일 ${startDate} 0시의 거래계좌 잔액이어야 합니다. 그 뒤의 이체·손익은 동기화가 따로 더합니다.`,
      });
    }

    // 북 시작일이 거래소 조회 한계보다 이르면 그 이전 기록은 받아 올 수 없다.
    const startMs = Date.parse(`${startDate}T00:00:00Z`);
    if (Number.isFinite(startMs) && startMs < historyFloorMs) {
      explained = true;
      notes.push({
        code: 'pre-window',
        tone: 'warn',
        text: `북 시작일 ${startDate}이 거래소가 돌려주는 구간(${new Date(historyFloorMs).toISOString().slice(0, 10)} 이후)보다 이릅니다 — 그 이전의 거래와 이체는 받아 올 수 없습니다.`,
        fix: '초기자금을 조회 가능한 구간이 시작되는 시점의 잔액으로 맞추면 그 이전 기록 없이도 자금이 맞아떨어집니다.',
      });
    }

    if (foreignFlowCount > 0) {
      explained = true;
      notes.push({
        code: 'foreign-ccy',
        tone: 'warn',
        text: `기준 통화(${baseCurrency})가 아닌 입출금·이체가 ${foreignFlowCount}건 있습니다 — 환산 없이 금액을 그대로 더하고 있어 그만큼 어긋납니다.`,
      });
    }

    if (!explained) {
      notes.push({
        code: 'unexplained',
        tone: diffPct <= GAP_LIMIT ? 'warn' : 'bad',
        text: `거래소 잔고와 ${signed(diff)}(${pct(diffPct, 1)}) 벌어져 있는데 원인이 특정되지 않았습니다.`,
        fix: '동기화 구간 밖에서 닫힌 포지션이거나, 무기한 계약이 아닌 매매(현물·마진)일 수 있습니다.',
      });
    }
  }

  // 수기로 적은 `자금`이 곡선을 붙잡고 있으면 초기자금을 고쳐도 그 지점부터는 안 움직인다.
  if (Math.abs(ledgerEquity - computedEquity) > LEDGER_EPSILON) {
    notes.push({
      code: 'manual-equity',
      tone: 'warn',
      text: `거래 행에 손으로 적은 자금 값이 곡선을 붙잡고 있습니다 — 원장 합계 ${num(ledgerEquity)}와 현재자금 ${num(computedEquity)}가 다릅니다.`,
      fix: '그 거래의 `자금` 칸을 비우면 앞뒤가 다시 이어집니다. 초기자금만 고치면 그 지점 뒤로는 값이 바뀌지 않습니다.',
    });
  }

  if (linked && lastSyncAt === null) {
    notes.push({
      code: 'never-synced',
      tone: 'warn',
      text: '이 북은 거래소 계정이 붙어 있지만 아직 성공한 동기화가 없습니다.',
      fix: '거래 목록에서 OKX 동기화를 돌려 주세요.',
    });
  }

  return {
    ...base,
    settled,
    diff,
    diffPct,
    tone: diffPct <= GAP_OK ? 'good' : diffPct <= GAP_LIMIT ? 'warn' : 'bad',
    suggestedInitialCapital,
    notes,
  };
}
