/**
 * 현물신호 데이터 읽기 — 서버 전용.
 *
 * 스캐너(/api/cron/spot-scan)가 service_role 로 쓰고, 화면은 RLS 가 걸린
 * 로그인 세션으로 본인 것만 읽는다 — system-trading.ts 와 같은 분담이다.
 */
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";

export interface SpotSignalRow {
  id: string;
  market: string;
  signal: string;
  barTs: string;
  price: number;
  drop72Pct: number | null;
  volumeMult: number | null;
  turnoverMed30: number | null;
  indicators: Json | null;
  notifiedAt: string | null;
  createdAt: string;
}

export interface SpotScanRun {
  ranAt: string;
  barTs: string | null;
  marketsScanned: number;
  signalsFound: number;
  durationMs: number | null;
  error: string | null;
  notifyStatus: string | null;
}

const SIGNAL_COLUMNS =
  "id, market, signal, bar_ts, price, drop72_pct, volume_mult, turnover_med30, indicators, notified_at, created_at";

type SignalRecord = {
  id: string;
  market: string;
  signal: string;
  bar_ts: string;
  price: number;
  drop72_pct: number | null;
  volume_mult: number | null;
  turnover_med30: number | null;
  indicators: Json | null;
  notified_at: string | null;
  created_at: string;
};

function mapSignal(r: SignalRecord): SpotSignalRow {
  return {
    id: r.id,
    market: r.market,
    signal: r.signal,
    barTs: r.bar_ts,
    price: r.price,
    drop72Pct: r.drop72_pct,
    volumeMult: r.volume_mult,
    turnoverMed30: r.turnover_med30,
    indicators: r.indicators,
    notifiedAt: r.notified_at,
    createdAt: r.created_at,
  };
}

export async function readSpotSignals(limit = 200): Promise<SpotSignalRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("spot_signals")
    .select(SIGNAL_COLUMNS)
    .order("bar_ts", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`현물신호 조회 실패: ${error.message}`);
  return (data ?? []).map(mapSignal);
}

export async function readSpotSignal(id: string): Promise<SpotSignalRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("spot_signals")
    .select(SIGNAL_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`현물신호 조회 실패: ${error.message}`);
  return data ? mapSignal(data) : null;
}

/**
 * 스캔 건강 — 마지막 실행과 지연 여부.
 * 매시 5분경 스캔이 정상이라 75분 넘게 소식이 없으면 스캐너가 죽은 것이다.
 * Date.now() 비교는 렌더(서버 컴포넌트) 밖인 여기서 한다 — react purity 규칙.
 */
export async function readSpotScanHealth(
  staleMs = 75 * 60_000,
): Promise<{ lastRun: SpotScanRun | null; stale: boolean }> {
  const runs = await readSpotScanRuns(1);
  const lastRun = runs[0] ?? null;
  return { lastRun, stale: !lastRun || Date.now() - Date.parse(lastRun.ranAt) > staleMs };
}

/** 최근 스캔 기록 — 첫 줄이 "마지막 스캔이 언제였나"의 답이다. */
export async function readSpotScanRuns(limit = 24): Promise<SpotScanRun[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("spot_scan_runs")
    .select("ran_at, bar_ts, markets_scanned, signals_found, duration_ms, error, notify_status")
    .order("ran_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`스캔 기록 조회 실패: ${error.message}`);
  return (data ?? []).map((r) => ({
    ranAt: r.ran_at,
    barTs: r.bar_ts,
    marketsScanned: r.markets_scanned,
    signalsFound: r.signals_found,
    durationMs: r.duration_ms,
    error: r.error,
    notifyStatus: r.notify_status,
  }));
}
