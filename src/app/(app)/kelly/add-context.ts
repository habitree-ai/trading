import type { Book, Trade } from "@/lib/domain";
import { closedLimitTrades } from "@/lib/loss-limits";
import type { MerZoneRow } from "@/lib/mer";
import { accelSignals, type AccelSignal } from "@/lib/mer-check";
import { buildMerReport } from "@/lib/mer-report";
import { deriveTrades, latestExit } from "@/lib/metrics";
import { listBooks, listCashFlows, listLegsByUser, listTrades, listZoneHits } from "@/lib/queries";
import { collectThreshold } from "@/lib/threshold";
import type { ThresholdReport } from "@/lib/threshold/types";

/**
 * 추가 진입 판정 재료(REQ-0102) — 포지션 카드의 체크리스트가 쓰는 MER 표·가속 신호·임계점.
 *
 * 하나가 실패해도 화면은 그린다 — 실패한 재료는 null 이고 체크리스트에서 「확인 불가」가 된다(예가 아니다).
 */
export interface AddContext {
  /** 전체 북 시뮬 관측으로 만든 MER 표 — MER 탭 기본 범위와 같다 */
  merRows: MerZoneRow[] | null;
  accel: AccelSignal[];
  /** 종목 → 임계점. 수집 실패면 null */
  thresholds: Record<string, ThresholdReport | null>;
}

async function merRows(): Promise<MerZoneRow[] | null> {
  try {
    const [books, hits] = await Promise.all([listBooks(), listZoneHits()]);
    const trades = (await Promise.all(books.map((b) => listTrades(b.id)))).flat();
    // 실제 추가 여부(진입 체결 묶음 수)는 표의 행에 안 들어간다 — 빈 맵.
    return buildMerReport(trades, hits, {}).rows;
  } catch {
    return null;
  }
}

async function accel(book: Book, trades: readonly Trade[], nowMs: number): Promise<AccelSignal[]> {
  const [flows, legs] = await Promise.all([listCashFlows(book.id), listLegsByUser()]);
  const last = latestExit(deriveTrades(book, trades, flows));
  return accelSignals({
    nowMs,
    lastExitMs: last?.exitMs ?? null,
    entryTimesMs: [...trades.map((t) => Date.parse(t.entry_at)), ...legs.map((l) => Date.parse(l.at))],
    closed: closedLimitTrades(trades),
    cashFlows: flows,
  });
}

export async function loadAddContext(
  book: Book,
  trades: readonly Trade[],
  symbols: readonly string[],
  nowMs: number,
): Promise<AddContext> {
  const unique = [...new Set(symbols)];
  const [rows, signals, reports] = await Promise.all([
    merRows(),
    accel(book, trades, nowMs),
    Promise.all(unique.map((s) => collectThreshold(s, nowMs).catch(() => null))),
  ]);
  return {
    merRows: rows,
    accel: signals,
    thresholds: Object.fromEntries(unique.map((s, i) => [s, reports[i]])),
  };
}
