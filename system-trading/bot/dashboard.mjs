/**
 * 시스템 트레이딩 대시보드 — 검증 계보의 기획·기준·실시간 북 상태를 한 화면에,
 * 신호 발생 시 "수동 클릭 → 실제 매매"까지 잇는 반자동 콘솔.
 *
 *   node --env-file=.env.local system-trading/bot/dashboard.mjs            # 조회 전용 (실행 모드 OFF)
 *   DASH_TRADE_MODE=demo …                                                # OKX 모의거래 실행 (데모 키 필요)
 *   DASH_TRADE_MODE=live LIVE_TRADING_ACK=I_UNDERSTAND_THE_RISK …         # 실거래 실행 (이중 안전장치)
 *
 * 원칙:
 *   · 127.0.0.1 전용 — 외부 바인딩 금지.
 *   · 실행은 사람의 클릭만 — 이 서버는 스스로 주문하지 않는다.
 *   · 신호 유효창 = 신호 봉 마감 후 다음 봉 안(백테스트의 "다음 봉 시가 진입"과 같은 자리).
 *     창을 지난 신호는 실행 버튼이 잠긴다 — 늦은 진입은 검증된 그 전략이 아니다.
 *   · 수동 체결은 별도 북(manual)에 기록. 손절·목표는 브래킷이 지키고, 시한 청산은 수동 관리.
 *   · 알람: 페이퍼 3북의 진입/청산 디스코드 알림([CAND]/[ENS]/[SWING])이 신호 알람이다.
 *     대시보드는 [DASH] 태그로 수동 체결·테스트 알림을 보낸다.
 */
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atr } from "./indicators.mjs";
import { notify } from "./notify.mjs";
import { OkxClient } from "./okx.mjs";
import { exitLevels } from "./signals.mjs";
import { appendLog, loadState, saveState } from "./state.mjs";
import { mirrorTradeOpen } from "./state-mirror.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, "..", "data");
const BACKTEST_DIR = join(here, "..", "..", "docs", "backtest");
const SB = {
  base: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SECRET_KEY,
  uid: process.env.SYSTEM_BOT_USER_ID,
};
const PORT = 8899;
const INST = "BTC-USDT-SWAP";
const FEE_PCT = 0.1;
const MAX_LEV = 10;
const TF_MS = { "1H": 3600_000, "4H": 4 * 3600_000, "1D": 24 * 3600_000 };

/* ---------- 실행 모드 — run.mjs와 같은 이중 안전장치 ---------- */
let MODE = (process.env.DASH_TRADE_MODE ?? "off").toLowerCase();
if (!["off", "demo", "live"].includes(MODE)) MODE = "off";
if (MODE === "live" && process.env.LIVE_TRADING_ACK !== "I_UNDERSTAND_THE_RISK") {
  console.error("LIVE 모드에는 LIVE_TRADING_ACK=I_UNDERSTAND_THE_RISK 가 필요합니다 — OFF로 내립니다.");
  MODE = "off";
}

/**
 * 멤버 명세 — criteria.md의 판정·청산 그대로. 대시보드 개요와 수동 실행 사이징의 단일 원천.
 * book: 신호가 흐르는 북. origin: 검증 회차. verdict: 백테스트 근거 요약(수치는 criteria.md 정본).
 */
const SPECS = {
  gc: { name: "골든크로스", tf: "4H", side: "long", exit: { type: "atr", sl: 1, tp: 3 }, book: "live", origin: "쿼드(라이브 가동)", rule: "SMA20이 SMA50 상향 교차 마감", verdict: "720일 45건 · +0.67%/건 · PF 1.75 · t 1.53 — 단, 4.8년 창 재현은 약함(t 0.77)" },
  ob: { name: "RSI 과매도 반등", tf: "4H", side: "long", exit: { type: "atr", sl: 1, tp: 3 }, book: "live", origin: "쿼드(라이브 가동)", rule: "RSI(14) 30 하향 후 위로 복귀 마감", verdict: "720일 55건 · +0.58%/건 · PF 1.51 · 3구간 전부 플러스" },
  fade: { name: "RSI 과매수 반락", tf: "4H", side: "short", exit: { type: "atr", sl: 2, tp: 4 }, book: "live", origin: "쿼드(라이브 가동)", rule: "RSI(14) 70 상향 후 아래로 복귀 마감", verdict: "720일 51건 · +0.23%/건 · 여유 최얇 — 최우선 관찰" },
  dc: { name: "20봉 신저가 이탈", tf: "1D", side: "short", exit: { type: "pct", sl: 2, tp: 4 }, book: "live", origin: "쿼드(라이브 가동)", rule: "종가가 직전 20일 최저가 아래 마감", verdict: "720일 20건 · +0.30%/건 — 표본 최얇" },
  dch: { name: "신저가 숏+일봉 하락", tf: "4H", side: "short", exit: { type: "atr", sl: 1, tp: 3 }, book: "cand", origin: "기획 10선 회차", rule: "20봉 신저가 이탈 + 일봉<일봉SMA50", verdict: "5년 164건 · +0.18%/건 · PF 1.13 · t 0.66" },
  mcv: { name: "MACD+거래량", tf: "4H", side: "long", exit: { type: "atr", sl: 1, tp: 1 }, book: "cand", origin: "기획 10선 회차", rule: "MACD 골든 교차 + 거래량 1.5×", verdict: "5년 124건 · +0.08%/건 · PF 1.11 — 여유 얇음" },
  ibq: { name: "인사이드바+저변동", tf: "1H", side: "long", exit: { type: "atr", sl: 2, tp: 6 }, book: "cand", origin: "15m·1H 재도전 회차", rule: "인사이드바 모봉 고가 돌파 + ATR<100봉 평균", verdict: "3.3년 215건 · +0.16%/건 · PF 1.19 · t 1.03" },
  ib4: { name: "인사이드바 무필터", tf: "1H", side: "long", exit: { type: "atr", sl: 3, tp: 9 }, book: "swing", origin: "주5회 회차", rule: "인사이드바 모봉 고가 돌파 (무필터)", verdict: "3.3년 304건 · +0.36%/건 · PF 1.29 · t 1.79" },
  mp1: { name: "MA눌림+일봉상승", tf: "1H", side: "long", exit: { type: "atr", sl: 2, tp: 6 }, book: "swing", origin: "주5회 회차", rule: "SMA20>50·종가>SMA200 눌림 회복 + 일봉>SMA50", verdict: "3.3년 200건 · +0.18%/건 · PF 1.20 · t 1.01" },
  rf1: { name: "RSI반락 숏+일봉하락", tf: "1H", side: "short", exit: { type: "atr", sl: 3, tp: 9 }, book: "swing", origin: "주5회 회차(파일럿)", rule: "RSI 70 반락 + 일봉<일봉SMA50", verdict: "3.3년 103건 · +0.23%/건 · 3/3구간 — 표본 미달 파일럿" },
  bzc: { name: "베이시스 공포 복귀", tf: "4H", side: "long", exit: { type: "atr", sl: 2, tp: 6 }, book: "swing", origin: "베이시스 회차 ★t=3.52", rule: "베이시스 z(180봉) −2 이탈 후 복귀 마감", verdict: "4.75년 111건 · +2.11%/건 · PF 2.27 · t 3.52 · 3/3구간 · 윌슨 하한>손익분기 (시리즈 유일)" },
};

/** 트랙 개요 — 대시보드 상단 기획 요약. 수치는 각 회차 아티팩트가 정본. */
const TRACKS = [
  { key: "live", name: "라이브 — 쿼드 공격형", desc: "gc·ob·fade·dc · 리스크 10% · 실계좌 가동 중(QuadBotLive). 경고: 4.8년 창 재현 $100→$18 — 리스크 인하·레짐 게이트 권고(사용자 결정).", gate: "—" },
  { key: "cand", name: "페이퍼 cand — 부품 단독", desc: "dch·mcv·ibq·bzc · 각 리스크 2% · 부품별 엣지를 격리 검증.", gate: "멤버별 신규 20~30건 기대값>0 → 데모 검토 (bzc는 20건 미달 시 전 북 제외)" },
  { key: "ens", name: "페이퍼 ens — 복리 후보 1.1", desc: "멤버 8(쿼드4+후보3+bzc) + 일봉 SMA200 레짐 게이트 + 드로다운 스로틀 · 리스크 2%. 품질 우선(주 ~2회). 백테스트: MAR 0.68 · 봉 MDD −37.7% · 3/3구간.", gate: "신규 30~50건 기대값>0 → 데모 검토" },
  { key: "swing", name: "페이퍼 swing — 주5회 후보 2.1", desc: "멤버 10(9+bzc) + 스로틀(레짐 없음) · 리스크 2% · 상한 4개/8%. 사전 등록 게이트 6/6 통과: 주 5.71회 · CAGR 48.4% · 봉 MDD −34.7% · MAR 1.39 · p20 $325.", gate: "신규 40~60건 기대값>0 → 데모 검토" },
];

const ARTIFACTS = [
  { name: "기획 10선 검증", url: "https://claude.ai/code/artifact/1a7bce72-93bb-492c-b040-33b52d8955b7" },
  { name: "15m·1H 재도전", url: "https://claude.ai/code/artifact/53a1cf8a-9e42-4960-bd95-35f81b3880c6" },
  { name: "복리 조합 탐색", url: "https://claude.ai/code/artifact/1efb2f1c-71d1-4497-a2f1-a3bf993c86fc" },
  { name: "주5회 스윙", url: "https://claude.ai/code/artifact/f21ea947-22ee-4e15-a0af-c2a6e4d0d720" },
  { name: "베이시스 발굴 ★게이트 6/6", url: "https://claude.ai/code/artifact/a6dc430f-df88-4960-afce-f8828d26e891" },
];

/* ---------- 파일 헬퍼 ---------- */

function readJson(p, fallback = null) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

/** JSONL 꼬리 n줄 — 파일이 커져도 통째로 파싱하지 않는다. */
function tailJsonl(p, n) {
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8");
  const lines = raw.slice(-400_000).trim().split("\n");
  return lines.slice(-n).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/* ---------- 상태 수집 ---------- */

function collectState() {
  const books = {};
  for (const book of ["cand", "ens", "swing", "manual"]) {
    const st = readJson(join(DATA, `state-${book}.json`));
    books[book] = {
      state: st,
      trades: tailJsonl(join(DATA, `trades-${book}.jsonl`), 12).filter((t) => t.type === "close" || t.type === "open" || t.type === "manual-open"),
    };
  }
  // 최근 신호 — 세 북의 decisions에서 fired=true, 24시간 이내, 멤버+봉 시각으로 중복 제거.
  const now = Date.now();
  const seen = new Set();
  const signals = [];
  for (const book of ["cand", "ens", "swing"]) {
    for (const d of tailJsonl(join(DATA, `decisions-${book}.jsonl`), 400)) {
      if (!d.fired || !d.barTs || now - d.barTs > 24 * 3600_000) continue;
      const key = `${d.member}-${d.barTs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const spec = SPECS[d.member];
      if (!spec) continue;
      const tfMs = TF_MS[spec.tf];
      const validUntil = d.barTs + 2 * tfMs; // 신호 봉 마감(barTs+tfMs) 후 다음 봉 안.
      signals.push({
        member: d.member,
        name: spec.name,
        tf: spec.tf,
        side: spec.side,
        book,
        barTs: d.barTs,
        action: d.action,
        indicators: d.indicators ?? null,
        validUntil,
        fresh: now < validUntil,
        executed: manualExecuted.has(key),
      });
    }
  }
  signals.sort((a, b) => b.barTs - a.barTs);
  return { books, signals };
}

const manualState = loadState("manual", 0);
if (!manualState.executed) manualState.executed = {};
const manualExecuted = new Set(Object.keys(manualState.executed));

/* ---------- 수동 실행 ---------- */

const client = MODE === "off" ? new OkxClient("paper") : new OkxClient(MODE);
let executing = false; // 더블클릭 이중 주문 방지.

async function executeSignal({ member, barTs, riskPct }) {
  if (MODE === "off") throw new Error("실행 모드가 OFF다 — DASH_TRADE_MODE=demo|live 로 재시작하라 (live는 LIVE_TRADING_ACK 필요).");
  const spec = SPECS[member];
  if (!spec) throw new Error(`알 수 없는 멤버: ${member}`);
  const risk = Number(riskPct);
  if (![1, 2].includes(risk)) throw new Error("리스크는 1% 또는 2%만 허용한다 (승격 사다리).");
  const key = `${member}-${barTs}`;
  if (manualExecuted.has(key)) throw new Error("이미 실행한 신호다 — 이중 진입 방지.");
  const tfMs = TF_MS[spec.tf];
  if (Date.now() >= barTs + 2 * tfMs) {
    throw new Error("신호 유효창(다음 봉 안)이 지났다 — 늦은 진입은 검증된 전략이 아니다.");
  }
  if (executing) throw new Error("다른 주문이 진행 중이다 — 잠시 후 다시.");
  executing = true;
  try {
    // 신호 봉의 ATR — 러너와 같은 계산(마감 봉 기준).
    const candles = await client.candles(INST, spec.tf, 300);
    const atrArr = atr(candles);
    const sigIdx = candles.findIndex((c) => c.t === barTs);
    const atrSig = sigIdx >= 14 ? atrArr[sigIdx] : atrArr[candles.length - 1];
    if (!atrSig) throw new Error("ATR 계산 불가 — 캔들 응답 이상.");

    const price = await client.lastPrice(INST);
    const { stop, target, stopDistPct } = exitLevels(price, spec.side, spec.exit, atrSig);
    const lev = Math.min(MAX_LEV, risk / (stopDistPct + FEE_PCT));
    const equity = await client.equityUsd();
    const inst = await client.instrument(INST);
    const notional = equity * lev;
    const lots = Math.floor(notional / price / inst.ctVal / inst.lotSz);
    const szNum = lots * inst.lotSz;
    if (szNum < inst.minSz || szNum <= 0) throw new Error(`주문 수량 미달(sz=${szNum}) — 잔고 대비 명목가가 최소 단위보다 작다.`);
    const sz = szNum.toFixed(inst.szDecimals);
    await client.setLeverage(INST, MAX_LEV, spec.side, "isolated");
    const algoClOrdId = `dm${member}${Date.now()}`;
    const ordId = await client.openWithBracket({
      instId: INST,
      side: spec.side === "long" ? "buy" : "sell",
      posSide: spec.side,
      sz,
      stop,
      target,
      mgnMode: "isolated",
      algoClOrdId,
      tickSz: inst.tickSz,
      pxDecimals: inst.pxDecimals,
    });

    const rec = {
      type: "manual-open",
      mode: MODE,
      member,
      name: spec.name,
      tf: spec.tf,
      side: spec.side,
      signalTs: barTs,
      entryPrice: price,
      stop: Math.round(stop * 100) / 100,
      target: Math.round(target * 100) / 100,
      stopDistPct: Math.round(stopDistPct * 1000) / 1000,
      lev: Math.round(lev * 100) / 100,
      riskPct: risk,
      eqAtEntry: Math.round(equity * 100) / 100,
      sz,
      ordId,
      algoClOrdId,
      maxHoldNote: `시한 ${spec.tf === "1D" ? "20봉(20일)" : spec.tf === "4H" ? "60봉(10일)" : "120봉(5일)"} — 브래킷 미체결 시 수동 정리 필요`,
    };
    manualState.executed[key] = { at: Date.now(), ordId };
    manualExecuted.add(key);
    saveState(manualState);
    appendLog("manual", "trades", rec);
    await mirrorTradeOpen("manual", { ...rec, entryTs: barTs + tfMs, riskPct: risk });
    await notify(
      `[DASH] 수동 체결(${MODE.toUpperCase()}) — ${spec.name} ${spec.side} @ ${price}\n` +
      `리스크 ${risk}% · 레버 ${rec.lev}배 · 손절 ${rec.stop} · 목표 ${rec.target} · sz ${sz}\n` +
      `${rec.maxHoldNote}`,
    );
    return rec;
  } finally {
    executing = false;
  }
}

/* ---------- 거래 조회 · 진행 로그 ---------- */

async function sbGet(path) {
  if (!SB.base || !SB.key) return null;
  const res = await fetch(`${SB.base}/rest/v1/${path}`, {
    headers: { apikey: SB.key, authorization: `Bearer ${SB.key}` },
  });
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
  return res.json();
}

/** 북별 거래를 공통 형태로 정규화 — 파일(jsonl)과 DB(라이브)를 한 표로. */
async function queryTrades(book, member, limit) {
  const out = [];
  const norm = (t, source) => ({
    source,
    book,
    member: t.member,
    name: t.name,
    side: t.side,
    mode: t.mode ?? null,
    entryTs: t.entryTs ?? (t.entry_ts ? new Date(t.entry_ts).getTime() : null),
    entryPrice: t.entryPrice ?? (t.entry_price != null ? Number(t.entry_price) : null),
    exitTs: t.exitTs ?? (t.exit_ts ? new Date(t.exit_ts).getTime() : null),
    exitPrice: t.exitPrice ?? (t.exit_price != null ? Number(t.exit_price) : null),
    exitType: t.exitType ?? t.exit_type ?? null,
    netPct: t.netPct ?? (t.net_pct != null ? Number(t.net_pct) : null),
    pnlUsd: t.pnlUsd ?? (t.pnl_usd != null ? Number(t.pnl_usd) : null),
    equityAfter: t.equityAfter ?? (t.equity_after != null ? Number(t.equity_after) : null),
    lev: t.lev != null ? Number(t.lev) : null,
    open: (t.exitType ?? t.exit_type) == null,
  });
  if (book === "live") {
    // 신규(DB) + 과거(파일) — 상태 이전(2026-08-17) 전후의 기록을 합친다.
    try {
      const rows = (await sbGet(`system_trades?user_id=eq.${SB.uid}&mode=eq.live&select=*&order=entry_ts.desc&limit=${limit}`)) ?? [];
      for (const r of rows) out.push(norm(r, "db"));
    } catch (e) {
      out.push({ source: "db", error: e.message });
    }
    const fileRecs = tailJsonl(join(DATA, "trades-live.jsonl"), 400);
    const opens = new Map();
    for (const t of fileRecs) {
      if (t.type === "open") opens.set(`${t.member}-${t.entryTs}`, t);
      if (t.type === "close") {
        const o = opens.get(t.tradeId) ?? {};
        out.push(norm({ ...o, ...t }, "file"));
        opens.delete(t.tradeId);
      }
    }
    for (const o of opens.values()) out.push(norm(o, "file"));
  } else {
    const recs = tailJsonl(join(DATA, `trades-${book}.jsonl`), 800);
    const opens = new Map();
    for (const t of recs) {
      if (t.type === "open" || t.type === "manual-open") opens.set(`${t.member}-${t.entryTs ?? t.signalTs}`, t);
      if (t.type === "close") {
        const o = opens.get(t.tradeId) ?? {};
        out.push(norm({ ...o, ...t }, "file"));
        opens.delete(t.tradeId);
      }
    }
    for (const o of opens.values()) out.push(norm(o, "file"));
  }
  return out
    .filter((t) => !member || t.member === member)
    .sort((a, b) => (b.entryTs ?? 0) - (a.entryTs ?? 0))
    .slice(0, limit);
}

async function queryDecisions(book, limit) {
  if (book === "live") {
    try {
      const rows = (await sbGet(`system_decisions?user_id=eq.${SB.uid}&mode=eq.live&select=member,tf,bar_ts,fired,action,skip,warn&order=at.desc&limit=${limit}`)) ?? [];
      return rows.map((r) => ({ member: r.member, tf: r.tf, barTs: r.bar_ts ? new Date(r.bar_ts).getTime() : null, fired: r.fired, action: r.action, skip: r.skip, warn: r.warn }));
    } catch (e) {
      return [{ warn: `DB 조회 실패: ${e.message}` }];
    }
  }
  return tailJsonl(join(DATA, `decisions-${book}.jsonl`), limit)
    .reverse()
    .map((d) => ({ member: d.member, tf: d.tf, barTs: d.barTs, fired: d.fired, action: d.action, skip: d.skip, warn: d.warn }));
}

/* ---------- 서버 ---------- */

const html = readFileSync(join(here, "dashboard.html"), "utf8");
const rounds = readJson(join(BACKTEST_DIR, "rounds.json"), { rounds: [], adopted: [] });

async function liveSnapshot() {
  if (MODE === "off") return null;
  try {
    const [equity, positions] = await Promise.all([client.equityUsd(), client.positions(INST)]);
    return { equity: Math.round(equity * 100) / 100, positions };
  } catch (e) {
    return { error: e.message };
  }
}

const server = createServer(async (req, res) => {
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": `${type}; charset=utf-8` });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/") return send(200, html, "text/html");
    // 백테스트 아카이브 정적 서빙 — docs/backtest 의 html·json만, 경로 탈출 차단.
    if (req.method === "GET" && url.pathname.startsWith("/backtest/")) {
      const name = decodeURIComponent(url.pathname.slice("/backtest/".length));
      if (!/^[\w.\-]+\.(html|json)$/.test(name)) return send(400, { error: "허용되지 않는 경로" });
      const p = join(BACKTEST_DIR, name);
      if (!existsSync(p)) return send(404, { error: "없는 파일" });
      return send(200, readFileSync(p, "utf8"), name.endsWith(".html") ? "text/html" : "application/json");
    }
    if (req.method === "GET" && url.pathname === "/api/trades") {
      const book = url.searchParams.get("book") ?? "swing";
      if (!["cand", "ens", "swing", "manual", "live"].includes(book)) return send(400, { error: "book" });
      const trades = await queryTrades(book, url.searchParams.get("member") || null, Math.min(200, Number(url.searchParams.get("limit") ?? 50)));
      return send(200, { book, trades });
    }
    if (req.method === "GET" && url.pathname === "/api/decisions") {
      const book = url.searchParams.get("book") ?? "swing";
      if (!["cand", "ens", "swing", "live"].includes(book)) return send(400, { error: "book" });
      const decisions = await queryDecisions(book, Math.min(200, Number(url.searchParams.get("limit") ?? 60)));
      return send(200, { book, decisions });
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      const { books, signals } = collectState();
      return send(200, {
        mode: MODE,
        now: Date.now(),
        specs: SPECS,
        tracks: TRACKS,
        artifacts: ARTIFACTS,
        rounds: rounds.rounds,
        books,
        signals,
        live: await liveSnapshot(),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/execute") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { member, barTs, riskPct, confirm } = JSON.parse(body || "{}");
      if (confirm !== "EXECUTE") return send(400, { error: "확인 토큰 누락 — 2단계 확인을 거쳐라." });
      const rec = await executeSignal({ member, barTs: Number(barTs), riskPct });
      return send(200, { ok: true, rec });
    }
    if (req.method === "POST" && url.pathname === "/api/test-alert") {
      await notify("[DASH] 알림 테스트 — 이 메시지가 보이면 신호 알람 경로가 살아 있다.");
      return send(200, { ok: true });
    }
    return send(404, { error: "not found" });
  } catch (e) {
    return send(500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`대시보드: http://127.0.0.1:${PORT} · 실행 모드 ${MODE.toUpperCase()}`);
  notify(`[DASH] 대시보드 가동 — http://127.0.0.1:${PORT} · 실행 모드 ${MODE.toUpperCase()}`).catch(() => {});
});
