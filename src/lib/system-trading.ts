/**
 * 시스템 트레이딩(자동매매 봇) 데이터 읽기 — 서버 전용.
 *
 * 봇은 상태와 기록을 Supabase 에 남긴다(`system_state`·`system_trades` 등).
 * 예전에는 봇이 도는 머신의 `system-trading/data/` 파일이 진실 원천이라,
 * 그 PC 밖에서는 아무것도 보이지 않았다 — 배포된 앱에서 이 화면이 늘 비어 있던 이유다.
 *
 * RLS 가 걸린 표라 로그인 세션으로 읽는다. 봇은 service_role 로 쓴다.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { createClient } from "@/lib/supabase/server";

const DATA_DIR = join(process.cwd(), "system-trading", "data");

export type SystemMode = "paper" | "demo" | "live";

/** 시스템 봇 전용 북 이름 — 모드마다 북을 나눠 가상 성적과 실계좌 성적이 섞이지 않게 한다. */
export const SYSTEM_BOOK_NAMES: Record<SystemMode, string> = {
  paper: "시스템 트레이딩 (페이퍼)",
  demo: "시스템 트레이딩 (데모)",
  live: "시스템 트레이딩 (라이브)",
};

export interface SystemPosition {
  member: string;
  name: string;
  side: "long" | "short";
  entryTs: number;
  entryPrice: number;
  stop: number;
  target: number;
  lev: number;
  riskPct: number;
}

export interface SystemState {
  mode: SystemMode;
  createdAt: number;
  /** 페이퍼 모드의 가상 잔고 — 데모·라이브는 거래소가 정본이라 null */
  equity: number | null;
  lastBarTs: Record<string, number>;
  positions: Record<string, SystemPosition>;
}

/** 판정 시점의 지표 스냅샷 — 진입근거의 재료. */
export interface SystemSignalSnapshot {
  close: number | null;
  rsi: number | null;
  atr: number | null;
  sma20: number | null;
  sma50: number | null;
  ll20: number | null;
}

/** 봇의 완결 거래 1건. */
export interface SystemTrade {
  at: number;
  tradeId: string;
  member: string;
  name: string;
  side: "long" | "short";
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  exitType: "tp" | "sl" | "time" | "unknown" | "algo";
  holdBars?: number;
  /** 손절가·목표가 — 진입 주문과 함께 걸렸던 값 */
  stop?: number;
  target?: number;
  signal?: SystemSignalSnapshot;
  lev: number;
  /** 계좌 기준 손익률(%) — 수수료·레버리지 반영 */
  netPct: number;
  /** 진입 시점 잔고 — 손익 금액의 분모 */
  eqAtEntry?: number;
  /** 손익 금액($) */
  pnlUsd?: number;
  equityAfter?: number;
}

/** numeric 칸은 문자열로 오기도 한다 — 화면 계산에 들어가기 전에 숫자로 고정한다. */
function num(v: number | string | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

interface SystemStateRow {
  mode: SystemMode;
  equity: number | string | null;
  last_bar_ts: Record<string, number> | null;
  positions: Record<string, SystemPosition> | null;
  created_at: string;
}

export async function readSystemState(mode: SystemMode = "paper"): Promise<SystemState | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("system_state")
    .select("mode, equity, last_bar_ts, positions, created_at")
    .eq("mode", mode)
    .maybeSingle();
  // 아직 한 번도 안 돈 모드는 행이 없다 — 화면에서는 "없음"이지 오류가 아니다.
  if (error || !data) return null;
  const row = data as SystemStateRow;
  return {
    mode,
    createdAt: new Date(row.created_at).getTime(),
    equity: num(row.equity) ?? null,
    lastBarTs: row.last_bar_ts ?? {},
    positions: row.positions ?? {},
  };
}

interface SystemTradeRow {
  trade_id: string;
  member: string;
  name: string;
  side: "long" | "short";
  entry_ts: string;
  exit_ts: string | null;
  entry_price: number | string;
  exit_price: number | string | null;
  exit_type: string | null;
  hold_bars: number | null;
  stop: number | string | null;
  target: number | string | null;
  signal: SystemSignalSnapshot | null;
  lev: number | string | null;
  net_pct: number | string | null;
  eq_at_entry: number | string | null;
  pnl_usd: number | string | null;
  equity_after: number | string | null;
  closed_at: string | null;
}

/** 완결 거래만 — 열린 포지션은 `readSystemState().positions` 가 들고 있다. */
export async function readSystemTrades(mode: SystemMode = "paper"): Promise<SystemTrade[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("system_trades")
    .select(
      "trade_id, member, name, side, entry_ts, exit_ts, entry_price, exit_price, exit_type, hold_bars, stop, target, signal, lev, net_pct, eq_at_entry, pnl_usd, equity_after, closed_at",
    )
    .eq("mode", mode)
    .not("exit_ts", "is", null)
    .order("exit_ts", { ascending: true });
  if (error || !data) return [];

  return (data as SystemTradeRow[]).map((r) => ({
    at: r.closed_at ? new Date(r.closed_at).getTime() : new Date(r.exit_ts ?? r.entry_ts).getTime(),
    tradeId: r.trade_id,
    member: r.member,
    name: r.name,
    side: r.side,
    entryTs: new Date(r.entry_ts).getTime(),
    exitTs: new Date(r.exit_ts ?? r.entry_ts).getTime(),
    entryPrice: num(r.entry_price) ?? 0,
    exitPrice: num(r.exit_price) ?? 0,
    exitType: (r.exit_type ?? "unknown") as SystemTrade["exitType"],
    holdBars: r.hold_bars ?? undefined,
    stop: num(r.stop),
    target: num(r.target),
    signal: r.signal ?? undefined,
    lev: num(r.lev) ?? 0,
    netPct: num(r.net_pct) ?? 0,
    eqAtEntry: num(r.eq_at_entry),
    pnlUsd: num(r.pnl_usd),
    equityAfter: num(r.equity_after),
  }));
}

/**
 * 배선 테스트 사건 기록 — 봇의 test-trade.mjs 와 같은 파일에 쓴다.
 * 앱 버튼 발 주문과 CLI 발 주문이 한 타임라인에 남아야 리포트가 하나로 나온다.
 *
 * 이 경로만 아직 파일이다 — 리포트(test-report.mjs)가 파일을 읽기 때문이다.
 * 파일을 쓸 수 없는 배포 환경에서는 던지며, 그 예외는 부르는 쪽이 주문 전에 잡는다.
 */
export function appendTestEvent(event: string, data: Record<string, unknown>): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(
    join(DATA_DIR, "events-test-live.jsonl"),
    JSON.stringify({ at: Date.now(), event, ...data }) + "\n",
  );
}
