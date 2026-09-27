/**
 * TP 도달 경로 복기(REQ-0077, REQ-0081 전면 개편) — 실제 청산과 무관하게 진입 뒤 가격이 TP 에
 * 언제 닿았는지, 닿기 전에 얼마나 잃을 뻔했는지를 뽑는다.
 *
 * 모형: 진입 → 도달 전 최대손실(손절선 먼저 닿았으면 그 시각도) → TP 최초 도달. 구간 끝은 항상 지금(nowMs)
 * 이고 실제 청산은 추적을 끊지 않는다 — 청산점은 따로 찍고 TP 도달이 청산 전인지 뒤인지만 가른다.
 * 아직 안 닿았으면 어디까지 봤는지(analyzedUntilMs)와 보유중·청산됨(status)을 낸다. 시점마다 진입 후
 * 경과·가격·손익%·증거금%·금액을 내고, 그 모양으로 문제 후보(방향성 실패·진입의 문제·목표가의 문제·
 * 조급한 청산)를 규칙으로 가린다. 판정은 **후보**다 — 복기 글은 사람이 쓴다. 봉 단위 근사라 같은 봉
 * 안의 순서(고가가 먼저인지 저가가 먼저인지)는 모른다.
 */

import { formatDuration } from "@/components/measure-tool";
import type { Trade } from "@/lib/domain";
import { activeTargetPrices } from "@/lib/exit-plan";
import { BAR_MS, BARS, floorToBar, type Bar, type Candle } from "@/lib/okx";

/** 한 번에 받을 수 있는 봉 수(40페이지 × 100)보다 조금 적게 — 끝 봉이 잘리지 않게. */
const MAX_PATH_BARS = 3800;

/** 규칙 판정 임계치 — 초기값. 몇 건 보고 조정한다. */
export const PATH_RULES = {
  /** TP 도달 전 최대손실이 손절폭의 몇 % 이상이면 진입의 문제 */
  entryLossOfStop: 0.5,
  /** 미도달 청산인데 최대수익이 TP 거리의 몇 % 이상까지 갔으면 목표가의 문제 */
  targetNearOfTarget: 0.7,
} as const;

/**
 * 경로 캔들의 봉 — 진입 ~ 지금이 한 번에 받을 수 있는 개수 안에 드는 가장 짧은 봉.
 * 짧을수록 시점이 정확하다.
 */
export function pickPathBar(spanMs: number): Bar {
  for (const bar of BARS) if (spanMs / BAR_MS[bar] <= MAX_PATH_BARS) return bar;
  return BARS[BARS.length - 1];
}

export interface PathInput {
  side: "long" | "short";
  entryMs: number;
  entryPrice: number;
  /** 실제 청산 — 추적을 끊지 않는다. 보유중이면 null */
  exitMs: number | null;
  exitPrice: number | null;
  /** 기준 TP(TP1). 없으면 최대수익·최대손실만 */
  tp: number | null;
  stop: number | null;
  leverage: number | null;
  /** 포지션 명목가(USDT) — 시점별 금액 계산용. 없으면 금액은 null */
  notional: number | null;
  nowMs: number;
}

/**
 * 거래 하나의 경로 요청 — 봉·캔들 구간·계산 입력. 팝업(브라우저)과 경로 복기 리스트(서버)가 같이 써서
 * 두 화면의 숫자가 같게 한다. 끝은 청산 여부와 무관하게 지금까지 — 청산 뒤 TP 도달·아직 미도달을 보려고.
 * 진입가가 없으면 input 은 null.
 */
export function pathRequest(
  trade: Trade,
  nowMs: number,
): { bar: Bar; from: number; to: number; input: PathInput | null } {
  const entryMs = Date.parse(trade.entry_at);
  const exitMs = trade.exit_at ? Date.parse(trade.exit_at) : null;
  const bar = pickPathBar(nowMs - entryMs);
  return {
    bar,
    from: floorToBar(entryMs, bar),
    to: floorToBar(nowMs, bar) + BAR_MS[bar],
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
            notional: trade.notional,
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
  /** 금액(USDT, = 명목가 × pct / 100). 명목가를 모르면 null */
  amount: number | null;
}

export type VerdictKey = "direction" | "entry" | "target" | "wait";

/** 판정 순서·이름 — 한 건 표와 경로 복기 리스트(REQ-0079)의 분포가 같은 순서로 읽힌다 */
export const VERDICT_KEYS: readonly VerdictKey[] = ["direction", "entry", "target", "wait"];
export const VERDICT_LABEL: Record<VerdictKey, string> = {
  direction: "방향성 실패",
  entry: "진입의 문제",
  target: "목표가의 문제",
  wait: "조급한 청산",
};

export interface PathVerdict {
  key: VerdictKey;
  label: string;
  reason: string;
}

export interface PathReview {
  bar: Bar;
  /** 마지막으로 본 봉의 시작(ms) — 도달했으면 도달 봉, 미도달이면 "여기까지 봤다" */
  analyzedUntilMs: number;
  /** TP 최초 도달점(실제 청산 무관). 미도달 null */
  tp: PathPoint | null;
  /** TP 도달 전(미도달이면 구간 끝까지) 최대손실. 진입가 아래(숏은 위)로 간 적이 없으면 null */
  trough: PathPoint | null;
  /** TP 도달 전 최대수익(도달 봉 제외). 미도달 판단·목표가 판정용. 유리하게 간 적이 없으면 null */
  peak: PathPoint | null;
  /** 손절선 최초 도달(TP 전). 손절 미기록·무효·안 닿았으면 null */
  stopHit: PathPoint | null;
  /** 실제 청산점. 보유중 null */
  exit: PathPoint | null;
  /** 도달 / 보유중 미도달 / 청산됐는데 미도달 */
  status: "reached" | "open-unreached" | "closed-unreached";
  /** TP 도달이 실제 청산 전인지 뒤인지. 보유중 도달은 no-exit, 미도달은 unreached */
  tpVsExit: "before-exit" | "after-exit" | "no-exit" | "unreached";
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

function hitsStop(c: Candle, side: PathInput["side"], stop: number): boolean {
  return side === "long" ? c.l <= stop : c.h >= stop;
}

/**
 * 경로를 계산한다. `candles` 는 `bar` 봉으로 진입 봉부터 지금까지 받은 것.
 * 경로 안에 봉이 하나도 없으면 null.
 */
export function reviewPath(input: PathInput, candles: readonly Candle[], bar: Bar): PathReview | null {
  const { side, entryMs, entryPrice, exitMs, exitPrice, tp, stop, leverage, notional } = input;
  if (!(entryPrice > 0)) return null;
  const dir = side === "long" ? 1 : -1;

  const start = floorTo(entryMs, bar);
  const path = candles.filter((c) => c.t >= start && c.t <= input.nowMs).sort((a, b) => a.t - b.t);
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
      amount: notional !== null && notional > 0 ? (notional * pct) / 100 : null,
    };
  };
  const favPrice = (c: Candle) => (dir === 1 ? c.h : c.l);
  const advPrice = (c: Candle) => (dir === 1 ? c.l : c.h);

  // TP 최초 도달 봉 — 실제 청산 시각과 무관하게 구간 끝(지금)까지 찾는다. 거기서 추적이 끝난다.
  const tpIdx = tp === null ? -1 : path.findIndex((c) => hitsTarget(c, side, tp));
  const last = tpIdx >= 0 ? tpIdx : path.length - 1;

  // 도달 전 최대손실 — 가장 불리한 극값. 같은 값이면 먼저 온 봉.
  // TP 봉도 넣는다 — 봉 안 순서를 모르니 그 봉의 저가(숏은 고가)가 TP 앞에 왔을 수 있어 보수적으로.
  let troughIdx = -1;
  for (let i = 0; i <= last; i++) {
    if (pctOf(advPrice(path[i])) >= 0) continue;
    if (troughIdx < 0 || pctOf(advPrice(path[i])) < pctOf(advPrice(path[troughIdx]))) troughIdx = i;
  }

  // 도달 전 최대수익 — TP 에 닿은 봉은 뺀다(그 봉의 극값은 TP 도달점 자체). 미도달이면 구간 끝까지.
  const favEnd = tpIdx >= 0 ? tpIdx - 1 : last;
  let peakIdx = -1;
  for (let i = 0; i <= favEnd; i++) {
    if (pctOf(favPrice(path[i])) <= 0) continue;
    if (peakIdx < 0 || pctOf(favPrice(path[i])) > pctOf(favPrice(path[peakIdx]))) peakIdx = i;
  }

  // 손절선 최초 도달(TP 전) — 손절이 진입가보다 불리한 쪽에 있을 때만. 닿아도 추적은 멈추지 않는다.
  const stopDist = stop !== null && dir * (entryPrice - stop) > 0 ? (Math.abs(entryPrice - stop) / entryPrice) * 100 : null;
  const stopIdx = stop !== null && stopDist !== null ? path.slice(0, last + 1).findIndex((c) => hitsStop(c, side, stop)) : -1;

  const trough = troughIdx >= 0 ? point(path[troughIdx].t, advPrice(path[troughIdx])) : null;
  const peak = peakIdx >= 0 ? point(path[peakIdx].t, favPrice(path[peakIdx])) : null;
  const tpPoint = tpIdx >= 0 && tp !== null ? point(path[tpIdx].t, tp) : null;
  const stopHit = stopIdx >= 0 && stop !== null ? point(path[stopIdx].t, stop) : null;
  // 실제 청산점 — 추적과 무관하게 항상 찍는다. 보유중이면 null.
  const exit = exitMs !== null && exitPrice !== null ? point(exitMs, exitPrice) : null;
  const analyzedUntilMs = path[last].t;

  const status: PathReview["status"] =
    tpPoint !== null ? "reached" : exitMs === null ? "open-unreached" : "closed-unreached";
  // 청산과 같은 봉에서 닿았으면 순서를 모르니 청산 전으로 본다(tp.ms 는 봉 시작이라 exitMs 보다 앞).
  const tpVsExit: PathReview["tpVsExit"] =
    tpPoint === null ? "unreached" : exitMs === null ? "no-exit" : tpPoint.ms > exitMs ? "after-exit" : "before-exit";

  const verdicts: PathVerdict[] = [];
  const skipped: string[] = [];
  if (tp === null) {
    skipped.push("TP 없음 — 도달·판정 생략");
  } else if (status !== "open-unreached") {
    // 방향성 실패 — 청산됐는데 지금까지도 TP 미도달.
    if (status === "closed-unreached") {
      verdicts.push({
        key: "direction",
        label: VERDICT_LABEL.direction,
        reason: `${formatDuration(analyzedUntilMs - entryMs)} 동안 미도달${stopHit ? " · 손절선 먼저 도달" : ""}`,
      });
    }

    // 진입의 문제 — 도달은 했지만 도달 전 최대손실이 손절폭의 절반 이상.
    if (tpPoint !== null) {
      if (stopDist === null) {
        // 손절이 없거나 진입가보다 유리한 쪽(본절 이상으로 올린 것)이면 손절폭을 잴 수 없다.
        skipped.push(stop === null ? "손절 미기록 — 진입 판정 생략" : "손절이 진입가보다 유리한 쪽 — 진입 판정 생략");
      } else if (trough) {
        const ofStop = -trough.pct / stopDist;
        if (ofStop >= PATH_RULES.entryLossOfStop) {
          verdicts.push({
            key: "entry",
            label: VERDICT_LABEL.entry,
            reason:
              ofStop > 1
                ? `손절선 넘김(손절폭의 ${Math.round(ofStop * 100)}%) 뒤 도달`
                : `도달 전 손절폭의 ${Math.round(ofStop * 100)}% 역행`,
          });
        }
      }
    }

    // 목표가의 문제 — 청산됐고 미도달인데 TP 거리의 70% 이상까지는 갔다.
    const tpDist = dir * (tp - entryPrice) > 0 ? (Math.abs(tp - entryPrice) / entryPrice) * 100 : null;
    if (status === "closed-unreached" && peak && tpDist !== null) {
      const ofTarget = peak.pct / tpDist;
      if (ofTarget >= PATH_RULES.targetNearOfTarget) {
        verdicts.push({
          key: "target",
          label: VERDICT_LABEL.target,
          reason: `TP 거리의 ${Math.round(ofTarget * 100)}%까지 갔다가 미도달`,
        });
      }
    }

    // 조급한 청산 — 실제 청산 뒤에 TP 도달.
    if (tpVsExit === "after-exit" && tpPoint !== null && exitMs !== null) {
      verdicts.push({
        key: "wait",
        label: VERDICT_LABEL.wait,
        reason: `청산 ${formatDuration(tpPoint.ms - exitMs)} 뒤 TP 도달`,
      });
    }
  }

  return { bar, analyzedUntilMs, tp: tpPoint, trough, peak, stopHit, exit, status, tpVsExit, verdicts, skipped };
}

export interface PathSummary {
  total: number;
  /** 판정별 건수·순손익 — 한 거래가 여러 판정에 걸리면 각각에 센다 */
  byVerdict: Record<VerdictKey, { count: number; net: number }>;
  /** 청산됐는데 규칙에 걸린 것이 없는 거래 */
  clean: { count: number; net: number };
  /** 보유중 & 미도달 — 판정 없이 따로 센다 */
  pending: number;
  /** TP 에 닿은 거래 수 */
  tpReached: number;
  /** 진입 → TP 도달 평균 경과(ms). 도달한 거래만 평균, 없으면 null */
  avgToTpMs: number | null;
  /** 도달 전 최대손실 평균 금액(USDT). 금액이 있는 거래만 평균, 없으면 null */
  avgTroughAmount: number | null;
  /** 가장 많이 걸린 판정 — 동수면 VERDICT_KEYS 순서가 앞선 것. 아무것도 없으면 null */
  top: VerdictKey | null;
}

/**
 * 경로 복기 리스트(REQ-0079)의 분포 — 거래에서 문제가 방향성·진입·목표가·청산 타이밍 중 어디에 몰렸나.
 * `net` 은 그 거래의 실현손익(`netOf`). 보유중이면 null — 건수에는 들어가되 순손익 합에는 넣지 않는다
 * (아직 실현되지 않은 것을 실현손익처럼 더하지 않게).
 */
export function summarizePathReviews(rows: readonly { review: PathReview; net: number | null }[]): PathSummary {
  const byVerdict = Object.fromEntries(VERDICT_KEYS.map((k) => [k, { count: 0, net: 0 }])) as PathSummary["byVerdict"];
  const clean = { count: 0, net: 0 };
  let pending = 0;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const toTp: number[] = [];
  const troughAmounts: number[] = [];

  for (const { review, net } of rows) {
    if (review.status === "open-unreached") {
      pending += 1;
    } else if (review.verdicts.length === 0) {
      clean.count += 1;
      clean.net += net ?? 0;
    }
    for (const v of review.verdicts) {
      byVerdict[v.key].count += 1;
      byVerdict[v.key].net += net ?? 0;
    }
    if (review.tp) toTp.push(review.tp.elapsedMs);
    if (review.trough && review.trough.amount !== null) troughAmounts.push(review.trough.amount);
  }

  let top: VerdictKey | null = null;
  for (const k of VERDICT_KEYS) if (byVerdict[k].count > 0 && (top === null || byVerdict[k].count > byVerdict[top].count)) top = k;

  return {
    total: rows.length,
    byVerdict,
    clean,
    pending,
    tpReached: toTp.length,
    avgToTpMs: avg(toTp),
    avgTroughAmount: avg(troughAmounts),
    top,
  };
}
