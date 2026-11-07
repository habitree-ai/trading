"use server";


import type { Trade } from "@/lib/domain";
import { commonStopPrice, simulateZones } from "@/lib/mer";
import { firstEntry, merCandidate } from "@/lib/mer-report";
import { fetchCandles, floorToBar, toInstId } from "@/lib/okx";
import { listBooks, listFills, listRBaseHistory, listTrades, listZoneHits, requireUser } from "@/lib/queries";
import { stopDistance } from "@/lib/r-multiple";
import { pickPathBar } from "@/lib/trade-path";

/** 시뮬 규칙 버전 — 규칙이 바뀌면 올리고 새로 쌓는다(0046). */
const SIM_VERSION = 1;
/** 한 번 누를 때 쓰는 시간 상한 — Vercel 함수 시간(함정 12) 안에 끝나게. */
const MAX_BUDGET_MS = 7_000;

export interface MerSimFailure {
  seq: number;
  symbol: string;
  reason: string;
}

export interface MerSimResult {
  /** 이번에 관측을 넣은 거래 수 */
  done: number;
  /** 시간 예산이 끝나 손대지 못한 거래 수 — 다시 누르면 이어서 한다 */
  remaining: number;
  /** 시도했지만 못 넣은 거래 수(다음에 다시 시도된다) */
  failed: number;
  failures: MerSimFailure[];
  /** 시작도 못 했을 때 */
  error?: string;
}

/**
 * MER 시뮬 갱신(REQ-0102 D6) — 아직 관측이 없는 청산 거래를 최근 것부터 돌려 구간 5행씩 넣는다.
 *
 * 시간 예산을 넘으면 멈추고 남은 건수를 돌려준다. 같은 거래·구간·버전은 unique 라 겹쳐 눌러도 무시된다.
 * 봉 안 순서를 모르는 문제는 simulateZones 가 같은 봉 stop_first 로 보수 처리한다(함정 1).
 */
export async function runMerSimulation(budgetMs = MAX_BUDGET_MS): Promise<MerSimResult> {
  const started = Date.now();
  const budget = Math.min(MAX_BUDGET_MS, Math.max(1_000, Number.isFinite(budgetMs) ? budgetMs : MAX_BUDGET_MS));
  const empty: MerSimResult = { done: 0, remaining: 0, failed: 0, failures: [] };

  let trades: Trade[];
  let feeRateNow: number | null;
  let simulated: Set<string>;
  try {
    const books = await listBooks();
    const [perBook, rHistory, hits] = await Promise.all([
      Promise.all(books.map((b) => listTrades(b.id))),
      listRBaseHistory(),
      listZoneHits(SIM_VERSION),
    ]);
    trades = perBook.flat();
    feeRateNow = rHistory[0]?.fee_rate ?? null;
    simulated = new Set(hits.map((h) => h.trade_id));
  } catch (e: unknown) {
    return { ...empty, error: e instanceof Error ? e.message : "거래를 읽지 못했습니다" };
  }

  const queue = trades
    .filter((t) => merCandidate(t) && !simulated.has(t.id))
    .sort((a, b) => Date.parse(b.exit_at as string) - Date.parse(a.exit_at as string));

  const { supabase, user } = await requireUser();
  const failures: MerSimFailure[] = [];
  let done = 0;
  let i = 0;

  for (; i < queue.length; i += 1) {
    if (Date.now() - started >= budget) break;
    const t = queue[i];
    const fail = (reason: string) => failures.push({ seq: t.seq, symbol: t.symbol, reason });

    // 함정 5 — 진입 시점 수수료율이 없으면 지금 설정값. 둘 다 없으면 0 으로 치지 않는다(본전 손절이 틀어진다).
    const feeRate = t.fee_rate_at_entry ?? feeRateNow;
    if (feeRate === null || !(feeRate >= 0)) {
      fail("수수료율 없음(설정에서 기준 R·수수료율을 먼저 적어 주세요)");
      continue;
    }

    try {
      const entry = firstEntry(t, await listFills(t.id));
      const stop0 = t.stop_px_0 as number;
      const exit0 = t.exit_price as number;
      const exitMs = Date.parse(t.exit_at as string);
      if (entry === null) {
        fail("첫 진입가 없음");
        continue;
      }
      if (!(stopDistance(t.side, entry.px, stop0) > 0)) {
        fail("첫 진입 체결 기준으로 최초 손절이 이익 쪽");
        continue;
      }
      if (!(exitMs > entry.atMs)) {
        fail("청산 시각이 진입보다 이르거나 같음");
        continue;
      }

      const bar = pickPathBar(exitMs - entry.atMs);
      const candles = await fetchCandles(toInstId(t.symbol), bar, floorToBar(entry.atMs, bar), floorToBar(exitMs, bar));
      const input = { side: t.side, entryMs: entry.atMs, entry0: entry.px, stop0, exitMs, exit0, feeRate };
      const zoneHits = simulateZones(input, candles, bar);
      if (zoneHits.length === 0) {
        fail("진입~청산 구간 캔들 없음");
        continue;
      }

      const commonStop = commonStopPrice(t.side, entry.px, feeRate);
      const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
      const rows = zoneHits.map((h) => ({
        user_id: user.id,
        trade_id: t.id,
        zone_r: h.zoneR,
        sim_version: SIM_VERSION,
        bar: h.bar,
        entry_at: new Date(entry.atMs).toISOString(),
        entry_px: entry.px,
        stop_px: stop0,
        common_stop_px: commonStop,
        fee_rate: feeRate,
        zone_px: h.zonePx,
        outcome: h.outcome,
        reached_at: iso(h.reachedAtMs),
        common_stop_hit_at: iso(h.commonStopHitAtMs),
        exit_at: new Date(exitMs).toISOString(),
        exit_px: exit0,
      }));
      const { error } = await supabase
        .from("mer_zone_hits")
        .upsert(rows, { onConflict: "trade_id,zone_r,sim_version", ignoreDuplicates: true });
      if (error) {
        fail(`저장 실패: ${error.message}`);
        continue;
      }
      done += 1;
    } catch (e: unknown) {
      fail(e instanceof Error ? e.message : "캔들을 가져오지 못했습니다");
    }
  }

  // 화면 갱신은 버튼이 router.refresh 로 한다 — 액션 응답에 새 화면을 싣게 하면 연속 실행 때 갱신이 멈췄다.
  return { done, remaining: queue.length - i, failed: failures.length, failures };
}
