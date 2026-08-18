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
import type { Database } from "@/lib/supabase/database.types";

const DATA_DIR = join(process.cwd(), "system-trading", "data");

/**
 * 봇의 매매 단위 — DB `system_mode` enum 이 정본이라 생성 타입에서 파생한다.
 *
 * 넓혀 쓰고 싶은 유혹이 있다(전방 검증 러너 cand·ens·swing 과 콘솔의 manual). 그러나
 * enum 에 없는 값으로 조회하면 Postgres 가 22P02 로 거절하고, 타입만 넓히면 그 실패가
 * 컴파일 시점에 안 보인다. 러너 모드를 켜는 것은 0020 마이그레이션을 DB 에 적용하고
 * 이 타입을 다시 생성하는 일이지, 여기 문자열을 더하는 일이 아니다.
 */
export type SystemMode = Database["public"]["Enums"]["system_mode"];

/** 북 사본을 두는 모드 — 승격 사다리의 본대만이다. 러너는 북을 만들지 않는다. */
export type SystemBookMode = "paper" | "demo" | "live";

/** 시스템 봇 전용 북 이름 — 모드마다 북을 나눠 가상 성적과 실계좌 성적이 섞이지 않게 한다. */
export const SYSTEM_BOOK_NAMES: Record<SystemBookMode, string> = {
  paper: "시스템 트레이딩 (페이퍼)",
  demo: "시스템 트레이딩 (데모)",
  live: "시스템 트레이딩 (라이브)",
};

export interface SystemModeMeta {
  label: string;
  /** 한 줄 성격 — 화면에서 모드를 고를 때 이게 뭔지 알 수 있게. */
  desc: string;
  /** 실제 돈이 움직이는가 — 색과 경고를 가르는 유일한 기준이다. */
  real: boolean;
  /** 본대(승격 사다리) / 러너(전방 검증) / 콘솔(수동 클릭) */
  group: "ladder" | "runner" | "console";
}

/**
 * 모드 설명표 — 아직 DB enum 에 없는 모드까지 미리 적어 둔다.
 *
 * 키를 문자열로 연 것은 의도다. 0020 이 적용되면 `listActiveModes` 가 러너 모드를
 * 돌려주기 시작하는데, 그때 이 표에 항목이 없으면 화면에 코드값이 그대로 뜬다.
 */
export const SYSTEM_MODE_META: Record<string, SystemModeMeta> = {
  live: { label: "라이브", desc: "실계좌 — 쿼드 공격형 4기준", real: true, group: "ladder" },
  demo: { label: "데모", desc: "거래소 데모계정 — 주문 배선 검증", real: false, group: "ladder" },
  paper: { label: "페이퍼", desc: "가상 잔고 — 판정만 돌린다", real: false, group: "ladder" },
  cand: { label: "후보 발굴", desc: "새 기준 후보의 전방 검증 러너", real: false, group: "runner" },
  ens: { label: "앙상블", desc: "기준 조합의 전방 검증 러너", real: false, group: "runner" },
  swing: { label: "스윙", desc: "장주기 변형의 전방 검증 러너", real: false, group: "runner" },
  manual: { label: "수동 클릭", desc: "시스템 콘솔에서 사람이 넣은 페이퍼 진입", real: false, group: "console" },
};

/** 화면에 나열하는 순서 — 실계좌가 맨 앞. 무엇이 진짜인지가 먼저 읽혀야 한다. */
export const SYSTEM_MODE_ORDER: string[] = [
  "live",
  "demo",
  "paper",
  "cand",
  "ens",
  "swing",
  "manual",
];

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
  /** 진입 시점 잔고 · 명목가 — 라이브 진입에만 붙는다(페이퍼는 없을 수 있다). */
  eqAtEntry?: number;
  notionalUsd?: number;
  /** 손절까지의 거리(%) — 사이징의 분모 */
  stopDistPct?: number;
  /** 보유 시한(봉 수) */
  maxHold?: number;
  tf?: string;
  signal?: SystemSignalSnapshot;
}

export interface SystemState {
  mode: SystemMode;
  createdAt: number;
  /** 마지막으로 이 행이 갱신된 시각 — 봇이 살아 있는지의 근거. */
  updatedAt: number;
  /** 페이퍼 모드의 가상 잔고 — 데모·라이브는 거래소가 정본이라 null */
  equity: number | null;
  /** 화면에서 끄고 켜는 라이브 킬스위치. 꺼져 있으면 실주문이 나가지 않는다. */
  liveEnabled: boolean;
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
  /** 아직 안 닫힌 포지션 — 손익 칸이 전부 비어 있고 집계에서 빠진다. */
  open: boolean;
  entryTs: number;
  /** 진행 중이면 진입 시각과 같다 — 정렬이 깨지지 않게 채워 둔다. */
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
  /** 진입 시 건 리스크(%) — 사이징의 입력값 */
  riskPct?: number;
  /** 계좌 기준 손익률(%) — 수수료·레버리지 반영 */
  netPct: number;
  /** 진입 시점 잔고 — 손익 금액의 분모 */
  eqAtEntry?: number;
  /** 손익 금액($) */
  pnlUsd?: number;
  equityAfter?: number;
  /** 포지션 명목가($) */
  notionalUsd?: number;
  /** 거래소 주문 id — 페이퍼는 비어 있다 */
  ordId?: string;
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
  live_enabled: boolean | null;
  last_bar_ts: Record<string, number> | null;
  positions: Record<string, SystemPosition> | null;
  created_at: string;
  updated_at: string;
}

export async function readSystemState(mode: SystemMode = "paper"): Promise<SystemState | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("system_state")
    .select("mode, equity, live_enabled, last_bar_ts, positions, created_at, updated_at")
    .eq("mode", mode)
    .maybeSingle();
  // 아직 한 번도 안 돈 모드는 행이 없다 — 화면에서는 "없음"이지 오류가 아니다.
  if (error || !data) return null;
  const row = data as SystemStateRow;
  return {
    mode,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    equity: num(row.equity) ?? null,
    liveEnabled: row.live_enabled ?? false,
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
  risk_pct: number | string | null;
  net_pct: number | string | null;
  eq_at_entry: number | string | null;
  pnl_usd: number | string | null;
  equity_after: number | string | null;
  notional_usd: number | string | null;
  ord_id: string | null;
  closed_at: string | null;
}

const TRADE_COLUMNS =
  "trade_id, member, name, side, entry_ts, exit_ts, entry_price, exit_price, exit_type, hold_bars, stop, target, signal, lev, risk_pct, net_pct, eq_at_entry, pnl_usd, equity_after, notional_usd, ord_id, closed_at";

function toTrade(r: SystemTradeRow): SystemTrade {
  const open = r.exit_ts === null;
  return {
    at: r.closed_at ? new Date(r.closed_at).getTime() : new Date(r.exit_ts ?? r.entry_ts).getTime(),
    tradeId: r.trade_id,
    member: r.member,
    name: r.name,
    side: r.side,
    open,
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
    riskPct: num(r.risk_pct),
    netPct: num(r.net_pct) ?? 0,
    eqAtEntry: num(r.eq_at_entry),
    pnlUsd: num(r.pnl_usd),
    equityAfter: num(r.equity_after),
    notionalUsd: num(r.notional_usd),
    ordId: r.ord_id ?? undefined,
  };
}

/**
 * 완결 거래 — 청산이 끝난 것만. 열린 포지션은 `readSystemState().positions` 가 들고 있다.
 *
 * 기본값이 완결만인 것은 의도다: 성과 집계에 미확정 손익이 섞이면 승률과 기대값이
 * 시세를 따라 흔들린다. 목록 화면처럼 진행 중인 것도 보여야 하는 자리는
 * `readSystemTradesAll` 을 쓴다.
 */
export async function readSystemTrades(mode: SystemMode = "paper"): Promise<SystemTrade[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("system_trades")
    .select(TRADE_COLUMNS)
    .eq("mode", mode)
    .not("exit_ts", "is", null)
    .order("exit_ts", { ascending: true });
  if (error || !data) return [];
  return (data as SystemTradeRow[]).map(toTrade);
}

/** 진입 순으로 전량 — 진행 중인 포지션은 `open: true` 로 섞여 온다. */
export async function readSystemTradesAll(mode: SystemMode): Promise<SystemTrade[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("system_trades")
    .select(TRADE_COLUMNS)
    .eq("mode", mode)
    .order("entry_ts", { ascending: false });
  if (error || !data) return [];
  return (data as SystemTradeRow[]).map(toTrade);
}

/** 잔고 스냅샷 — 사이클마다 한 줄. 시스템 자금 곡선의 원재료다. */
export interface SystemEquityPoint {
  at: number;
  equity: number | null;
  openMembers: string[];
}

export async function readSystemEquity(
  mode: SystemMode,
  limit = 500,
): Promise<SystemEquityPoint[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("system_equity")
    .select("equity, open_members, at")
    .eq("mode", mode)
    .order("at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];

  const rows = data as { equity: number | string | null; open_members: string[] | null; at: string }[];
  // 최신순으로 받아 자르고(가장 최근 구간을 남긴다) 화면용으로 되돌린다.
  return rows
    .map((r) => ({
      at: new Date(r.at).getTime(),
      equity: num(r.equity) ?? null,
      openMembers: r.open_members ?? [],
    }))
    .reverse();
}

/** 사이클마다의 판정 한 줄 — 신호가 없던 봉도 남는다. */
export interface SystemDecision {
  at: number;
  member: string | null;
  tf: string | null;
  barTs: number | null;
  fired: boolean | null;
  action: string | null;
  skip: string | null;
  warn: string | null;
  indicators: SystemSignalSnapshot | null;
}

export async function readSystemDecisions(
  mode: SystemMode,
  limit = 200,
): Promise<SystemDecision[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("system_decisions")
    .select("member, tf, bar_ts, fired, action, skip, warn, indicators, at")
    .eq("mode", mode)
    .order("at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];

  const rows = data as {
    member: string | null;
    tf: string | null;
    bar_ts: string | null;
    fired: boolean | null;
    action: string | null;
    skip: string | null;
    warn: string | null;
    indicators: SystemSignalSnapshot | null;
    at: string;
  }[];
  return rows.map((r) => ({
    at: new Date(r.at).getTime(),
    member: r.member,
    tf: r.tf,
    barTs: r.bar_ts ? new Date(r.bar_ts).getTime() : null,
    fired: r.fired,
    action: r.action,
    skip: r.skip,
    warn: r.warn,
    indicators: r.indicators,
  }));
}

/**
 * 데이터가 한 줄이라도 있는 모드 — 화면의 모드 탭을 이걸로 만든다.
 *
 * 한 번도 안 돈 모드까지 탭으로 세우면 빈 화면이 늘어서고, 어느 것이 실제로
 * 돌고 있는지가 안 보인다. 상태·거래·잔고 어디든 흔적이 있으면 살아 있는 모드다.
 */
export async function listActiveModes(): Promise<SystemMode[]> {
  const supabase = await createClient();
  const [states, trades, equity] = await Promise.all([
    supabase.from("system_state").select("mode"),
    supabase.from("system_trades").select("mode"),
    supabase.from("system_equity").select("mode"),
  ]);

  const seen = new Set<string>();
  for (const res of [states, trades, equity]) {
    for (const row of (res.data ?? []) as { mode: SystemMode }[]) seen.add(row.mode);
  }
  // 순서표에 없는 모드가 DB 에 생겨도 잃지 않는다 — 뒤에 붙여 둔다.
  const known = SYSTEM_MODE_ORDER.filter((m) => seen.has(m)) as SystemMode[];
  const extra = [...seen].filter((m) => !SYSTEM_MODE_ORDER.includes(m)) as SystemMode[];
  return [...known, ...extra];
}

/** 모드 하나의 성적표 — 완결 거래만으로 낸다. */
export interface SystemSummary {
  closed: number;
  open: number;
  wins: number;
  losses: number;
  winRate: number | null;
  /** 평균수익 ÷ 평균손실 — 손실이 없으면 null(무한대를 숫자로 적지 않는다). */
  payoff: number | null;
  /** 건당 기대 손익($) */
  expectancyUsd: number | null;
  /** 건당 기대 수익률(%) — 계좌 기준, 레버리지·수수료 반영된 net_pct 의 평균 */
  expectancyPct: number | null;
  netPnlUsd: number;
  grossProfit: number;
  grossLoss: number;
  maxLossStreak: number;
  currentStreak: number;
  lastExitAt: number | null;
}

export function summarizeSystem(trades: readonly SystemTrade[]): SystemSummary {
  const closed = trades.filter((t) => !t.open);
  const open = trades.length - closed.length;
  // 금액을 못 남긴 거래(러너 거울 등)는 손익률로 승패를 가른다.
  const outcome = (t: SystemTrade) => (t.pnlUsd ?? t.netPct);
  const wins = closed.filter((t) => outcome(t) > 0);
  const losses = closed.filter((t) => outcome(t) < 0);

  const sum = (arr: readonly SystemTrade[], f: (t: SystemTrade) => number) =>
    arr.reduce((s, t) => s + f(t), 0);
  const grossProfit = sum(wins, (t) => t.pnlUsd ?? 0);
  const grossLoss = Math.abs(sum(losses, (t) => t.pnlUsd ?? 0));
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  let maxLossStreak = 0;
  let run = 0;
  for (const t of closed) {
    if (outcome(t) < 0) {
      run += 1;
      maxLossStreak = Math.max(maxLossStreak, run);
    } else run = 0;
  }
  // 지금 이어지는 연속 — 양수면 연승, 음수면 연패.
  let currentStreak = 0;
  for (let i = closed.length - 1; i >= 0; i -= 1) {
    const v = outcome(closed[i]);
    if (v === 0) break;
    if (currentStreak === 0) currentStreak = v > 0 ? 1 : -1;
    else if ((v > 0 && currentStreak > 0) || (v < 0 && currentStreak < 0)) {
      currentStreak += v > 0 ? 1 : -1;
    } else break;
  }

  return {
    closed: closed.length,
    open,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : null,
    payoff: avgLoss > 0 ? avgWin / avgLoss : null,
    expectancyUsd: closed.length ? (grossProfit - grossLoss) / closed.length : null,
    expectancyPct: closed.length ? sum(closed, (t) => t.netPct) / closed.length : null,
    netPnlUsd: grossProfit - grossLoss,
    grossProfit,
    grossLoss,
    maxLossStreak,
    currentStreak,
    lastExitAt: closed.length ? Math.max(...closed.map((t) => t.exitTs)) : null,
  };
}

/** 잔고 곡선의 최대 낙폭(비율, 음수) — 스냅샷이 없으면 0. */
export function systemDrawdown(points: readonly SystemEquityPoint[]): {
  maxDrawdownPct: number;
  peak: number | null;
  trough: number | null;
} {
  let peak = -Infinity;
  let worst = 0;
  let peakAtWorst: number | null = null;
  let troughAtWorst: number | null = null;
  for (const p of points) {
    if (p.equity === null) continue;
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = (p.equity - peak) / peak;
      if (dd < worst) {
        worst = dd;
        peakAtWorst = peak;
        troughAtWorst = p.equity;
      }
    }
  }
  return { maxDrawdownPct: worst, peak: peakAtWorst, trough: troughAtWorst };
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

/** 모드마다 완결·진행 건수 — 모드 탭이 "여기 뭐가 있는지"를 눌러 보기 전에 말한다. */
export async function readModeCounts(): Promise<Record<string, { closed: number; open: number }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("system_trades").select("mode, exit_ts");
  if (error || !data) return {};

  const out: Record<string, { closed: number; open: number }> = {};
  for (const row of data as { mode: string; exit_ts: string | null }[]) {
    const slot = (out[row.mode] ??= { closed: 0, open: 0 });
    if (row.exit_ts === null) slot.open += 1;
    else slot.closed += 1;
  }
  return out;
}
