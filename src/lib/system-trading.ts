/**
 * 시스템 트레이딩(자동매매 봇) 데이터 읽기 — 서버 전용.
 *
 * 봇은 이 앱과 같은 머신의 `system-trading/data/` 에 상태와 기록을 남긴다.
 * 앱은 그 파일을 읽기만 한다 — 봇의 진실 원천은 파일이고, 앱 DB의 시스템 북은
 * "가져오기(동기화)"로 따라가는 사본이다.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/** 봇의 완결 거래 1건 — trades-<mode>.jsonl 의 close 이벤트. */
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

export function systemDataExists(): boolean {
  return existsSync(DATA_DIR);
}

/**
 * 배선 테스트 사건 기록 — 봇의 test-trade.mjs 와 같은 파일에 쓴다.
 * 앱 버튼 발 주문과 CLI 발 주문이 한 타임라인에 남아야 리포트가 하나로 나온다.
 */
export function appendTestEvent(event: string, data: Record<string, unknown>): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(
    join(DATA_DIR, "events-test-live.jsonl"),
    JSON.stringify({ at: Date.now(), event, ...data }) + "\n",
  );
}

export function readSystemState(mode: SystemMode = "paper"): SystemState | null {
  const file = join(DATA_DIR, `state-${mode}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SystemState;
  } catch {
    return null;
  }
}

export function readSystemTrades(mode: SystemMode = "paper"): SystemTrade[] {
  const file = join(DATA_DIR, `trades-${mode}.jsonl`);
  if (!existsSync(file)) return [];
  const out: SystemTrade[] = [];
  // 진입(open) 이벤트의 손절·목표·판정 지표 — 청산 기록에 없으면 여기서 이어 붙인다.
  const opens = new Map<string, { stop?: number; target?: number; signal?: SystemSignalSnapshot }>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as SystemTrade & {
        type?: string;
        member?: string;
        entryTs?: number;
      };
      if (row.type === "open" && row.member && row.entryTs) {
        opens.set(`${row.member}-${row.entryTs}`, {
          stop: row.stop,
          target: row.target,
          signal: row.signal,
        });
      }
      if (row.type === "close") {
        const open = opens.get(row.tradeId);
        out.push({
          ...row,
          stop: row.stop ?? open?.stop,
          target: row.target ?? open?.target,
          signal: row.signal ?? open?.signal,
        });
      }
    } catch {
      // 깨진 줄 하나가 전체 가져오기를 막을 이유는 없다 — 건너뛴다.
    }
  }
  return out;
}
