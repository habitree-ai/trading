/**
 * 자동으로 재는 원칙 — 거래 기록만으로 지켰는지 어겼는지가 갈리는 규칙.
 *
 * `/principles` 의 원칙은 사람이 거래마다 눌러서 판단한다. 여기 세 원칙(선배님 "원칙 1"에
 * 대한 내 답 + 진단서의 하루 규칙)은 손절가·목표가·진입 시각·손익만 있으면 기계가 판정할
 * 수 있어, 손을 기다리지 않고 통계를 낸다. `principles` 표에 저장하지 않는다 — 계산값이다.
 *
 * 재지 못하는 것은 재지 않는다: 손절선을 옮겼는지(이력 없음), 목표가에 닿고도 안 팔았는지
 * (가격 경로 없음)는 손 체크리스트의 몫으로 남긴다.
 */
import type { Trade } from "@/lib/domain";
import { dayKey, isOpenTrade, netOf } from "@/lib/metrics";

export type TradeRuleId = "stop" | "target" | "daily";

export interface TradeRule {
  id: TradeRuleId;
  title: string;
  /** 무엇을 어김으로 보는가 */
  detail: string;
  /** 기계가 못 재서 손에 남기는 부분 */
  manual: string;
}

/** 하루에 허용하는 진입 수 — 진단서 규칙 6 */
export const DAILY_MAX_TRADES = 3;
/** 그날 손실이 이만큼 확정되면 더 들어가지 않는다 */
export const DAILY_MAX_LOSSES = 2;

export const TRADE_RULES: readonly TradeRule[] = [
  {
    id: "stop",
    title: "스탑로스 없이 매매하지 않는다",
    detail: "손절가가 앱(계획)에도 거래소(걸린 값)에도 없으면 어김.",
    manual: "지정한 손절선을 옮겼는지는 이력이 없어 재지 못한다 — 아래 체크리스트로.",
  },
  {
    id: "target",
    title: "목표가를 정하고 들어간다 — 도달하면 익절",
    detail: "목표가(TP1~3 또는 거래소 TP)가 하나도 없으면 어김.",
    manual: "목표에 닿고도 안 팔았는지는 가격 경로가 없어 재지 못한다 — 아래 체크리스트로.",
  },
  {
    id: "daily",
    title: `하루 ${DAILY_MAX_TRADES}건 상한, 손실 ${DAILY_MAX_LOSSES}건이면 그날 종료`,
    detail: `한국 시간 하루에 ${DAILY_MAX_TRADES + 1}번째부터의 진입, 그날 ${DAILY_MAX_LOSSES}번째 손실이 확정된 뒤의 진입이 어김.`,
    manual: "",
  },
];

export interface RuleVerdict {
  rule: TradeRuleId;
  kept: boolean;
  /** 왜 그렇게 판정했는지 — 숫자와 함께 */
  reason: string;
}

/** 손절가 — 거래소에 실제로 걸린 값이 있으면 그것, 없으면 계획값. */
export function stopOf(trade: Trade): number | null {
  return trade.okx_stop_price ?? trade.stop_price;
}

/** 목표가 — 1차부터 순서대로, 없으면 거래소 TP. */
export function targetOf(trade: Trade): number | null {
  return trade.tp1_price ?? trade.tp2_price ?? trade.tp3_price ?? trade.okx_tp_price;
}

const ms = (iso: string) => Date.parse(iso);

/**
 * 북의 거래 전부를 판정한다 — 거래 id → 원칙별 판정.
 *
 * 하루 규칙은 같은 날의 다른 거래를 봐야 하므로 한 건씩이 아니라 전부를 받는다.
 * 보유중인 거래도 판정한다 — 손절 없이 들고 있는 것이 가장 급한 어김이다.
 */
export function judgeTradeRules(trades: readonly Trade[]): Map<string, RuleVerdict[]> {
  const sorted = [...trades].sort((a, b) => ms(a.entry_at) - ms(b.entry_at) || a.seq - b.seq);

  // 그날 확정된 손실 — 청산 시각 기준. 전날 들어가 오늘 아침에 잃은 것도 오늘의 손실이다.
  const losses = sorted.filter(
    (t) => !isOpenTrade(t) && t.exit_at !== null && netOf(t) < 0,
  ) as (Trade & { exit_at: string })[];

  const out = new Map<string, RuleVerdict[]>();
  const seenInDay = new Map<string, number>();

  for (const t of sorted) {
    const day = dayKey(t.entry_at);
    const nth = (seenInDay.get(day) ?? 0) + 1;
    seenInDay.set(day, nth);

    const entry = ms(t.entry_at);
    const lossesBefore = losses.filter(
      (l) => l.id !== t.id && dayKey(l.exit_at) === day && ms(l.exit_at) <= entry,
    ).length;

    const stop = stopOf(t);
    const target = targetOf(t);
    const dailyBroken: string[] = [];
    if (nth > DAILY_MAX_TRADES) dailyBroken.push(`그날 ${nth}번째 진입 (상한 ${DAILY_MAX_TRADES}건)`);
    if (lossesBefore >= DAILY_MAX_LOSSES) dailyBroken.push(`그날 손실 ${lossesBefore}건 확정 뒤 진입`);

    out.set(t.id, [
      {
        rule: "stop",
        kept: stop !== null,
        reason: stop !== null ? `손절 ${stop}` : "손절가 없음 — 앱·거래소 모두",
      },
      {
        rule: "target",
        kept: target !== null,
        reason: target !== null ? `목표 ${target}` : "목표가 없음",
      },
      {
        rule: "daily",
        kept: dailyBroken.length === 0,
        reason:
          dailyBroken.length > 0
            ? dailyBroken.join(" · ")
            : `그날 ${nth}번째 진입 · 앞선 손실 ${lossesBefore}건`,
      },
    ]);
  }
  return out;
}

export interface RuleOutcome {
  /** 판정한 거래 수 — 자동이라 북의 거래 전부다 */
  judged: number;
  broken: number;
  /** 어긴 거래 중 청산된 것들의 실현손익 합. 없으면 null — 보유중은 아직 값이 없다 */
  brokenPnl: number | null;
  /** 어긴 거래 — 순번 순 */
  brokenTrades: { id: string; seq: number; open: boolean }[];
}

/** 원칙별 집계 — `/principles` 의 손 원칙 통계와 같은 모양으로. */
export function summarizeTradeRules(
  trades: readonly Trade[],
  verdicts: ReadonlyMap<string, readonly RuleVerdict[]>,
): Map<TradeRuleId, RuleOutcome> {
  const out = new Map<TradeRuleId, RuleOutcome>();
  for (const rule of TRADE_RULES) {
    const row: RuleOutcome = { judged: 0, broken: 0, brokenPnl: null, brokenTrades: [] };
    for (const t of trades) {
      const v = verdicts.get(t.id)?.find((x) => x.rule === rule.id);
      if (!v) continue;
      row.judged += 1;
      if (v.kept) continue;
      row.broken += 1;
      const open = isOpenTrade(t);
      row.brokenTrades.push({ id: t.id, seq: t.seq, open });
      if (!open) row.brokenPnl = (row.brokenPnl ?? 0) + netOf(t);
    }
    row.brokenTrades.sort((a, b) => a.seq - b.seq);
    out.set(rule.id, row);
  }
  return out;
}
