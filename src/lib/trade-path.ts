/**
 * TP 도달 경로 복기(REQ-0077) — 진입 뒤 가격이 어떤 순서로 움직였는지 세 시점으로 뽑는다.
 *
 * 모형: 진입 → 1차 최대수익점 → 최대손실점 → TP 도달. 시점마다 진입 후 경과·가격·손익%를 내고,
 * 그 모양으로 문제 후보(타점·기다림·버티는 위치)를 규칙으로 가린다. 판정은 **후보**다 — 복기
 * 글은 사람이 쓴다. 봉 단위 근사라 같은 봉 안의 순서(고가가 먼저인지 저가가 먼저인지)는 모른다.
 */

import { formatDuration } from "@/components/measure-tool";
import type { Trade } from "@/lib/domain";
import { activeTargetPrices } from "@/lib/exit-plan";
import { BAR_MS, BARS, floorToBar, type Bar, type Candle } from "@/lib/okx";

/** 한 번에 받을 수 있는 봉 수(40페이지 × 100)보다 조금 적게 — 끝 봉이 잘리지 않게. */
const MAX_PATH_BARS = 3800;

/** 규칙 판정 임계치 — 초기값. 몇 건 보고 조정한다. */
export const PATH_RULES = {
  /** 경로 앞쪽 몇 %의 시간 안에 온 역행을 "초반"으로 보나 */
  earlyShare: 0.25,
  /** 초반 역행이 손절폭의 몇 % 이상이면 타점 의심 */
  earlyAdverseOfStop: 0.5,
  /** 역행이 손절폭의 몇 % 이상이면 손절라인까지 버틴 것 */
  holdStopOfStop: 0.9,
  /** 1차 최대수익이 TP 거리의 몇 % 이상이었다가 반납하면 수익라인 문제 */
  giveBackOfTarget: 0.7,
} as const;

/**
 * 경로 캔들의 봉 — 진입 ~ 끝(청산 + 같은 길이, 청산 뒤 TP 도달을 보려고)이 한 번에 받을 수 있는
 * 개수 안에 드는 가장 짧은 봉. 짧을수록 시점이 정확하다.
 */
export function pickPathBar(spanMs: number): Bar {
  for (const bar of BARS) if (spanMs / BAR_MS[bar] <= MAX_PATH_BARS) return bar;
  return BARS[BARS.length - 1];
}

export interface PathInput {
  side: "long" | "short";
  entryMs: number;
  entryPrice: number;
  /** 보유중이면 null — 끝은 `nowMs` */
  exitMs: number | null;
  exitPrice: number | null;
  /** 기준 TP(TP1). 없으면 최대수익·최대손실만 */
  tp: number | null;
  stop: number | null;
  leverage: number | null;
  nowMs: number;
}

/**
 * 거래 하나의 경로 요청 — 봉·캔들 구간·계산 입력. 팝업(브라우저)과 경로 복기 리스트(서버)가 같이 써서
 * 두 화면의 숫자가 같게 한다. 청산 뒤 같은 길이까지 받는다 — 청산 뒤 TP 도달(기다림)을 보려고.
 * 진입가가 없으면 input 은 null.
 */
export function pathRequest(
  trade: Trade,
  nowMs: number,
): { bar: Bar; from: number; to: number; input: PathInput | null } {
  const entryMs = Date.parse(trade.entry_at);
  const exitMs = trade.exit_at ? Date.parse(trade.exit_at) : null;
  const endMs = exitMs !== null ? exitMs + Math.max(exitMs - entryMs, 0) : nowMs;
  const bar = pickPathBar(endMs - entryMs);
  return {
    bar,
    from: floorToBar(entryMs, bar),
    to: floorToBar(endMs, bar) + BAR_MS[bar],
    input:
      trade.entry_price === null
        ? null
        : {
            side: trade.side,
            entryMs,
            entryPrice: trade.entry_price,
            exitMs,
            exitPrice: trade.exit_price,
            tp: activeTargetPrices(trade)[0],
            stop: trade.okx_stop_price ?? trade.stop_price,
            leverage: trade.leverage,
            nowMs,
          },
  };
}

export interface PathPoint {
  /** 봉 시작 시각(ms) — 청산점은 청산 시각 그대로 */
  ms: number;
  price: number;
  /** 진입 후 경과(ms). 진입 봉이면 0 */
  elapsedMs: number;
  /** 가격 기준 손익% — 유리하면 +, 불리하면 − */
  pct: number;
  /** 증거금 기준 손익%(= pct × 레버리지). 레버리지를 모르면 null */
  marginPct: number | null;
}

export type VerdictKey = "entry" | "wait" | "hold-stop" | "hold-profit";

/** 판정 순서·이름 — 한 건 표와 경로 복기 리스트(REQ-0079)의 분포가 같은 순서로 읽힌다 */
export const VERDICT_KEYS: readonly VerdictKey[] = ["entry", "wait", "hold-stop", "hold-profit"];
export const VERDICT_LABEL: Record<VerdictKey, string> = {
  entry: "타점",
  wait: "기다림",
  "hold-stop": "버티는 위치 — 손절라인",
  "hold-profit": "버티는 위치 — 수익라인",
};

export interface PathVerdict {
  key: VerdictKey;
  label: string;
  reason: string;
}

export interface PathReview {
  bar: Bar;
  /** 1차 최대수익점 — 최대손실보다 먼저 온 가장 유리한 극값. 유리하게 간 적이 없으면 null */
  peak: PathPoint | null;
  /** 최대수익이 최대손실보다 먼저 왔나 — 아니면 「손실 먼저」 */
  peakFirst: boolean;
  /** 최대손실점. 진입가 아래(숏은 위)로 간 적이 없으면 null */
  trough: PathPoint | null;
  /** TP 도달점(청산 전). 못 닿았으면 null */
  tp: PathPoint | null;
  /** 청산점 — TP 전에 청산했거나 TP 가 없을 때. 보유중이면 null */
  exit: PathPoint | null;
  /** TP 전에 청산했는데 청산 뒤 같은 길이 안에 TP 에 닿은 시각 */
  tpAfterExit: { ms: number; afterExitMs: number } | null;
  verdicts: PathVerdict[];
  /** 판정을 건너뛴 이유(손절 미기록·TP 없음) */
  skipped: string[];
}

function floorTo(ms: number, bar: Bar): number {
  return Math.floor(ms / BAR_MS[bar]) * BAR_MS[bar];
}

function hitsTarget(c: Candle, side: PathInput["side"], tp: number): boolean {
  return side === "long" ? c.h >= tp : c.l <= tp;
}

/**
 * 경로를 계산한다. `candles` 는 `bar` 봉으로 진입 봉부터 청산 뒤까지 받은 것.
 * 경로 안에 봉이 하나도 없으면 null.
 */
export function reviewPath(input: PathInput, candles: readonly Candle[], bar: Bar): PathReview | null {
  const { side, entryMs, entryPrice, exitMs, exitPrice, tp, stop, leverage } = input;
  if (!(entryPrice > 0)) return null;
  const dir = side === "long" ? 1 : -1;
  const endMs = exitMs ?? input.nowMs;

  const start = floorTo(entryMs, bar);
  const path = candles.filter((c) => c.t >= start && c.t <= endMs).sort((a, b) => a.t - b.t);
  if (path.length === 0) return null;

  const pctOf = (price: number) => (dir * (price - entryPrice) / entryPrice) * 100;
  const point = (ms: number, price: number): PathPoint => {
    const pct = pctOf(price);
    return {
      ms,
      price,
      elapsedMs: Math.max(0, ms - entryMs),
      pct,
      marginPct: leverage !== null && leverage > 0 ? pct * leverage : null,
    };
  };
  const favPrice = (c: Candle) => (dir === 1 ? c.h : c.l);
  const advPrice = (c: Candle) => (dir === 1 ? c.l : c.h);

  // TP 최초 도달 봉 — 거기서 경로가 끝난다.
  const tpIdx = tp === null ? -1 : path.findIndex((c) => hitsTarget(c, side, tp));
  const last = tpIdx >= 0 ? tpIdx : path.length - 1;

  // 최대손실 — 가장 불리한 극값. 같은 값이면 먼저 온 봉.
  let troughIdx = -1;
  for (let i = 0; i <= last; i++) {
    if (pctOf(advPrice(path[i])) >= 0) continue;
    if (troughIdx < 0 || pctOf(advPrice(path[i])) < pctOf(advPrice(path[troughIdx]))) troughIdx = i;
  }

  // 1차 최대수익 — 최대손실 전 구간에서. 그 앞에 유리한 봉이 없으면 경로 전체에서(손실 먼저).
  // TP 에 닿은 봉은 뺀다 — 그 봉의 극값은 TP 도달점 자체다.
  const bestFav = (from: number, to: number): number => {
    let best = -1;
    for (let i = from; i <= to; i++) {
      if (pctOf(favPrice(path[i])) <= 0) continue;
      if (best < 0 || pctOf(favPrice(path[i])) > pctOf(favPrice(path[best]))) best = i;
    }
    return best;
  };
  const favEnd = tpIdx >= 0 ? tpIdx - 1 : last;
  let peakIdx = troughIdx > 0 ? bestFav(0, Math.min(troughIdx - 1, favEnd)) : -1;
  let peakFirst = peakIdx >= 0;
  if (peakIdx < 0) {
    peakIdx = bestFav(0, favEnd);
    peakFirst = troughIdx < 0; // 역행이 없었으면 순서를 따질 것도 없다
  }

  const peak = peakIdx >= 0 ? point(path[peakIdx].t, favPrice(path[peakIdx])) : null;
  const trough = troughIdx >= 0 ? point(path[troughIdx].t, advPrice(path[troughIdx])) : null;
  const tpPoint = tpIdx >= 0 && tp !== null ? point(path[tpIdx].t, tp) : null;
  const exit =
    tpPoint === null && exitMs !== null && exitPrice !== null ? point(exitMs, exitPrice) : null;

  // 청산 뒤 같은 길이 안에 TP 에 닿았나 — 「기다림」 판정 재료.
  let tpAfterExit: PathReview["tpAfterExit"] = null;
  if (tpPoint === null && tp !== null && exitMs !== null) {
    const until = exitMs + Math.max(exitMs - entryMs, BAR_MS[bar]);
    const hit = candles
      .filter((c) => c.t > floorTo(exitMs, bar) && c.t <= until)
      .sort((a, b) => a.t - b.t)
      .find((c) => hitsTarget(c, side, tp));
    if (hit) tpAfterExit = { ms: hit.t, afterExitMs: hit.t - exitMs };
  }

  const verdicts: PathVerdict[] = [];
  const skipped: string[] = [];
  const endPointMs = tpPoint?.ms ?? exit?.ms ?? endMs;
  const span = Math.max(endPointMs - entryMs, 1);
  const adverse = trough ? -trough.pct : 0;

  const stopDist = stop !== null && dir * (entryPrice - stop) > 0 ? (Math.abs(entryPrice - stop) / entryPrice) * 100 : null;
  if (stopDist === null) {
    skipped.push("손절 미기록 — 타점·손절라인 판정 생략");
  } else if (trough) {
    const ofStop = adverse / stopDist;
    if (trough.elapsedMs <= span * PATH_RULES.earlyShare && ofStop >= PATH_RULES.earlyAdverseOfStop) {
      verdicts.push({
        key: "entry",
        label: VERDICT_LABEL.entry,
        reason: `진입 후 ${formatDuration(trough.elapsedMs)} 만에 손절폭의 ${Math.round(ofStop * 100)}% 역행`,
      });
    }
    if (ofStop >= PATH_RULES.holdStopOfStop) {
      verdicts.push({
        key: "hold-stop",
        label: VERDICT_LABEL["hold-stop"],
        reason: ofStop > 1 ? `손절선을 넘겨 버팀(손절폭의 ${Math.round(ofStop * 100)}%)` : `손절선 근처까지 역행(손절폭의 ${Math.round(ofStop * 100)}%)`,
      });
    }
  }

  const tpDist = tp !== null && dir * (tp - entryPrice) > 0 ? (Math.abs(tp - entryPrice) / entryPrice) * 100 : null;
  if (tpDist === null) {
    skipped.push("TP 없음 — 수익라인·기다림 판정 생략");
  } else {
    if (peak && trough && peakFirst) {
      const ofTarget = peak.pct / tpDist;
      if (ofTarget >= PATH_RULES.giveBackOfTarget) {
        verdicts.push({
          key: "hold-profit",
          label: VERDICT_LABEL["hold-profit"],
          reason: `TP 거리의 ${Math.round(ofTarget * 100)}%까지 갔다가 반납하고 ${trough.pct.toFixed(2)}%까지 역행`,
        });
      }
    }
    if (tpAfterExit) {
      verdicts.push({
        key: "wait",
        label: VERDICT_LABEL.wait,
        reason: `청산 ${formatDuration(tpAfterExit.afterExitMs)} 뒤 TP 도달 — 조급한 청산`,
      });
    }
  }

  return { bar, peak, peakFirst, trough, tp: tpPoint, exit, tpAfterExit, verdicts, skipped };
}

export interface PathSummary {
  total: number;
  /** 판정별 건수·순손익 — 한 거래가 여러 판정에 걸리면 각각에 센다 */
  byVerdict: Record<VerdictKey, { count: number; net: number }>;
  /** 규칙에 걸린 것이 없는 거래 */
  clean: { count: number; net: number };
  /** TP 에 닿은 거래 수 */
  tpReached: number;
  /** 진입 → 각 시점 평균 경과(ms). 해당 시점이 있는 거래만 평균, 없으면 null */
  avgToPeakMs: number | null;
  avgToTroughMs: number | null;
  avgToTpMs: number | null;
  /** 가장 많이 걸린 판정 — 동수면 VERDICT_KEYS 순서가 앞선 것. 아무것도 없으면 null */
  top: VerdictKey | null;
}

/**
 * 경로 복기 리스트(REQ-0079)의 분포 — 과거 거래에서 문제가 타점·기다림·버티는 위치 중 어디에 몰렸나.
 * `net` 은 그 거래의 실현손익(`netOf`).
 */
export function summarizePathReviews(rows: readonly { review: PathReview; net: number }[]): PathSummary {
  const byVerdict = Object.fromEntries(VERDICT_KEYS.map((k) => [k, { count: 0, net: 0 }])) as PathSummary["byVerdict"];
  const clean = { count: 0, net: 0 };
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const toPeak: number[] = [];
  const toTrough: number[] = [];
  const toTp: number[] = [];

  for (const { review, net } of rows) {
    if (review.verdicts.length === 0) {
      clean.count += 1;
      clean.net += net;
    }
    for (const v of review.verdicts) {
      byVerdict[v.key].count += 1;
      byVerdict[v.key].net += net;
    }
    if (review.peak) toPeak.push(review.peak.elapsedMs);
    if (review.trough) toTrough.push(review.trough.elapsedMs);
    if (review.tp) toTp.push(review.tp.elapsedMs);
  }

  let top: VerdictKey | null = null;
  for (const k of VERDICT_KEYS) if (byVerdict[k].count > 0 && (top === null || byVerdict[k].count > byVerdict[top].count)) top = k;

  return {
    total: rows.length,
    byVerdict,
    clean,
    tpReached: toTp.length,
    avgToPeakMs: avg(toPeak),
    avgToTroughMs: avg(toTrough),
    avgToTpMs: avg(toTp),
    top,
  };
}
