/**
 * 상태·데이터 저장 — system-trading/data/ 가 이 시스템의 진실 원천이다.
 *
 * state.json      지금 상태 (잔고·열린 포지션·마지막으로 평가한 봉)
 * decisions.jsonl 모든 평가 기록 — 신호가 안 났어도 남는다. 고도화의 원재료.
 * trades.jsonl    완결 거래 — 전방 검증 성적표.
 * equity.jsonl    사이클마다의 잔고 스냅샷.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

/** 모드별 상태 파일 — 페이퍼·데모·라이브 기록이 섞이면 안 된다. */
const stateFile = (mode) => join(DATA_DIR, `state-${mode}.json`);
const logFile = (mode, name) => join(DATA_DIR, `${name}-${mode}.jsonl`);

export function loadState(mode, paperStartEquity) {
  ensureDir();
  const file = stateFile(mode);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  return {
    mode,
    createdAt: Date.now(),
    equity: mode === "paper" ? paperStartEquity : null,
    /** 기준별 마지막으로 평가한 마감 봉 ts — 같은 봉을 두 번 평가하지 않는다. */
    lastBarTs: {},
    /** 기준별 열린 포지션 — 한 기준 한 포지션. */
    positions: {},
  };
}

export function saveState(state) {
  ensureDir();
  writeFileSync(stateFile(state.mode), JSON.stringify(state, null, 2));
}

export function appendLog(mode, name, obj) {
  ensureDir();
  appendFileSync(logFile(mode, name), JSON.stringify({ at: Date.now(), ...obj }) + "\n");
}
