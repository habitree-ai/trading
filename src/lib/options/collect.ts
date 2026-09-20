/**
 * 옵션 수집 오케스트레이터 — 여섯 호출을 한꺼번에 부르고 `OptionsSnapshot` 하나로 조립한다.
 *
 * `@/lib/research/collect` 와 같은 방식이다. 소스 하나가 죽어도 나머지는 남기고, 죽은 자리는
 * 빈 값(null·[])이 되며 `sources` 에 사유가 적힌다 — 화면이 "값이 0" 과 "못 받았다" 를
 * 갈라 보여 줘야 하기 때문이다. 옵션 거래소 둘(OKX·Deribit)이 **모두** 죽었을 때만 throw 한다.
 * 종목이 하나도 없으면 그릴 게 없고, `(app)/error.tsx` 카드가 다시 시도를 안내한다.
 *
 * 지수가는 소스 키가 아니다. OKX 지수를 우선 쓰고 없으면 Deribit 지수로 메운다 — 둘을
 * 병렬로 받아 순수 함수 안에서 고르므로, 폴백 순서를 픽스처만으로 검증할 수 있다.
 * 둘 다 실패하면 null 이고 분석 계층이 USD 환산·GEX 를 null 로 돌린다.
 */

import { fetchDeribitIndexPrice, fetchDeribitOptions, fetchDvol } from "@/lib/options/deribit";
import { fetchOkxDailyCloses, fetchOkxIndexPrice, fetchOkxOptions } from "@/lib/options/okx";
import type {
  OkxHistoryPoint,
  OptionRow,
  OptionSourceStatus,
  OptionsSnapshot,
  TakerBlockFlow,
} from "@/lib/options/types";

/** OKX 는 종목·흐름·이력이 한 호출 묶음으로 온다(`fetchOkxOptions`). */
export interface OkxOptionsBundle {
  rows: OptionRow[];
  flow: TakerBlockFlow | null;
  history: OkxHistoryPoint[];
}

/** 소스별 호출을 낱개로 받는다 — 지수가 둘은 `sources` 에 들어가지 않는 보조 재료다. */
export interface SettledOptionSources {
  okx: PromiseSettledResult<OkxOptionsBundle>;
  deribit: PromiseSettledResult<OptionRow[]>;
  dvol: PromiseSettledResult<number | null>;
  candles: PromiseSettledResult<number[]>;
  okxIndex: PromiseSettledResult<number | null>;
  deribitIndex: PromiseSettledResult<number | null>;
}

function reason(result: PromiseRejectedResult): string {
  const cause = result.reason;
  return cause instanceof Error ? cause.message : String(cause);
}

function status(result: PromiseSettledResult<unknown>): string {
  return result.status === "rejected" ? `error: ${reason(result)}` : "ok";
}

/** allSettled 결과 → 스냅샷. 순수 함수라 실패 조합을 그대로 테스트할 수 있다. */
export function buildOptionsSnapshot(
  results: SettledOptionSources,
  nowIso: string,
): OptionsSnapshot {
  const { okx, deribit, dvol, candles, okxIndex, deribitIndex } = results;

  const okxBundle = okx.status === "fulfilled" ? okx.value : null;
  const deribitRows = deribit.status === "fulfilled" ? deribit.value : [];

  // 응답은 왔는데 종목이 0행이면 성공이 아니다 — 봉투 모양이 바뀌어 파서가 빈 배열을 돌린
  // 경우가 "OI 0" 으로 읽히면 안 된다. 실패로 적어야 화면이 그 거래소를 빼고 말한다.
  const empty = (venue: string) => `error: ${venue} 응답에 종목이 없습니다`;
  const sources: OptionSourceStatus = {
    okx: okxBundle !== null && okxBundle.rows.length === 0 ? empty("OKX") : status(okx),
    deribit: deribit.status === "fulfilled" && deribitRows.length === 0 ? empty("Deribit") : status(deribit),
    dvol: status(dvol),
    candles: status(candles),
  };

  // OKX 지수가 우선. 받긴 했는데 비어 있는 경우(null)도 Deribit 으로 넘어간다.
  const okxPrice = okxIndex.status === "fulfilled" ? okxIndex.value : null;
  const deribitPrice = deribitIndex.status === "fulfilled" ? deribitIndex.value : null;

  return {
    collectedAt: nowIso,
    indexPrice: okxPrice ?? deribitPrice,
    rows: [...(okxBundle?.rows ?? []), ...deribitRows],
    okxFlow: okxBundle?.flow ?? null,
    okxHistory: okxBundle?.history ?? [],
    dvol: dvol.status === "fulfilled" ? dvol.value : null,
    dailyCloses: candles.status === "fulfilled" ? candles.value : [],
    sources,
  };
}

/**
 * 여섯 호출을 병렬로 수집한다. 시각은 여기서 한 번 잡아 종목 필터(만기 지남)와
 * `collectedAt` 이 같은 기준을 쓰게 한다. 옵션 거래소 둘 다 실패하면 throw.
 */
export async function collectOptionsSnapshot(): Promise<OptionsSnapshot> {
  const nowMs = Date.now();
  const [okx, deribit, dvol, candles, okxIndex, deribitIndex] = await Promise.allSettled([
    fetchOkxOptions(nowMs),
    fetchDeribitOptions(nowMs),
    fetchDvol(),
    fetchOkxDailyCloses(),
    fetchOkxIndexPrice(),
    fetchDeribitIndexPrice(),
  ]);

  const snapshot = buildOptionsSnapshot(
    { okx, deribit, dvol, candles, okxIndex, deribitIndex },
    new Date(nowMs).toISOString(),
  );
  if (snapshot.sources.okx !== "ok" && snapshot.sources.deribit !== "ok") {
    throw new Error(
      `옵션 소스 두 곳 모두 수집에 실패했습니다: OKX ${snapshot.sources.okx} · Deribit ${snapshot.sources.deribit}`,
    );
  }
  return snapshot;
}
