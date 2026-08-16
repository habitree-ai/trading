/**
 * 시스템 트레이딩(자동매매 봇) 데이터 읽기 — 서버 전용.
 *
 * 봇은 이 앱과 같은 머신의 `system-trading/data/` 에 상태와 기록을 남긴다.
 * 앱은 그 파일을 읽기만 한다 — 봇의 진실 원천은 파일이고, 앱 DB의 시스템 북은
 * "가져오기(동기화)"로 따라가는 사본이다.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "system-trading", "data");

/** 시스템 봇 전용 북 이름 — 이 이름으로 기존 북과 구분한다. */
export const SYSTEM_BOOK_NAME = "시스템 트레이딩 (페이퍼)";

export type SystemMode = "paper" | "demo" | "live";

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
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as SystemTrade & { type?: string };
      if (row.type === "close") out.push(row);
    } catch {
      // 깨진 줄 하나가 전체 가져오기를 막을 이유는 없다 — 건너뛴다.
    }
  }
  return out;
}
