/**
 * 손실 한도·연속 손실 멈춤 기준 (REQ-0097).
 *
 * 책(멈춤 규칙): 손실 한도를 일·주·월·분기·연으로 두고, 3일 연속 손실이면 일주일 쉰다.
 * 한도는 **R 횟수와 자금 % 상한 중 먼저 닿는 쪽**에서 멈춘다(11-02 사용자 결정). % 상한은
 * 「기준 R = 자금 3%」일 때의 R 한도와 같게 맞췄다 — 기준 R 이 자금 3% 이하면 R 한도가, 넘으면 % 상한이 먼저 걸린다.
 *
 * 숫자의 근거는 9/6~11/2 청산 204건 반사실 검증(.backlog REQ-0097): 규칙 없음 −90R,
 * 「같은 날 2연패 → 그날 종료」 −27R(단일 규칙 1위), 일·주·월 한도 + 2연패 종료 −8R.
 *
 * 기간은 한국 시간(KST) 달력이다 — 하루는 00:00, 주는 월요일 00:00 에 시작한다.
 * 09:00(UTC 0시) 경계는 검증에서 효과가 줄어 쓰지 않았다.
 *
 * 패 = 거래 순손익 < 0 (Repeatable 규칙과 같다, 해석 없음). 본전(0)은 연패를 끊지도 잇지도 않는다.
 * 손실일 = 그날 청산 순손익 합 < 0. 거래 없는 날은 손실일 연속을 끊지도 잇지도 않는다.
 * 무엇을 넣을지는 부르는 쪽이 정한다. 화면은 **활성 북의 거래만** 넣는다(11-03 사용자 결정 — 중간정산 뒤
 * 새로 시작한 북부터 관리). 예전 북까지 넣으면 10월 손실로 분기·연 한도가 이미 넘어 2027-01-01 까지 막힌다.
 */
import type { Trade } from '@/lib/domain';
import { isOpenTrade, netOf } from '@/lib/metrics';

export type LimitPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year';

export const LIMIT_PERIODS: readonly LimitPeriod[] = ['day', 'week', 'month', 'quarter', 'year'];

export interface LimitRule {
  /** R 한도 — 기간 손익이 −r R 이하면 멈춘다 */
  r: number;
  /** 자금 % 상한 — 기간 손익이 기준 자금의 −pct 이하면 멈춘다 (0.06 = 6%) */
  pct: number;
  label: string;
  /** 닿으면 할 일 */
  action: string;
}

export const LIMIT_RULES: Record<LimitPeriod, LimitRule> = {
  day: { r: 2, pct: 0.06, label: '일', action: '그날 신규 진입 금지' },
  week: { r: 4, pct: 0.12, label: '주', action: '그 주 신규 진입 금지' },
  month: {
    r: 6,
    pct: 0.2,
    label: '월',
    action: '그 달 신규 진입 금지 + 복기 1건',
  },
  quarter: {
    r: 10,
    pct: 0.3,
    label: '분기',
    action: '분기 끝까지 중단, 전략 재검토',
  },
  year: { r: 15, pct: 0.4, label: '연', action: '연말까지 중단' },
};

export const STREAK_RULES = {
  /** 같은 날 이만큼 연달아 지면 그날 종료 */
  dayStopLosses: 2,
  /** 날을 넘겨 이만큼 연달아 지면 다음 거래 위험을 줄인다 */
  shrinkLosses: 4,
  /** 축소 구간의 위험 배율 — 이익 1건이면 1R 로 복귀 */
  shrinkFactor: 0.5,
  /** 손실일이 이만큼 이어지면 냉각 */
  coolLossDays: 3,
  /** 냉각 휴식 일수 — 마지막 손실일 다음 날부터 */
  coolRestDays: 7,
} as const;

const KST_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;

/** KST 달력 숫자 — UTC 메서드로 읽기 위해 9시간 민 Date. */
function kst(ms: number): Date {
  return new Date(ms + KST_MS);
}

const kstUtc = (y: number, m: number, d: number): number => Date.UTC(y, m, d) - KST_MS;

/** 그 시각이 속한 기간의 시작(ms, KST 달력). */
export function periodStart(period: LimitPeriod, ms: number): number {
  const d = kst(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = kstUtc(y, m, d.getUTCDate());
  switch (period) {
    case 'day':
      return day;
    case 'week':
      return day - ((d.getUTCDay() + 6) % 7) * DAY_MS;
    case 'month':
      return kstUtc(y, m, 1);
    case 'quarter':
      return kstUtc(y, m - (m % 3), 1);
    case 'year':
      return kstUtc(y, 0, 1);
  }
}

/** 그 시각이 속한 기간의 끝 = 다음 기간의 시작. */
export function periodEnd(period: LimitPeriod, ms: number): number {
  const start = periodStart(period, ms);
  const d = kst(start);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (period) {
    case 'day':
      return start + DAY_MS;
    case 'week':
      return start + 7 * DAY_MS;
    case 'month':
      return kstUtc(y, m + 1, 1);
    case 'quarter':
      return kstUtc(y, m + 3, 1);
    case 'year':
      return kstUtc(y + 1, 0, 1);
  }
}

/** KST 날짜 `YYYY-MM-DD`. */
export function kstDayKey(ms: number): string {
  return kst(ms).toISOString().slice(0, 10);
}

/** 한도 계산에 쓰는 청산 거래 한 건. */
export interface LimitTrade {
  id: string;
  seq: number;
  symbol: string;
  /** 청산 시각(ms) */
  exitMs: number;
  /** 순손익(USDT, 수수료·펀딩 포함) */
  net: number;
  /** 진입 시점 기준 R — 이력 전 거래는 null(현재 기준 R 로 환산, 「추정」) */
  rBase: number | null;
}

/** 청산 거래 → 한도 계산용 한 건. 보유 중이면 null. */
export function toLimitTrade(t: Trade): LimitTrade | null {
  if (isOpenTrade(t) || t.exit_at === null) return null;
  return {
    id: t.id,
    seq: t.seq,
    symbol: t.symbol,
    exitMs: Date.parse(t.exit_at),
    net: netOf(t),
    rBase: t.r_base_at_entry,
  };
}

/** 거래 목록 중 청산 거래만 한도 계산용으로. */
export const closedLimitTrades = (trades: readonly Trade[]) =>
  trades.map(toLimitTrade).filter((t): t is LimitTrade => t !== null);

/** 기준R 손익 — 순손익 ÷ 진입 시점 기준 R(없으면 현재 기준 R). */
export function tradeBaseR(t: LimitTrade, rBaseNow: number): number {
  return t.net / (t.rBase ?? rBaseNow);
}

/** 보유 포지션의 열린 위험 — 지금 손절에 걸리면 잃는 금액. 손절이 없으면 null. */
export interface OpenRisk {
  symbol: string;
  riskUsd: number | null;
}

export interface CashPoint {
  /** 잔액 스냅샷 시각(ms) */
  atMs: number;
  /** 미실현을 뺀 잔액 */
  amount: number;
}

/**
 * % 상한의 기준 자금 — 최신 잔액에서 그 기간 실현 손익을 되돌린 값.
 *
 * 스냅샷이 기간 시작보다 늦으면 [시작, 스냅샷] 사이 청산분을 빼고, 이르면 (스냅샷, 시작) 사이 청산분을 더한다.
 * 입출금을 더해 만들지 않는다 — 입금 이중 계상(11-02 미해결)을 피하고, 기간 중 입금은 시작부터 있던 돈으로 본다.
 */
export function periodBaseEquity(
  start: number,
  cash: CashPoint | null,
  trades: readonly LimitTrade[],
  fallback: number,
): number {
  if (cash === null) return fallback;
  let base = cash.amount;
  for (const t of trades) {
    if (t.exitMs >= start && t.exitMs <= cash.atMs) base -= t.net;
    else if (t.exitMs > cash.atMs && t.exitMs < start) base += t.net;
  }
  return base;
}

export interface PeriodStatus {
  period: LimitPeriod;
  rule: LimitRule;
  start: number;
  end: number;
  baseEquity: number;
  /** R 한도 금액 = r × 현재 기준 R */
  limitRUsd: number;
  /** % 상한 금액 = pct × 기준 자금 */
  limitPctUsd: number;
  /** 실제 멈춤 금액 — 둘 중 작은 쪽 */
  stopUsd: number;
  /** 어느 쪽이 먼저 걸리나 */
  binding: 'r' | 'pct';
  /** 기간 순손익(USDT) */
  pnlUsd: number;
  /** 기간 기준R 손익 */
  pnlR: number;
  /** 한도까지 남은 금액(USDT) — 0 이상 */
  remainingUsd: number;
  breached: boolean;
  trades: number;
  /** 현재 기준 R 로 환산한 거래 수 */
  estimated: number;
  /** 보유 포지션이 지금 손절되면 이 한도를 넘는가 — 이미 넘었으면 false */
  openRiskExceeds: boolean;
}

export function periodStatus(
  period: LimitPeriod,
  nowMs: number,
  trades: readonly LimitTrade[],
  rBaseNow: number,
  cash: CashPoint | null,
  fallback: number,
  openRiskUsd: number,
): PeriodStatus {
  const rule = LIMIT_RULES[period];
  const start = periodStart(period, nowMs);
  const end = periodEnd(period, nowMs);
  const inPeriod = trades.filter((t) => t.exitMs >= start && t.exitMs < end && t.exitMs <= nowMs);
  const pnlUsd = inPeriod.reduce((a, t) => a + t.net, 0);
  const pnlR = inPeriod.reduce((a, t) => a + tradeBaseR(t, rBaseNow), 0);
  const baseEquity = periodBaseEquity(start, cash, trades, fallback);
  const limitRUsd = rule.r * rBaseNow;
  const limitPctUsd = rule.pct * Math.max(0, baseEquity);
  const breached = pnlR <= -rule.r || pnlUsd <= -limitPctUsd;
  const remainingUsd = Math.max(0, Math.min((rule.r + pnlR) * rBaseNow, limitPctUsd + pnlUsd));
  return {
    period,
    rule,
    start,
    end,
    baseEquity,
    limitRUsd,
    limitPctUsd,
    stopUsd: Math.min(limitRUsd, limitPctUsd),
    binding: limitRUsd <= limitPctUsd ? 'r' : 'pct',
    pnlUsd,
    pnlR,
    remainingUsd,
    breached,
    trades: inPeriod.length,
    estimated: inPeriod.filter((t) => t.rBase === null).length,
    openRiskExceeds: !breached && openRiskUsd > remainingUsd,
  };
}

export interface StreakStatus {
  /** 지금 이어지는 연패(날 무관) */
  lossStreak: number;
  /** 오늘 2연패가 나왔나 — 나온 뒤 이겨도 그날은 끝 */
  dayStopped: boolean;
  dayStopAtMs: number | null;
  /** 축소 구간(4연패 이상, 이익 1건이면 해제) */
  shrink: boolean;
  /** 지금 이어지는 손실일 수 */
  lossDayStreak: number;
  lastLossDay: string | null;
  /** 냉각 해제 시각 — 냉각을 한 번도 안 걸렸으면 null */
  coolUntilMs: number | null;
  cooling: boolean;
}

/** 거래를 청산 시각순으로. */
const byExit = (trades: readonly LimitTrade[]) => [...trades].sort((a, b) => a.exitMs - b.exitMs);

export interface DaySum {
  day: string;
  startMs: number;
  usd: number;
  r: number;
  n: number;
}

/** KST 날짜별 합계 — 거래 있는 날만, 날짜순. */
export function daySums(trades: readonly LimitTrade[], rBaseNow: number): DaySum[] {
  const map = new Map<string, DaySum>();
  for (const t of byExit(trades)) {
    const day = kstDayKey(t.exitMs);
    const cur = map.get(day) ?? {
      day,
      startMs: periodStart('day', t.exitMs),
      usd: 0,
      r: 0,
      n: 0,
    };
    cur.usd += t.net;
    cur.r += tradeBaseR(t, rBaseNow);
    cur.n += 1;
    map.set(day, cur);
  }
  return [...map.values()];
}

export function streakStatus(trades: readonly LimitTrade[], nowMs: number, rBaseNow: number): StreakStatus {
  const sorted = byExit(trades.filter((t) => t.exitMs <= nowMs));

  let lossStreak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const net = sorted[i].net;
    if (net > 0) break;
    if (net < 0) lossStreak += 1;
  }

  const today = periodStart('day', nowMs);
  let run = 0;
  let dayStopAtMs: number | null = null;
  for (const t of sorted) {
    if (t.exitMs < today) continue;
    if (t.net < 0) run += 1;
    else if (t.net > 0) run = 0;
    if (run >= STREAK_RULES.dayStopLosses && dayStopAtMs === null) dayStopAtMs = t.exitMs;
  }

  // 손실일 연속이 3 에 닿을 때마다 「그 손실일 다음 날부터 7일」 냉각 — 이어지는 손실일마다 뒤로 밀린다.
  let lossDayStreak = 0;
  let lastLossDay: string | null = null;
  let coolUntilMs: number | null = null;
  for (const d of daySums(sorted, rBaseNow)) {
    if (d.usd < 0) {
      lossDayStreak += 1;
      lastLossDay = d.day;
      if (lossDayStreak >= STREAK_RULES.coolLossDays) {
        const until = d.startMs + (1 + STREAK_RULES.coolRestDays) * DAY_MS;
        coolUntilMs = Math.max(coolUntilMs ?? until, until);
      }
    } else {
      lossDayStreak = 0;
    }
  }

  return {
    lossStreak,
    dayStopped: dayStopAtMs !== null,
    dayStopAtMs,
    shrink: lossStreak >= STREAK_RULES.shrinkLosses,
    lossDayStreak,
    lastLossDay,
    coolUntilMs,
    cooling: coolUntilMs !== null && nowMs < coolUntilMs,
  };
}

export type LimitState = 'ok' | 'shrink' | 'day_stop' | 'period' | 'cool';

export const LIMIT_STATE_LABEL: Record<LimitState, string> = {
  ok: '매매 가능',
  shrink: '축소 — 다음 거래 0.5R',
  day_stop: '당일 정지',
  period: '기간 한도 도달',
  cool: '냉각 — 휴식',
};

export interface LimitStatus {
  state: LimitState;
  /** 진입이 다시 가능해지는 시각 — 막혀 있지 않으면 null */
  resumeMs: number | null;
  /** 지금 걸려 있는 이유들 */
  reasons: string[];
  periods: PeriodStatus[];
  streak: StreakStatus;
  /** 손절이 있는 보유 포지션의 열린 위험 합계 */
  openRiskUsd: number;
  /** 손절이 없는 보유 포지션 */
  openWithoutStop: string[];
}

export interface LimitInput {
  trades: readonly LimitTrade[];
  nowMs: number;
  rBaseNow: number;
  cash: CashPoint | null;
  fallbackCapital: number;
  openRisks: readonly OpenRisk[];
}

/** 지금 상태 — 냉각 > 기간 한도 > 당일 정지 > 축소 > 정상. 재개 시각은 막는 것들 중 가장 늦은 것. */
export function limitStatus(input: LimitInput): LimitStatus {
  const { trades, nowMs, rBaseNow, cash, fallbackCapital, openRisks } = input;
  const openRiskUsd = openRisks.reduce((a, o) => a + (o.riskUsd ?? 0), 0);
  const openWithoutStop = openRisks.filter((o) => o.riskUsd === null).map((o) => o.symbol);
  const periods = LIMIT_PERIODS.map((p) =>
    periodStatus(p, nowMs, trades, rBaseNow, cash, fallbackCapital, openRiskUsd),
  );
  const streak = streakStatus(trades, nowMs, rBaseNow);

  const reasons: string[] = [];
  const resumes: number[] = [];
  if (streak.cooling && streak.coolUntilMs !== null) {
    reasons.push(`손실일 ${streak.lossDayStreak}일 연속 → ${STREAK_RULES.coolRestDays}일 휴식`);
    resumes.push(streak.coolUntilMs);
  }
  const breached = periods.filter((p) => p.breached);
  for (const p of breached) {
    reasons.push(`${p.rule.label} 한도 도달 → ${p.rule.action}`);
    resumes.push(p.end);
  }
  if (streak.dayStopped) {
    reasons.push(`오늘 ${STREAK_RULES.dayStopLosses}연패 → 그날 종료`);
    resumes.push(periodEnd('day', nowMs));
  }
  if (streak.shrink) reasons.push(`${streak.lossStreak}연패 → 다음 거래 위험 ${STREAK_RULES.shrinkFactor}R`);

  const state: LimitState = streak.cooling
    ? 'cool'
    : breached.length > 0
      ? 'period'
      : streak.dayStopped
        ? 'day_stop'
        : streak.shrink
          ? 'shrink'
          : 'ok';

  return {
    state,
    resumeMs: resumes.length > 0 ? Math.max(...resumes) : null,
    reasons,
    periods,
    streak,
    openRiskUsd,
    openWithoutStop,
  };
}

export type BreachKind = 'day' | 'week' | 'month' | 'two_losses';

export const BREACH_LABEL: Record<BreachKind, string> = {
  day: '일 −2R',
  week: '주 −4R',
  month: '월 −6R',
  two_losses: '같은 날 2연패',
};

export interface Breach {
  kind: BreachKind;
  /** 기간 이름 — 날짜, 주 시작일, 월 */
  period: string;
  atMs: number;
  /** 그 뒤 같은 기간에 더 한 거래 수와 그 기준R 손익 */
  after: number;
  afterR: number;
  /** 기간 전체 기준R 손익 */
  totalR: number;
}

/**
 * 지난 한도 도달 기록 — 언제 닿았고 그 뒤 몇 건을 더 했나.
 *
 * **R 한도로만** 판정한다. % 상한은 그 시점 자금이 필요한데 과거 잔액을 믿을 만하게 되살릴 수 없다
 * (입금 이중 계상). 분기·연은 표본 기간이 짧아 뺐다.
 */
export function breachHistory(trades: readonly LimitTrade[], rBaseNow: number): Breach[] {
  const sorted = byExit(trades);
  const out: Breach[] = [];

  const groups = (period: LimitPeriod) => {
    const map = new Map<number, LimitTrade[]>();
    for (const t of sorted) {
      const k = periodStart(period, t.exitMs);
      map.set(k, [...(map.get(k) ?? []), t]);
    }
    return map;
  };
  const name = (period: LimitPeriod, start: number) =>
    period === 'month' ? kstDayKey(start).slice(0, 7) : period === 'week' ? `${kstDayKey(start)} 주` : kstDayKey(start);

  for (const period of ['day', 'week', 'month'] as const) {
    const limit = LIMIT_RULES[period].r;
    for (const [start, list] of groups(period)) {
      const rs = list.map((t) => tradeBaseR(t, rBaseNow));
      const totalR = rs.reduce((a, r) => a + r, 0);
      let cum = 0;
      for (let i = 0; i < list.length; i++) {
        cum += rs[i];
        if (cum <= -limit) {
          out.push({
            kind: period,
            period: name(period, start),
            atMs: list[i].exitMs,
            after: list.length - 1 - i,
            afterR: rs.slice(i + 1).reduce((a, r) => a + r, 0),
            totalR,
          });
          break;
        }
      }
    }
  }

  for (const [start, list] of groups('day')) {
    const rs = list.map((t) => tradeBaseR(t, rBaseNow));
    let run = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].net < 0) run += 1;
      else if (list[i].net > 0) run = 0;
      if (run >= STREAK_RULES.dayStopLosses) {
        out.push({
          kind: 'two_losses',
          period: name('day', start),
          atMs: list[i].exitMs,
          after: list.length - 1 - i,
          afterR: rs.slice(i + 1).reduce((a, r) => a + r, 0),
          totalR: rs.reduce((a, r) => a + r, 0),
        });
        break;
      }
    }
  }

  return out.sort((a, b) => b.atMs - a.atMs);
}

/** 보유 포지션 한 건의 열린 위험 — (진입가 − 현재 손절) × 수량, 숏은 반대. 손절이 이익 쪽이면 0. */
export function openRiskOf(
  side: 'long' | 'short',
  entry: number | null,
  qty: number | null,
  stop: number | null,
): number | null {
  if (stop === null || !(stop > 0) || entry === null || !(entry > 0) || qty === null || !(qty > 0)) return null;
  const d = side === 'long' ? entry - stop : stop - entry;
  return Math.max(0, d * qty);
}
