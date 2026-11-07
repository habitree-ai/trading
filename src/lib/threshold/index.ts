/**
 * 임계점 종합 — 서버 수집기(collectThreshold) · 방향별 판정(judgeThresholds·summarize) · 다리 기록 값(toLegSignals)(REQ-0102).
 *
 * 열 때 계산한다(D11) — 저장하지 않는다. 소스 다섯(캔들·호가·옵션·펀딩/OI·현재가)을 allSettled 로 받아
 * 하나가 죽어도 나머지는 계산하고, 죽은 자리는 measured=false + sources 사유로 남긴다(꺼짐과 구분).
 *
 * 캐시: 지난 캔들 페이지는 fetchCandles 가 하루 캐시하고, 옵션은 options/okx·deribit 가 60초 revalidate 다.
 * 호가·펀딩·OI·현재가는 각 모듈이 no-store — 여기서 따로 겹 캐시를 두지 않는다(같은 값이 다리 기록에도 쓰인다).
 *
 * 단위: THRESHOLD_RULES 의 binPct·depthPct 는 소수, gapEntryPct·wallGapOnPct·wallNearWarnPct 는 퍼센트.
 * 리포트의 *DistPct 는 퍼센트(0.3 = 0.3%), bbwPct 는 0~1, fundingAnnual 은 소수(0.3 = 30%).
 */

import type { Side } from "@/lib/domain";
import type { LegSignals } from "@/lib/legs";
import { BAR_MS, fetchCandles, toInstId, type Bar, type Candle } from "@/lib/okx";
import { lastPrice } from "@/lib/okx-live";
import { analyzeOptions } from "@/lib/options/analyze";
import { collectOptionsSnapshot } from "@/lib/options/collect";
import { listRBaseHistory } from "@/lib/queries";
import { fetchDerivs } from "@/lib/research/okx-derivs";
import { fetchBookDepth, fetchOiHistory } from "@/lib/threshold/fetch";
import { fuelState } from "@/lib/threshold/fuel";
import { gammaState } from "@/lib/threshold/gamma";
import { liquidityState, volumeProfile } from "@/lib/threshold/liquidity";
import {
  THRESHOLD_RULES,
  type SignalSide,
  type SignalTf,
  type ThresholdReport,
  type ThresholdSummary,
  type VolatilityTf,
  type VolumeBin,
} from "@/lib/threshold/types";
import { volatilityState } from "@/lib/threshold/volatility";

const R = THRESHOLD_RULES;
const SIDES: readonly SignalSide[] = ["long", "short"];

/** 변동성 판정 TF — on·warn 은 이 둘만. 4H·1D 는 맥락(표에만). */
export const JUDGE_TFS: readonly SignalTf[] = ["15m", "1H"];
/** 표시 순서 — 큰 TF 부터. */
const VOL_TFS: readonly SignalTf[] = ["1D", "4H", "1H", "15m"];
const VOL_BARS = 200;
const DAY_MS = 86_400_000;

export type ThresholdKey = "volatility" | "gamma" | "fuel" | "liquidity";

export const THRESHOLD_LABEL: Record<ThresholdKey, string> = {
  volatility: "변동성 팽창",
  gamma: "감마",
  fuel: "스퀴즈 연료",
  liquidity: "유동성 공백",
};

/** 임계점 하나의 방향별 판정 — 판정 표와 summary 가 같은 값을 읽는다. */
export interface ThresholdVerdict {
  key: ThresholdKey;
  measured: boolean;
  on: Record<SignalSide, boolean>;
  /** 그 방향 추가 금지 경고 이름 — 없으면 null */
  warn: Record<SignalSide, string | null>;
}

type Parts = Pick<ThresholdReport, "spot" | "volatility" | "gamma" | "fuel" | "liquidity">;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 현재가 칸 바로 아래 칸이 고거래량(HVN)인가 — liquidityState 의 HVN 규칙(중앙값 × hvnMedianRatio)과 같다. */
export function hvnBelow(bins: readonly VolumeBin[], spot: number | null): boolean {
  if (spot === null || bins.length === 0) return false;
  const cur = bins.findIndex((b) => b.lo <= spot && spot < b.hi);
  if (cur <= 0) return false;
  return bins[cur - 1].vol >= median(bins.map((b) => b.vol)) * R.hvnMedianRatio;
}

const both = (name: string | null): Record<SignalSide, string | null> => ({ long: name, short: name });

/**
 * 네 임계점의 방향별 판정.
 * - 변동성: 15m·1H 중 하나라도 켜지면 그 방향 켜짐. 둘 다 측정돼야 measured. 과열(warn)은 양쪽 경고.
 * - 감마: 핀닝 경고는 양쪽.
 * - 유동성: 롱 경고 = 바로 위 칸 HVN(liquidity.state.warn), 숏 경고 = 바로 아래 칸 HVN. 호가 미측정이어도 경고는 사실이라 남긴다.
 * - 연료: 연환산 펀딩 ≥ +30% → 롱 경고, ≤ −30% → 숏 경고. 펀딩만 받았어도 경고는 남긴다.
 * 켜짐은 measured 일 때만 센다.
 */
export function judgeThresholds(parts: Parts): ThresholdVerdict[] {
  const judged = parts.volatility.filter((v) => JUDGE_TFS.includes(v.tf));
  const volMeasured = judged.length === JUDGE_TFS.length && judged.every((v) => v.state.measured);
  const hot = judged.filter((v) => v.state.measured && v.state.warn).map((v) => v.tf);
  const volOn = (side: SignalSide) => volMeasured && judged.some((v) => v.state.on === side);

  const g = parts.gamma;
  const gMeasured = g !== null && g.state.measured;

  const f = parts.fuel;
  const fMeasured = f !== null && f.state.measured;
  const annual = f?.fundingAnnual ?? null;

  const l = parts.liquidity;
  const lMeasured = l !== null && l.state.measured;

  return [
    {
      key: "volatility",
      measured: volMeasured,
      on: { long: volOn("long"), short: volOn("short") },
      warn: both(hot.length > 0 ? `변동성 과열(${hot.join("·")})` : null),
    },
    {
      key: "gamma",
      measured: gMeasured,
      on: { long: gMeasured && g.state.on === "long", short: gMeasured && g.state.on === "short" },
      warn: both(gMeasured && g.state.warn ? "감마 핀닝" : null),
    },
    {
      key: "fuel",
      measured: fMeasured,
      on: { long: fMeasured && f.state.on === "long", short: fMeasured && f.state.on === "short" },
      warn: {
        long: annual !== null && annual >= R.fundingAnnualWarn ? "펀딩 롱 쏠림" : null,
        short: annual !== null && annual <= -R.fundingAnnualWarn ? "펀딩 숏 쏠림" : null,
      },
    },
    {
      key: "liquidity",
      measured: lMeasured,
      on: { long: lMeasured && l.state.on === "long", short: lMeasured && l.state.on === "short" },
      warn: {
        long: l !== null && l.state.warn ? "바로 위 고거래량" : null,
        short: l !== null && hvnBelow(l.bins, parts.spot) ? "바로 아래 고거래량" : null,
      },
    },
  ];
}

/** 방향별 경고·켜짐 수·측정 수. */
export function summarize(parts: Parts): ThresholdSummary {
  const verdicts = judgeThresholds(parts);
  const warnings: Record<SignalSide, string[]> = { long: [], short: [] };
  const on: Record<SignalSide, number> = { long: 0, short: 0 };
  for (const v of verdicts) {
    for (const side of SIDES) {
      const w = v.warn[side];
      if (w !== null) warnings[side].push(w);
      if (v.on[side]) on[side] += 1;
    }
  }
  const measuredCount = verdicts.filter((v) => v.measured).length;
  return { warnings, on, measuredCount, measured: measuredCount === verdicts.length };
}

/** 다리 기록 순간의 값 — 진행 방향(side) 기준. 못 잰 칸은 null. */
export function toLegSignals(report: ThresholdReport, side: Side): LegSignals {
  const h1 = report.volatility.find((v) => v.tf === "1H") ?? null;
  const net = report.gamma?.netGexNearSpot ?? null;
  const walls = report.gamma?.wallDistPct ?? null;
  const liq = report.liquidity;
  return {
    bbwPct: h1?.bbwPct ?? null,
    atrRatio: h1?.atrRatio ?? null,
    netGexSign: net === null ? null : net > 0 ? 1 : net < 0 ? -1 : 0,
    wallDistPct: walls === null ? null : side === "long" ? walls.call : walls.put,
    depthRatio: liq?.depthRatio ?? null,
    lvnDistPct: liq === null ? null : side === "long" ? liq.gapUpDistPct : liq.gapDownDistPct,
    warnings: [...report.summary.warnings[side]],
    onLong: report.summary.on.long,
    onShort: report.summary.on.short,
    collectedAt: report.collectedAt,
  };
}

/* ───────────────────────── 서버 수집 ───────────────────────── */

function why(result: PromiseRejectedResult): string {
  const cause: unknown = result.reason;
  return cause instanceof Error ? cause.message : String(cause);
}

/** 마감 봉만 최근 count 개 — 진행 중 봉(끝 시각 > now)은 뺀다. 1D 처럼 격자가 UTC 와 어긋나도 맞다. */
async function closedCandles(instId: string, bar: Bar, count: number, nowMs: number): Promise<Candle[]> {
  const span = BAR_MS[bar];
  const from = nowMs - span * (count + 3);
  const all = await fetchCandles(instId, bar, from, nowMs, Math.ceil(count / 100) + 2);
  return all.filter((c) => c.t + span <= nowMs).slice(-count);
}

/** 24시간 전 가격 — now−24h 직전에 마감한 1H 봉 종가(최대 1시간 앞 근사). */
function priceAt24hAgo(h1: readonly Candle[], nowMs: number): number | null {
  const cutoff = nowMs - DAY_MS;
  let best: Candle | null = null;
  for (const c of h1) if (c.t + BAR_MS["1H"] <= cutoff) best = c;
  return best?.c ?? null;
}

/**
 * 임계점 수집 — 서버에서만 부른다(OKX·Deribit 공개 API, 설정 수수료율은 Supabase).
 * 왕복 비용 = 2 × 설정(기준 R 이력 최신 행) 수수료율. 수수료율을 못 읽으면 ATR÷비용만 비고 나머지는 계산한다.
 */
export async function collectThreshold(symbol: string, nowMs = Date.now()): Promise<ThresholdReport> {
  const instId = toInstId(symbol);
  const isBtc = instId.startsWith("BTC-");

  const [spotR, feeR, c15R, c4hR, c1dR, h1R, bookR, optR, derivR, oiR] = await Promise.allSettled([
    lastPrice(instId),
    listRBaseHistory().then((rows) => rows[0]?.fee_rate ?? null),
    closedCandles(instId, "15m", VOL_BARS, nowMs),
    closedCandles(instId, "4H", VOL_BARS, nowMs),
    closedCandles(instId, "1D", VOL_BARS, nowMs),
    // 1H 는 프로파일(20일 = 480봉)과 변동성(최근 200봉)·24h 전 가격이 같이 쓴다.
    closedCandles(instId, "1H", R.profileDays * 24, nowMs),
    fetchBookDepth(instId),
    isBtc ? collectOptionsSnapshot() : Promise.resolve(null),
    fetchDerivs(instId),
    fetchOiHistory(instId),
  ]);

  const candleNotes: string[] = [];
  const feeRate = feeR.status === "fulfilled" ? feeR.value : null;
  if (feeR.status === "rejected") candleNotes.push(`수수료율 미확인(${why(feeR)}) — ATR÷비용 없음`);
  else if (feeRate === null) candleNotes.push("수수료율 미설정 — ATR÷비용 없음");
  const cost = feeRate !== null && feeRate > 0 ? 2 * feeRate : 0;

  const byTf: Record<SignalTf, PromiseSettledResult<Candle[]>> = {
    "15m": c15R,
    "1H": h1R.status === "fulfilled" ? { status: "fulfilled", value: h1R.value.slice(-VOL_BARS) } : h1R,
    "4H": c4hR,
    "1D": c1dR,
  };
  const volatility: VolatilityTf[] = VOL_TFS.map((tf) => {
    const r = byTf[tf];
    if (r.status === "fulfilled") return volatilityState(r.value, tf, cost);
    candleNotes.push(`${tf}: ${why(r)}`);
    const empty = volatilityState([], tf, cost);
    return { ...empty, state: { ...empty.state, reasons: [`캔들 수집 실패: ${why(r)}`] } };
  });

  const h1 = h1R.status === "fulfilled" ? h1R.value : [];
  // 현재가 — 티커, 실패하면 마지막 마감 1H 종가.
  let spot: number | null = spotR.status === "fulfilled" && spotR.value > 0 ? spotR.value : null;
  if (spot === null) {
    candleNotes.push(`현재가 티커 실패${spotR.status === "rejected" ? `(${why(spotR)})` : ""} — 마지막 1H 종가로 대신`);
    spot = h1.length > 0 ? h1[h1.length - 1].c : null;
  }

  // 유동성 — 칸 기준을 현재가 반 칸 아래에 둬 현재가가 자기 칸 가운데쯤 오게 한다(위·아래 칸 판정이 대칭).
  const depthRatio = bookR.status === "fulfilled" && bookR.value.ok ? bookR.value.value : null;
  const liquidity =
    spot !== null && h1.length > 0
      ? liquidityState(volumeProfile(h1, R.binPct, spot * (1 - R.binPct / 2)), spot, depthRatio)
      : null;

  // 감마 — BTC 전용.
  let gamma: ThresholdReport["gamma"] = null;
  let optionsNote = "ok";
  if (!isBtc) optionsNote = "BTC 전용";
  else if (optR.status === "rejected") optionsNote = why(optR);
  else if (optR.value !== null && spot !== null) {
    const snap = optR.value;
    gamma = gammaState(analyzeOptions(snap, nowMs), spot, nowMs);
    const bad = Object.entries(snap.sources).filter(([, s]) => s !== "ok");
    if (gamma === null) optionsNote = "옵션 행 없음";
    else if (bad.length > 0) optionsNote = `일부 실패 — ${bad.map(([k, s]) => `${k} ${s}`).join(" · ")}`;
  } else if (spot === null) optionsNote = "현재가 없음";

  // 연료 — 펀딩·OI 24h·가격 24h.
  const fundingRate = derivR.status === "fulfilled" ? derivR.value.funding_rate : null;
  const oi = oiR.status === "fulfilled" && oiR.value.ok ? oiR.value.value : null;
  const fuel = fuelState({
    fundingRate,
    price24hAgo: priceAt24hAgo(h1, nowMs),
    priceNow: spot,
    oiNow: oi?.oiNow ?? null,
    oi24hAgo: oi?.oi24hAgo ?? null,
  });
  const derivNotes = [
    derivR.status === "rejected" ? `펀딩: ${why(derivR)}` : null,
    oiR.status === "rejected" ? `OI: ${why(oiR)}` : oiR.value.ok ? null : `OI: ${oiR.value.reason}`,
  ].filter((n): n is string => n !== null);

  const bookNote =
    bookR.status === "rejected" ? why(bookR) : bookR.value.ok ? "ok" : bookR.value.reason;

  const parts: Parts = { spot, volatility, gamma, fuel, liquidity };
  return {
    symbol: instId,
    collectedAt: new Date(nowMs).toISOString(),
    ...parts,
    summary: summarize(parts),
    sources: {
      candles: candleNotes.length > 0 ? candleNotes.join(" · ") : "ok",
      options: optionsNote,
      derivs: derivNotes.length > 0 ? derivNotes.join(" · ") : "ok",
      book: bookNote,
    },
  };
}
