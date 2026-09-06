/**
 * REQ-0040 — 실거래 반사실 백테스트: 레버리지 축소 × 손절 폭 확대.
 *
 * 본인 실거래의 "진입 결정"(종목·방향·시각·가격·증거금)은 그대로 두고,
 * 레버리지 L′ 와 손절 폭 S 만 바꿨을 때의 결과를 실제 캔들 경로로 재현한다.
 *
 *  실험 1 (오버레이) — 실제 청산 시각까지 보유. 그 전에 강제청산(L′)·손절 S 가 닿으면 거기서 청산.
 *  실험 2 (기계적 청산) — 진입만 남기고 손절 S / 목표 k×S / 시한 H 로 청산. 진입 품질 검사.
 *
 * 사이징 프레임 셋: 동일 증거금(M 유지) · 동일 명목(N 유지) · 동일 리스크(거래당 $100).
 * 사전 등록: .backlog/2-active/REQ-0040_*.md — 격자·게이트는 그 문서가 정본.
 *
 * 실행: node re_sys/counterfactual.mjs [--stage=A|B]
 *   A: 로컬 데이터만 (실험 1 전 거래 · 실험 2 BTC/DOGE)
 *   B: 나머지 종목 15m 청크를 수집해 실험 2를 전 거래로 확장 (게이트 통과 시)
 */
import { loadData, saveData } from "./lib/data.mjs";
import { chunkKey, chunkStarts, fetchChunk, getWindow, loadChunkStore, saveChunkStore, TF_LADDER } from "./lib/windows.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const STAGE = (args.stage ?? "A").toUpperCase();

const r1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 100) / 100);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* ---------- 사전 등록 격자 ---------- */
const LEVERS = ["actual", 50, 20, 10, 5, 3];
const STOPS_PCT = [null, 0.25, 0.5, 1, 2, 3, 5, 8]; // null = 손절 없음(강제청산만)
const STOPS_ATR = [1, 2, 3];
const EXP2_STOPS_PCT = [0.5, 1, 2, 3, 5];
const EXP2_STOPS_ATR = [1, 2, 3];
const TP_K = [1, 1.5, 2, 3];
const HORIZONS = [
  { key: "4h", ms: 4 * HOUR },
  { key: "24h", ms: DAY },
  { key: "72h", ms: 3 * DAY },
  { key: "7d", ms: 7 * DAY },
];
const RISK_USD = 100;
const FUNDING_PER_8H = 0.0001; // 명목 대비, 항상 비용
const MMR = (instId) => (instId.startsWith("BTC-") ? 0.004 : instId.startsWith("ETH-") ? 0.005 : 0.01);
const LOCAL_SYMS = new Set(["BTC", "DOGE"]);

/* ---------- 거래 준비 ---------- */

function prepTrade(t) {
  const dir = t.side === "long" ? 1 : -1;
  const move = (t.exitPx - t.entryPx) / t.entryPx * dir;
  let margin = null;
  let notional = null;
  if (t.pnlRatioPct !== null && t.pnlRatioPct !== undefined && t.pnlRatioPct !== 0 && t.lever) {
    margin = t.pnlUsd / (t.pnlRatioPct / 100);
    notional = margin * t.lever;
  } else if (Math.abs(move) > 1e-6 && t.pnlGrossUsd !== null && t.pnlGrossUsd !== undefined) {
    notional = t.pnlGrossUsd / move;
  }
  if (notional === null || !(notional > 0)) return null;
  const feeRate = t.feeUsd ? Math.abs(t.feeUsd) / notional : 0.001;
  const atrFrac = t.context?.atrPct != null ? t.context.atrPct / 100 : null;
  return {
    id: t.id,
    instId: t.instId,
    sym: t.instId.split("-")[0],
    side: t.side,
    dir,
    lever: t.lever ?? null,
    entryTs: t.entryTs,
    exitTs: t.exitTs,
    entryPx: t.entryPx,
    exitPx: t.exitPx,
    pnlUsd: t.pnlUsd ?? 0,
    liq: !!t.liq,
    margin,
    notional,
    feeRate,
    atrFrac,
    tf: t.tf,
    year: new Date(t.entryTs).getUTCFullYear(),
    intentGroup: t.intentGroup,
    mmr: MMR(t.instId),
  };
}

/* ---------- 경로 조립 ---------- */

const localCache = new Map();
function loadLocal(sym, bar) {
  const k = `${sym}|${bar}`;
  if (!localCache.has(k)) {
    const store = loadData(`candles-${sym}-${bar}.json`);
    localCache.set(k, store ? store.candles : null);
  }
  return localCache.get(k);
}
function lowerBound(arr, ts) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 보유 구간 경로 — 청크 캐시(거래 TF). pathStats 와 같은 봉 범위. */
function holdPath(chunkStore, p) {
  const tfDef = TF_LADDER.find((x) => x.bar === p.tf);
  if (!tfDef) return null;
  const start = Math.floor(p.entryTs / tfDef.ms) * tfDef.ms;
  const end = Math.floor(p.exitTs / tfDef.ms) * tfDef.ms;
  const win = getWindow(chunkStore, p.instId, tfDef, start, end);
  if (!win) return null;
  return { bars: win, tfMs: tfDef.ms };
}

/**
 * 실험 2 경로 — 진입 봉부터 진입+H 까지, 변형(이동·반전) 대조군과 같은 해상도로.
 * BTC·DOGE: 로컬 15m(진입 시점에 15m 저장분이 있으면) 아니면 1H. 그 외: 수집한 15m 청크.
 * 진입 봉은 봉 전체 고저를 쓴다(진입 전 가격 포함 → 손절 체결 과대, 보수적).
 */
function mechPath(chunkStore, p, horizonMs) {
  const endTs = p.entryTs + horizonMs;
  if (LOCAL_SYMS.has(p.sym)) {
    const m15 = loadLocal(p.sym, "15m");
    const useM15 = m15 && m15.length && m15[0].t <= p.entryTs;
    const arr = useM15 ? m15 : loadLocal(p.sym, "1H");
    const tfMs = useM15 ? 15 * 60_000 : HOUR;
    if (!arr || !arr.length) return null;
    const from = Math.floor(p.entryTs / tfMs) * tfMs;
    const bars = arr.slice(lowerBound(arr, from), lowerBound(arr, endTs + 1));
    if (!bars.length) return null;
    return { bars, tfMs, truncated: bars.at(-1).t + tfMs < endTs };
  }
  const tfDef = TF_LADDER.find((x) => x.bar === "15m");
  const from = Math.floor(p.entryTs / tfDef.ms) * tfDef.ms;
  const bars = getWindow(chunkStore, p.instId, tfDef, from, endTs);
  if (!bars) return null;
  return { bars, tfMs: tfDef.ms, truncated: bars.at(-1).t + tfDef.ms < endTs };
}

/** 대조군 변형 — 같은 거래 목록을 진입 +24h 이동(신호와 무관한 같은 시장) · 방향 반전. */
function variantOf(p, variant, chunkStore) {
  if (variant === "user") return p;
  if (variant === "mirror") return { ...p, side: p.side === "long" ? "short" : "long", dir: -p.dir };
  if (variant === "shift24h") {
    const entryTs = p.entryTs + DAY;
    const path = mechPath(chunkStore, { ...p, entryTs }, 0);
    const first = path?.bars.find((b) => b.t + path.tfMs > entryTs) ?? path?.bars.at(-1);
    if (!first) return null;
    return { ...p, entryTs, entryPx: first.o, exitTs: entryTs, exitPx: first.o };
  }
  return null;
}

/* ---------- 시뮬레이션 핵심 ---------- */

/**
 * 봉을 순서대로 걸으며 역행(손절·강제청산)·순행(목표) 수준이 닿는 첫 지점을 찾는다.
 * 같은 봉에서 둘 다 닿으면 역행 우선(보수). 갭이면 시가 체결.
 * 반환: { exitPx, exitTs, reason } — 미체결이면 null.
 */
function walk(bars, p, advFrac, favFrac, untilTs) {
  const advPx = advFrac !== null ? p.entryPx * (1 - p.dir * advFrac) : null;
  const favPx = favFrac !== null ? p.entryPx * (1 + p.dir * favFrac) : null;
  for (const b of bars) {
    if (untilTs !== null && b.t > untilTs) break;
    const advHit = advPx !== null && (p.dir === 1 ? b.l <= advPx : b.h >= advPx);
    if (advHit) {
      const gap = p.dir === 1 ? b.o <= advPx : b.o >= advPx;
      return { exitPx: gap ? b.o : advPx, exitTs: b.t, reason: "adv" };
    }
    const favHit = favPx !== null && (p.dir === 1 ? b.h >= favPx : b.l <= favPx);
    if (favHit) {
      const gap = p.dir === 1 ? b.o >= favPx : b.o <= favPx;
      return { exitPx: gap ? b.o : favPx, exitTs: b.t, reason: "fav" };
    }
  }
  return null;
}

function leverOf(p, L) {
  return L === "actual" ? p.lever : L;
}
/**
 * 합성 강제청산 거리. 실제 레버(L="actual")에는 적용하지 않는다 — 진단 결과 명목 레버 100배 포지션이
 * 증거금 대비 300%+ 역행을 견딘 사례가 다수(보유 중 증거금 추가 투입) → 명목 레버로는 실제 청산을
 * 재현할 수 없다. 실제 조합은 기록된 결과 그대로, L′ 조합은 "증거금 추가 없음" 가정의 순수 모델.
 */
function liqFracOf(p, lever, isActual = false) {
  if (!lever || isActual) return null;
  const f = 1 / lever - p.mmr;
  return f > 0 ? f : 1e-6;
}
function stopFracOf(p, stop) {
  if (stop === null) return null;
  if (stop.atr) return p.atrFrac !== null ? stop.atr * p.atrFrac : undefined; // undefined = 계산 불가
  return stop.pct / 100;
}

/** 실험 1 — 실제 청산 시각까지 오버레이. */
function overlay(path, p, lever, stopFrac, isActual) {
  const liqFrac = liqFracOf(p, lever, isActual);
  const cands = [liqFrac, stopFrac].filter((x) => x !== null && x !== undefined);
  const adv = cands.length ? Math.min(...cands) : null;
  const hit = adv !== null ? walk(path.bars, p, adv, null, null) : null;
  if (hit) {
    const isLiq = liqFrac !== null && adv === liqFrac && (stopFrac === null || stopFrac === undefined || liqFrac <= stopFrac);
    return { exitPx: hit.exitPx, exitTs: hit.exitTs, reason: isLiq ? "liq" : "stop", holdMs: Math.max(0, hit.exitTs - p.entryTs) };
  }
  return { exitPx: p.exitPx, exitTs: p.exitTs, reason: "actual", holdMs: p.exitTs - p.entryTs };
}

/** 실험 2 — 손절 S · 목표 k×S · 시한 H. */
function mechanical(path, p, lever, stopFrac, tpFrac, horizonMs) {
  const liqFrac = liqFracOf(p, lever);
  const adv = liqFrac !== null ? Math.min(liqFrac, stopFrac) : stopFrac;
  const untilTs = p.entryTs + horizonMs;
  const hit = walk(path.bars, p, adv, tpFrac, untilTs);
  if (hit) {
    const isLiq = liqFrac !== null && liqFrac < stopFrac && hit.reason === "adv";
    return { exitPx: hit.exitPx, exitTs: hit.exitTs, reason: hit.reason === "fav" ? "tp" : isLiq ? "liq" : "stop", holdMs: Math.max(0, hit.exitTs - p.entryTs) };
  }
  const inRange = path.bars.filter((b) => b.t <= untilTs);
  const last = inRange.at(-1);
  if (!last) return null;
  return { exitPx: last.c, exitTs: last.t, reason: "time", holdMs: Math.max(0, last.t - p.entryTs) };
}

/** 프레임별 손익. notionalNew 로 명목을 정하고, 강제청산은 증거금 전손. */
function pnlOf(p, res, lever, notionalNew, fundingOn) {
  if (!(notionalNew > 0)) return null;
  // eslint-disable-next-line no-param-reassign
  res.notionalNew = notionalNew;
  const marginNew = lever ? notionalNew / lever : null;
  const fee = notionalNew * p.feeRate;
  const funding = fundingOn ? notionalNew * FUNDING_PER_8H * (res.holdMs / (8 * HOUR)) : 0;
  if (res.reason === "liq") return -(marginNew ?? notionalNew) - funding;
  const move = (res.exitPx - p.entryPx) / p.entryPx * p.dir;
  return notionalNew * move - fee - funding;
}

/* ---------- 집계 ---------- */

function summarize(rows) {
  // rows: [{p, pnl, reason}]
  const n = rows.length;
  if (!n) return null;
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  const actual = rows.reduce((s, r) => s + r.p.pnlUsd, 0);
  // 규모 무관 기대값 — 거래당 명목 대비 수익률 평균(%). 프레임이 달라도 실제와 비교 가능.
  const retPct = (rows.reduce((s, r) => s + r.pnl / r.notionalNew, 0) / n) * 100;
  const actualRetPct = (rows.reduce((s, r) => s + r.p.pnlUsd / r.p.notional, 0) / n) * 100;
  const wins = rows.filter((r) => r.pnl > 0).length;
  const reasons = {};
  for (const r of rows) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  const sorted = rows.slice().sort((a, b) => a.exitTs - b.exitTs);
  let cum = 0;
  let peak = 0;
  let mdd = 0;
  for (const r of sorted) {
    cum += r.pnl;
    peak = Math.max(peak, cum);
    mdd = Math.min(mdd, cum - peak);
  }
  const byYear = {};
  for (const r of rows) {
    const y = byYear[r.p.year] ??= { n: 0, net: 0, actual: 0, ret: 0, actualRet: 0 };
    y.n += 1;
    y.net += r.pnl;
    y.actual += r.p.pnlUsd;
    y.ret += r.pnl / r.notionalNew;
    y.actualRet += r.p.pnlUsd / r.p.notional;
  }
  for (const y of Object.values(byYear)) {
    y.net = r2(y.net);
    y.actual = r2(y.actual);
    y.retPct = r2((y.ret / y.n) * 100);
    y.actualRetPct = r2((y.actualRet / y.n) * 100);
    delete y.ret;
    delete y.actualRet;
  }
  const byGroup = {};
  for (const r of rows) {
    const g = byGroup[r.p.intentGroup ?? "미상"] ??= { n: 0, net: 0, actual: 0 };
    g.n += 1;
    g.net += r.pnl;
    g.actual += r.p.pnlUsd;
  }
  for (const g of Object.values(byGroup)) {
    g.net = r2(g.net);
    g.actual = r2(g.actual);
  }
  const bySym = {};
  for (const r of rows) {
    const g = bySym[r.p.sym] ??= { n: 0, net: 0, actual: 0 };
    g.n += 1;
    g.net += r.pnl;
    g.actual += r.p.pnlUsd;
  }
  for (const g of Object.values(bySym)) {
    g.net = r2(g.net);
    g.actual = r2(g.actual);
  }
  // 사후 진단 — |손익| 상위 3% 제외
  const cut = Math.max(1, Math.floor(n * 0.03));
  const trimmed = rows.slice().sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(cut);
  const netTrim = trimmed.reduce((s, r) => s + r.pnl, 0);
  const actualTrim = trimmed.reduce((s, r) => s + r.p.pnlUsd, 0);
  return {
    n,
    net: r2(net),
    actual: r2(actual),
    delta: r2(net - actual),
    retPct: r2(retPct),
    actualRetPct: r2(actualRetPct),
    winRate: r1((wins / n) * 100),
    avg: r2(net / n),
    mdd: r2(mdd),
    reasons,
    byYear,
    byGroup,
    bySym,
    trim3: { net: r2(netTrim), actual: r2(actualTrim) },
  };
}

/* ---------- 실험 실행 ---------- */

function stopLabel(s) {
  return s === null ? "none" : s.atr ? `${s.atr}ATR` : `${s.pct}%`;
}
const STOPS1 = [...STOPS_PCT.map((pct) => (pct === null ? null : { pct })), ...STOPS_ATR.map((atr) => ({ atr }))];
const STOPS2 = [...EXP2_STOPS_PCT.map((pct) => ({ pct })), ...EXP2_STOPS_ATR.map((atr) => ({ atr }))];

function runExp1(trades, chunkStore) {
  const paths = new Map();
  for (const p of trades) {
    const path = holdPath(chunkStore, p);
    if (path) paths.set(p.id, path);
  }
  const out = { frames: { margin: {}, notional: {}, risk: {} }, stopDiag: {}, n: paths.size };
  for (const L of LEVERS) {
    for (const s of STOPS1) {
      const key = `L=${L}|S=${stopLabel(s)}`;
      const rowsM = [];
      const rowsN = [];
      const rowsR = [];
      let killed = 0;
      let saved = 0;
      for (const p of trades) {
        const path = paths.get(p.id);
        if (!path) continue;
        const lever = leverOf(p, L);
        const stopFrac = stopFracOf(p, s);
        if (stopFrac === undefined) continue;
        const isActual = L === "actual";
        const res = overlay(path, p, lever, stopFrac, isActual);
        const base = { p, reason: res.reason, exitTs: res.exitTs };
        if (p.margin !== null && lever) {
          const pnl = pnlOf(p, res, lever, p.margin * lever, false);
          if (pnl !== null) rowsM.push({ ...base, pnl, notionalNew: res.notionalNew });
        }
        {
          const pnl = pnlOf(p, res, lever, p.notional, false);
          if (pnl !== null) rowsN.push({ ...base, pnl, notionalNew: res.notionalNew });
        }
        {
          // 리스크 프레임의 위험 폭: 손절 S, 없으면 명목 청산 거리(1/L − mmr; 실제 레버도 명목값 사용)
          const riskFrac = stopFrac ?? (lever ? Math.max(1 / lever - p.mmr, 1e-6) : null);
          if (riskFrac) {
            const pnl = pnlOf(p, res, lever, RISK_USD / riskFrac, false);
            if (pnl !== null) rowsR.push({ ...base, pnl, notionalNew: res.notionalNew });
          }
        }
        if (res.reason === "stop") {
          if (p.pnlUsd > 0) killed += 1;
          else saved += 1;
        }
      }
      out.frames.margin[key] = summarize(rowsM);
      out.frames.notional[key] = summarize(rowsN);
      out.frames.risk[key] = summarize(rowsR);
      out.stopDiag[key] = { killedWinners: killed, savedLosers: saved };
    }
  }
  return out;
}

function runExp2(tradesIn, chunkStore, label, variant = "user") {
  const maxH = HORIZONS.at(-1).ms;
  const trades = tradesIn.map((p) => variantOf(p, variant, chunkStore)).filter(Boolean);
  const paths = new Map();
  let truncated = 0;
  for (const p of trades) {
    const path = mechPath(chunkStore, p, maxH);
    if (path) {
      paths.set(p.id, path);
      if (path.truncated) truncated += 1;
    }
  }
  const out = { label, variant, n: paths.size, truncated, frames: { notional: {}, risk: {}, margin10: {} } };
  for (const s of STOPS2) {
    for (const k of TP_K) {
      for (const H of HORIZONS) {
        const key = `S=${stopLabel(s)}|k=${k}|H=${H.key}`;
        const rowsN = [];
        const rowsR = [];
        const rowsM = [];
        for (const p of trades) {
          const path = paths.get(p.id);
          if (!path) continue;
          const stopFrac = stopFracOf(p, s);
          if (stopFrac === undefined || !(stopFrac > 0)) continue;
          // 레버리지는 손절이 강제청산보다 먼저 닿도록 넉넉히(10배; 명목 프레임은 청산 영향 없음)
          const res = mechanical(path, p, 10, stopFrac, stopFrac * k, H.ms);
          if (!res) continue;
          const base = { p, reason: res.reason, exitTs: res.exitTs };
          const pnlN = pnlOf(p, res, null, p.notional, true);
          if (pnlN !== null) rowsN.push({ ...base, pnl: pnlN, notionalNew: res.notionalNew });
          const pnlR = pnlOf(p, res, null, RISK_USD / stopFrac, true);
          if (pnlR !== null) rowsR.push({ ...base, pnl: pnlR, notionalNew: res.notionalNew });
          if (p.margin !== null) {
            const pnlM = pnlOf(p, res, 10, p.margin * 10, true);
            if (pnlM !== null) rowsM.push({ ...base, pnl: pnlM, notionalNew: res.notionalNew });
          }
        }
        out.frames.notional[key] = summarize(rowsN);
        out.frames.risk[key] = summarize(rowsR);
        out.frames.margin10[key] = summarize(rowsM);
      }
    }
  }
  return out;
}

/* ---------- 2단계 수집 — 나머지 종목 15m 청크 ---------- */

async function collectTails(trades, chunkStore) {
  const tf = TF_LADDER.find((x) => x.bar === "15m");
  const need = new Set();
  const maxH = HORIZONS.at(-1).ms;
  for (const p of trades) {
    if (LOCAL_SYMS.has(p.sym)) continue;
    const from = Math.floor(p.entryTs / tf.ms) * tf.ms;
    const to = Math.min(p.entryTs + maxH + DAY, Date.now()); // +1일: 진입 이동 대조군
    for (const s of chunkStarts(from, to, tf.ms)) {
      const k = chunkKey(p.instId, "15m", s);
      if (chunkStore.chunks[k] === undefined) need.add(`${p.instId}|${s}`);
    }
  }
  const list = [...need];
  console.log(`2단계 수집: 15m 청크 ${list.length}개 필요`);
  let done = 0;
  for (const item of list) {
    const [instId, s] = item.split("|");
    const bars = await fetchChunk(instId, "15m", tf.ms, Number(s));
    chunkStore.chunks[chunkKey(instId, "15m", Number(s))] = bars;
    done += 1;
    if (done % 50 === 0) {
      saveChunkStore(chunkStore);
      console.log(`  ${done}/${list.length}`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  saveChunkStore(chunkStore);
  return list.length;
}

/* ---------- 게이트 ---------- */

function gateCheck(exp1, exp2) {
  const passes = [];
  const wideOk = (key) => {
    const m = key.match(/S=([^|]+)/);
    const s = m[1];
    if (s === "none") return false;
    if (s.endsWith("ATR")) return parseFloat(s) >= 2;
    return parseFloat(s) >= 1;
  };
  const leverOk = (key) => {
    const m = key.match(/L=([^|]+)/);
    return m[1] !== "actual" && Number(m[1]) <= 20;
  };
  // 동일 명목: 순손익 $ 비교. 동일 리스크: 규모가 다르므로 거래당 명목 대비 수익률(retPct) 비교.
  const robust = (sum, frame) => {
    if (!sum) return false;
    const better = (o) => (frame === "risk" ? o.retPct > o.actualRetPct : o.net > o.actual);
    const years = ["2024", "2025", "2026"].filter((y) => sum.byYear[y]);
    return better(sum) && years.filter((y) => better(sum.byYear[y])).length >= 2;
  };
  const row = (exp, frame, key, sum) => ({
    exp, frame, key, net: sum.net, actual: sum.actual, delta: sum.delta, retPct: sum.retPct, actualRetPct: sum.actualRetPct,
    edge: frame === "risk" ? sum.retPct - sum.actualRetPct : sum.delta,
  });
  for (const frame of ["notional", "risk"]) {
    for (const [key, sum] of Object.entries(exp1.frames[frame])) {
      if (leverOk(key) && wideOk(key) && robust(sum, frame)) passes.push(row(1, frame, key, sum));
    }
  }
  for (const frame of ["notional", "risk"]) {
    for (const [key, sum] of Object.entries(exp2.frames[frame])) {
      if (wideOk(key) && robust(sum, frame)) passes.push(row(2, frame, key, sum));
    }
  }
  passes.sort((a, b) => b.edge - a.edge);
  return { pass: passes.length > 0, count: passes.length, top: passes.slice(0, 10) };
}

/* ---------- 메인 ---------- */

async function main() {
  const review = loadData("manual-review.json");
  if (!review) {
    console.error("manual-review.json 없음 — node re_sys/manual-analyze.mjs 먼저.");
    process.exit(1);
  }
  const chunkStore = loadChunkStore();
  const trades = review.trades.filter((t) => t.path && t.tf).map(prepTrade).filter(Boolean);
  console.log(`거래 ${review.trades.length}건 → 경로·명목 복원 ${trades.length}건 (증거금 복원 ${trades.filter((p) => p.margin !== null).length}건)`);

  const t0 = Date.now();
  const exp1 = runExp1(trades, chunkStore);
  console.log(`실험 1 완료 ${((Date.now() - t0) / 1000).toFixed(1)}s · 경로 ${exp1.n}건`);
  const base = exp1.frames.notional["L=actual|S=none"];
  console.log(`  자기일치: L=actual·S=none 명목 프레임 net $${base.net} vs 실제 $${base.actual} (Δ $${base.delta}) · 강제청산 재현 ${base.reasons.liq ?? 0}/${trades.filter((p) => p.liq).length}`);

  const local = trades.filter((p) => LOCAL_SYMS.has(p.sym));
  const t1 = Date.now();
  const exp2 = runExp2(local, chunkStore, "BTC·DOGE(로컬)");
  const exp2Shift = runExp2(local, chunkStore, "BTC·DOGE 대조: 진입 +24h", "shift24h");
  const exp2Mirror = runExp2(local, chunkStore, "BTC·DOGE 대조: 방향 반전", "mirror");
  console.log(`실험 2(BTC·DOGE) 완료 ${((Date.now() - t1) / 1000).toFixed(1)}s · 경로 ${exp2.n}건 · 연장 절단 ${exp2.truncated}건 · 대조 ${exp2Shift.n}/${exp2Mirror.n}`);

  const gate = gateCheck(exp1, exp2);
  console.log(`게이트: ${gate.pass ? "통과" : "미통과"} (조건 충족 조합 ${gate.count}개)`);
  for (const g of gate.top.slice(0, 5)) console.log(`  실험${g.exp} ${g.frame} ${g.key} net $${g.net} vs 실제 $${g.actual} · 거래당 ${g.retPct}% vs 실제 ${g.actualRetPct}%`);

  const result = {
    generatedAt: Date.now(),
    stage: STAGE,
    trades: trades.length,
    withMargin: trades.filter((p) => p.margin !== null).length,
    grid: { LEVERS, STOPS1: STOPS1.map(stopLabel), STOPS2: STOPS2.map(stopLabel), TP_K, HORIZONS: HORIZONS.map((h) => h.key), RISK_USD, FUNDING_PER_8H },
    exp1,
    exp2Local: exp2,
    exp2LocalShift: exp2Shift,
    exp2LocalMirror: exp2Mirror,
    gate,
  };

  if (STAGE === "B" && gate.pass) {
    const fetched = await collectTails(trades, chunkStore);
    const t2 = Date.now();
    const exp2All = runExp2(trades, chunkStore, "전 종목");
    const exp2AllShift = runExp2(trades, chunkStore, "전 종목 대조: 진입 +24h", "shift24h");
    const exp2AllMirror = runExp2(trades, chunkStore, "전 종목 대조: 방향 반전", "mirror");
    console.log(`실험 2(전 종목) 완료 ${((Date.now() - t2) / 1000).toFixed(1)}s · 경로 ${exp2All.n}건 · 연장 절단 ${exp2All.truncated}건 · 수집 청크 ${fetched}`);
    result.exp2All = exp2All;
    result.exp2AllShift = exp2AllShift;
    result.exp2AllMirror = exp2AllMirror;
    result.gateAll = gateCheck(exp1, exp2All);
  }
  saveData("counterfactual.json", result);
  console.log("저장 → re_sys/data/counterfactual.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
