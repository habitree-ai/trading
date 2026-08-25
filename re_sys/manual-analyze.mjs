/**
 * M2 — 본인 매매 복기 분석.
 *
 * 거래 기록에는 "왜 들어갔는지"가 없다(매매일지 setup·rationale 전부 공란).
 * 그래서 진입 시점의 차트 상태(확정 봉 기준 지표)로 진입 의도를 역으로 유추하고,
 * 보유 구간의 가격 경로(MFE/MAE)와 청산 방식으로 실패 원인을 분류한다.
 *
 * 유추는 유추다 — 각 판정에 근거 수치를 함께 저장해 리포트에서 검증 가능하게 한다.
 * 지표 계산은 봇과 같은 indicators.mjs 를 쓴다(같은 수식·같은 값).
 */
import { atr, rsi, sma } from "../system-trading/bot/indicators.mjs";
// sma 는 진입 컨텍스트와 1D 국면(SMA200) 계산 양쪽에 쓴다.
import { loadData, saveData, saveDataText, toCsv } from "./lib/data.mjs";
import { getWindow, loadChunkStore, pickTf, windowRange } from "./lib/windows.mjs";

const r1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 100) / 100);
const r4 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10000) / 10000);
const KST = 9 * 3_600_000;

/* ---------- 진입 시점 차트 컨텍스트 ---------- */

function buildContext(candles, tfMs, entryTs) {
  // 진입 시점에 이미 마감된 봉만 — 미확정 봉으로 판단했다면 그것도 문제지만, 유추는 보수적으로.
  const closed = candles.filter((c) => c.t + tfMs <= entryTs);
  const n = closed.length;
  if (n < 25) return null;
  const closes = closed.map((c) => c.c);
  const rsiArr = rsi(closes);
  const atrArr = atr(closed);
  const sma20Arr = sma(closes, 20);
  const sma50Arr = sma(closes, 50);
  const i = n - 1;
  const close = closes[i];
  const hh20 = Math.max(...closed.slice(Math.max(0, i - 20), i).map((c) => c.h));
  const ll20 = Math.min(...closed.slice(Math.max(0, i - 20), i).map((c) => c.l));
  const win60 = closed.slice(Math.max(0, i - 60), i + 1);
  const hi60 = Math.max(...win60.map((c) => c.h));
  const lo60 = Math.min(...win60.map((c) => c.l));
  let streak = 0; // 직전 연속 같은 방향 마감 (양수=연속 양봉)
  for (let k = i; k > 0; k -= 1) {
    const up = closed[k].c >= closed[k].o;
    if (k === i) streak = up ? 1 : -1;
    else if (up === streak > 0) streak += Math.sign(streak);
    else break;
  }
  const sma20 = sma20Arr[i];
  const sma50 = sma50Arr[i];
  const slope5 = sma20 !== null && sma20Arr[i - 5] != null ? ((sma20 - sma20Arr[i - 5]) / sma20Arr[i - 5]) * 100 : null;
  return {
    bars: n,
    close,
    rsi: r1(rsiArr[i]),
    atr: atrArr[i],
    atrPct: atrArr[i] !== null ? r2((atrArr[i] / close) * 100) : null,
    sma20: sma20,
    sma50: sma50,
    sma20SlopePct: r4(slope5),
    hh20,
    ll20,
    posInRange60: hi60 > lo60 ? r2(((close - lo60) / (hi60 - lo60)) * 100) : null,
    streak,
    trend: sma20 !== null && sma50 !== null ? (sma20 > sma50 ? "up" : "down") : slope5 !== null ? (slope5 > 0 ? "up" : "down") : null,
  };
}

/* ---------- 진입 의도 유추 ---------- */

function inferIntent(t, cx) {
  if (!cx || cx.atr === null) return { intent: "판정 불가(워밍업 부족)", group: "모호", basis: "지표 워밍업 부족" };
  const near = 0.5 * cx.atr;
  const L = t.side === "long";
  const b = [];
  const at = (v) => r4(v);

  if (L && cx.close >= cx.hh20 - near) {
    b.push(`종가 ${at(cx.close)} ≈ 직전 20봉 고점 ${at(cx.hh20)} (0.5×ATR 이내)`);
    return { intent: "고점 돌파 추격 롱", group: "추격", basis: b.join(" · ") };
  }
  if (!L && cx.close <= cx.ll20 + near) {
    b.push(`종가 ${at(cx.close)} ≈ 직전 20봉 저점 ${at(cx.ll20)} (0.5×ATR 이내)`);
    return { intent: "저점 이탈 추격 숏", group: "추격", basis: b.join(" · ") };
  }
  if (L && (cx.close <= cx.ll20 + near || cx.rsi !== null && cx.rsi < 35 || cx.streak <= -3)) {
    if (cx.close <= cx.ll20 + near) b.push(`종가가 20봉 저점권(${at(cx.ll20)})`);
    if (cx.rsi !== null && cx.rsi < 35) b.push(`RSI ${cx.rsi} < 35`);
    if (cx.streak <= -3) b.push(`연속 음봉 ${-cx.streak}개`);
    return { intent: "급락 저점매수 롱", group: "역추세", basis: b.join(" · ") };
  }
  if (!L && (cx.close >= cx.hh20 - near || cx.rsi !== null && cx.rsi > 65 || cx.streak >= 3)) {
    if (cx.close >= cx.hh20 - near) b.push(`종가가 20봉 고점권(${at(cx.hh20)})`);
    if (cx.rsi !== null && cx.rsi > 65) b.push(`RSI ${cx.rsi} > 65`);
    if (cx.streak >= 3) b.push(`연속 양봉 ${cx.streak}개`);
    return { intent: "급등 반락 노림 숏", group: "역추세", basis: b.join(" · ") };
  }
  if (L && cx.trend === "up") {
    b.push(`SMA20>SMA50 상승 추세 · RSI ${cx.rsi}`);
    return { intent: "상승추세 눌림목 롱", group: "추세순응", basis: b.join(" · ") };
  }
  if (!L && cx.trend === "down") {
    b.push(`SMA20<SMA50 하락 추세 · RSI ${cx.rsi}`);
    return { intent: "하락추세 되돌림 숏", group: "추세순응", basis: b.join(" · ") };
  }
  if (L && cx.trend === "down") {
    b.push(`하락 추세(SMA20<SMA50)에서 롱 · RSI ${cx.rsi}`);
    return { intent: "하락추세 역행 롱", group: "역추세", basis: b.join(" · ") };
  }
  if (!L && cx.trend === "up") {
    b.push(`상승 추세(SMA20>SMA50)에서 숏 · RSI ${cx.rsi}`);
    return { intent: "상승추세 역행 숏", group: "역추세", basis: b.join(" · ") };
  }
  return { intent: "레인지 중립 진입", group: "모호", basis: `추세 중립 · RSI ${cx.rsi}` };
}

/* ---------- 보유 구간 경로 — MFE/MAE ---------- */

function pathStats(t, candles, tfMs) {
  const start = Math.floor(t.entryTs / tfMs) * tfMs;
  const end = Math.floor(t.exitTs / tfMs) * tfMs;
  const bars = candles.filter((c) => c.t >= start && c.t <= end);
  if (!bars.length || !t.entryPx) return null;
  const dir = t.side === "long" ? 1 : -1;
  let mfe = 0;
  let mae = 0;
  for (const b of bars) {
    const fav = dir === 1 ? (b.h - t.entryPx) / t.entryPx : (t.entryPx - b.l) / t.entryPx;
    const adv = dir === 1 ? (t.entryPx - b.l) / t.entryPx : (b.h - t.entryPx) / t.entryPx;
    mfe = Math.max(mfe, fav * 100);
    mae = Math.max(mae, adv * 100);
  }
  const lever = t.lever ?? 1;
  return {
    holdBars: bars.length,
    mfePct: r4(mfe),
    maePct: r4(mae),
    mfeMarginPct: r1(mfe * lever),
    maeMarginPct: r1(mae * lever),
  };
}

/* ---------- 실패 원인 분류 ---------- */

function classifyFailure(t, cx, intent, path) {
  if (t.pnlUsd === null || t.pnlUsd >= 0) return null;
  const reasons = [];
  if (t.liq) reasons.push({ key: "liq", label: "강제청산(레버리지 과다)", basis: `레버 ${t.lever}배 · 증거금 전손(청산 유형 ${t.closeType})` });
  if (path && path.mfeMarginPct !== null && path.mfeMarginPct >= 30) {
    reasons.push({ key: "gaveback", label: "이익 반납(청산 실패)", basis: `보유 중 증거금 대비 최대 +${path.mfeMarginPct}% 이익 구간이 있었으나 손실 마감` });
  }
  if (intent.group === "역추세") {
    reasons.push({ key: "counter", label: "역추세 진입 → 추세 지속", basis: `${intent.intent} — ${intent.basis}` });
  }
  if (intent.group === "추격" && path && path.maePct !== null) {
    reasons.push({ key: "chase", label: "돌파 추격 → 되돌림", basis: `진입 직후 반대 방향 ${r2(path.maePct)}% 이동` });
  }
  if (!t.stopPx && path && path.maeMarginPct !== null && path.maeMarginPct >= 50 && !t.liq) {
    reasons.push({ key: "nostop", label: "손절 부재 — 손실 방치", basis: `증거금 대비 최대 역행 −${path.maeMarginPct}% 를 견딤(설정된 손절가 없음)` });
  }
  if (!reasons.length) reasons.push({ key: "wrongway", label: "방향 오판(단순 역행)", basis: "진입 직후 우위 없이 반대 방향 진행" });
  return reasons;
}

/* ---------- 메인 ---------- */

/** 1D 종가 vs SMA200 국면 — 종목별. 데이터 없으면 null 을 돌려준다. */
function makeRegimeAt(sym) {
  const store = loadData(`candles-${sym}-1D.json`) ?? (sym === "BTC" ? loadData("candles-1D.json") : null);
  if (!store) return () => null;
  const d1 = store.candles;
  const closes = d1.map((c) => c.c);
  const s200 = sma(closes, 200);
  return (ts) => {
    let lo = 0;
    let hi = d1.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (d1[mid].t <= ts) lo = mid;
      else hi = mid - 1;
    }
    if (d1[lo].t > ts || s200[lo] === null) return null;
    return closes[lo] > s200[lo] ? "상승장(1D>SMA200)" : "하락장(1D<SMA200)";
  };
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const sessionOf = (h) => (h < 9 ? "00–09시(미국장)" : h < 18 ? "09–18시(아시아장)" : "18–24시(유럽·미국장)");
const rsiBucket = (r) => (r === null || r === undefined ? null : r < 30 ? "RSI<30" : r < 45 ? "RSI 30–45" : r < 55 ? "RSI 45–55" : r < 70 ? "RSI 55–70" : "RSI≥70");
const atrBucket = (a) => (a === null || a === undefined ? null : a < 0.4 ? "저변동(<0.4%)" : a < 0.8 ? "중변동(0.4–0.8%)" : "고변동(≥0.8%)");
const intervalBucket = (m) => (m === null || m < 0 ? "첫 거래" : m <= 5 ? "직전 청산 ≤5분" : m <= 30 ? "5–30분" : m <= 360 ? "30분–6시간" : ">6시간");

function main() {
  const store = loadData("manual-trades.json");
  if (!store) {
    console.error("수집분 없음 — node re_sys/manual-fetch.mjs 를 먼저 실행하라.");
    process.exit(1);
  }
  const chunkStore = loadChunkStore();
  const trades = store.trades.filter((t) => t.exitTs !== null);
  const regimeAtOf = {};

  // 행동 태그에 필요한 시간 순 이웃 정보.
  trades.sort((a, b) => a.entryTs - b.entryTs);
  const enriched = [];
  for (let k = 0; k < trades.length; k += 1) {
    const t = trades[k];
    const tfDef = pickTf(t.exitTs - t.entryTs);
    const { from, to } = windowRange(t, tfDef);
    const win = getWindow(chunkStore, t.instId, tfDef, from, to);
    const cx = win ? buildContext(win, tfDef.ms, t.entryTs) : null;
    const intent = inferIntent(t, cx);
    const path = win ? pathStats(t, win, tfDef.ms) : null;

    const kstDate = new Date(t.entryTs + KST);
    const day = kstDate.toISOString().slice(0, 10);
    const prev = enriched.filter((p) => p.instId === t.instId).at(-1);
    const sinceprevMin = prev ? Math.round((t.entryTs - prev.exitTs) / 60_000) : null;

    const tags = [];
    if (t.liq) tags.push("강제청산");
    if (prev && prev.pnlUsd < 0 && sinceprevMin !== null && sinceprevMin >= 0 && sinceprevMin <= 30) tags.push("손실 직후 재진입(≤30분)");
    if (prev && prev.pnlUsd < 0 && t.lever > prev.lever) tags.push("손실 후 레버리지 증가");
    if (prev && prev.side !== t.side && sinceprevMin !== null && sinceprevMin >= 0 && sinceprevMin <= 10) tags.push("방향 뒤집기(≤10분)");
    if (path && path.mfeMarginPct >= 30 && t.pnlUsd < 0) tags.push("이익 반납");
    if (!t.stopPx && path && path.maeMarginPct >= 50 && !t.liq) tags.push("무손절 버티기");

    const failure = classifyFailure(t, cx, intent, path);
    const sym = t.instId.split("-")[0];
    regimeAtOf[sym] ??= makeRegimeAt(sym);
    const dir = t.side === "long" ? 1 : -1;
    const finalMarginPct =
      t.pnlRatioPct ?? (t.entryPx && t.exitPx !== null ? r1(((t.exitPx - t.entryPx) / t.entryPx) * dir * (t.lever ?? 1) * 100) : null);
    // 직전 연속 손실 수 — 종목 무관, 시간 순. "몇 연패 뒤의 진입이었나".
    let consecLossBefore = 0;
    for (let j = enriched.length - 1; j >= 0; j -= 1) {
      if (enriched[j].pnlUsd < 0) consecLossBefore += 1;
      else break;
    }
    enriched.push({
      ...t,
      tf: win ? tfDef.bar : null,
      day,
      hourKst: kstDate.getUTCHours(),
      weekdayKst: kstDate.getUTCDay(),
      session: sessionOf(kstDate.getUTCHours()),
      regime: regimeAtOf[sym](t.entryTs),
      trendAlign: cx?.trend ? ((cx.trend === "up") === (t.side === "long") ? "추세 순방향" : "추세 역방향") : "판정 불가",
      finalMarginPct,
      consecLossBefore,
      holdMin: Math.round((t.exitTs - t.entryTs) / 60_000),
      sinceprevMin,
      context: cx && {
        rsi: cx.rsi, atrPct: cx.atrPct, trend: cx.trend, streak: cx.streak,
        posInRange60: cx.posInRange60, sma20: r4(cx.sma20), sma50: r4(cx.sma50),
        hh20: r4(cx.hh20), ll20: r4(cx.ll20), bars: cx.bars,
      },
      intent: intent.intent,
      intentGroup: intent.group,
      intentBasis: intent.basis,
      path,
      tags,
      failure,
      win: t.pnlUsd !== null && t.pnlUsd > 0,
    });
  }

  // 과잉거래(그날 몇 번째 거래인지) — 하루 안에서 순번.
  const byDayCount = {};
  for (const t of enriched) {
    byDayCount[t.day] = (byDayCount[t.day] ?? 0) + 1;
    t.nthOfDay = byDayCount[t.day];
  }
  for (const t of enriched) if (byDayCount[t.day] > 5) t.tags.push(`과잉거래일(하루 ${byDayCount[t.day]}건)`);

  /* ---------- 집계 ---------- */
  const agg = (rows, keyFn) => {
    const m = new Map();
    for (const t of rows) {
      const k = keyFn(t);
      if (k === null || k === undefined) continue;
      const s = m.get(k) ?? { key: k, n: 0, wins: 0, pnl: 0 };
      s.n += 1;
      if (t.win) s.wins += 1;
      s.pnl += t.pnlUsd ?? 0;
      m.set(k, s);
    }
    return [...m.values()].map((s) => ({ ...s, winRate: r1((s.wins / s.n) * 100), pnl: r2(s.pnl) }));
  };
  const leverBucket = (t) => (t.lever === null ? null : t.lever <= 10 ? "≤10배" : t.lever <= 20 ? "20배" : t.lever <= 50 ? "50배" : "100배");
  const holdBucket = (t) => (t.holdMin < 5 ? "<5분" : t.holdMin < 30 ? "5–30분" : t.holdMin < 120 ? "30분–2시간" : t.holdMin < 1440 ? "2–24시간" : "≥1일");

  const losses = enriched.filter((t) => !t.win);
  const winners = enriched.filter((t) => t.win);
  const failureAgg = new Map();
  for (const t of losses) {
    for (const f of t.failure ?? []) {
      const s = failureAgg.get(f.key) ?? { key: f.key, label: f.label, n: 0, lost: 0, tradeIds: [] };
      s.n += 1;
      s.lost += t.pnlUsd ?? 0;
      s.tradeIds.push(t.id);
      failureAgg.set(f.key, s);
    }
  }
  const tagAgg = new Map();
  for (const t of enriched) {
    for (const tag of t.tags) {
      const s = tagAgg.get(tag) ?? { tag, n: 0, pnl: 0, wins: 0 };
      s.n += 1;
      s.pnl += t.pnlUsd ?? 0;
      if (t.win) s.wins += 1;
      tagAgg.set(tag, s);
    }
  }

  const reentryFast = enriched.filter((t) => t.tags.includes("손실 직후 재진입(≤30분)"));
  const rest = enriched.filter((t) => !t.tags.includes("손실 직후 재진입(≤30분)"));
  const avg = (rows, f) => (rows.length ? rows.reduce((s, t) => s + f(t), 0) / rows.length : null);

  // 계정 원장 요약 — 분기 아카이브(manual-bills.json)가 있으면 체결·비용·이체 흐름을 집계한다.
  // 포지션 단위 복기가 못 보여주는 것: 체결 강도(과잉거래의 원형), 수수료 총량, 입출금.
  let ledger = null;
  const billStore = loadData("manual-bills.json");
  if (billStore?.bills?.length) {
    const OPEN_SUB = new Set(["1", "3", "4"]);
    const CLOSE_SUB = new Set(["2", "5", "6", "100", "101", "104", "105"]);
    const n2 = (v) => Number(v || 0);
    const byDayMap = new Map();
    let fillCount = 0;
    let feeSum = 0;
    let pnlSum = 0;
    let fundIn = 0;
    let fundOut = 0;
    let liqCost = 0;
    let transferIn = 0;
    let transferOut = 0;
    // 금액 합산은 USDT 표기 청구서만 — 이체·현물 수수료는 코인 "개수"로 적혀 있어
    // (SATS 이체 수조 단위 등) 그대로 더하면 합계가 통째로 오염된다.
    const usdt = (b) => b.ccy === "USDT";
    for (const b of billStore.bills) {
      const st = String(b.subType);
      const day = new Date(Number(b.ts) + KST).toISOString().slice(0, 10);
      if (OPEN_SUB.has(st) || CLOSE_SUB.has(st)) {
        fillCount += 1;
        if (usdt(b)) {
          feeSum += n2(b.fee);
          pnlSum += n2(b.pnl);
          const d = byDayMap.get(day) ?? { day, fills: 0, feeUsd: 0, pnlUsd: 0 };
          d.fills += 1;
          d.feeUsd += n2(b.fee);
          d.pnlUsd += n2(b.pnl) + n2(b.fee);
          byDayMap.set(day, d);
        }
      } else if (st === "173" && usdt(b)) fundOut += n2(b.balChg);
      else if (st === "174" && usdt(b)) fundIn += n2(b.balChg);
      else if ((st === "108" || st === "109") && usdt(b)) liqCost += n2(b.balChg);
      else if (st === "11" && usdt(b)) transferIn += n2(b.balChg);
      else if (st === "12" && usdt(b)) transferOut += n2(b.balChg);
    }
    ledger = {
      bills: billStore.bills.length,
      quarters: Object.fromEntries(
        Object.entries(billStore.accounts ?? {}).flatMap(([acct, a]) =>
          Object.entries(a.quarters ?? {}).map(([k, v]) => [`${acct} ${k}`, v.state === "done" ? v.rows : v.state])),
      ),
      fills: fillCount,
      feeUsd: r2(feeSum),
      closePnlUsd: r2(pnlSum),
      fundingExpenseUsd: r2(fundOut),
      fundingIncomeUsd: r2(fundIn),
      liqRelatedUsd: r2(liqCost),
      transferInUsd: r2(transferIn),
      transferOutUsd: r2(transferOut),
      byDay: [...byDayMap.values()].map((d) => ({ ...d, feeUsd: r2(d.feeUsd), pnlUsd: r2(d.pnlUsd) })).sort((a, b) => a.day.localeCompare(b.day)),
    };
  }

  let cum = 0;
  const curve = enriched
    .slice()
    .sort((a, b) => a.exitTs - b.exitTs)
    .map((t) => ({ ts: t.exitTs, pnl: r2(t.pnlUsd ?? 0), cum: r2((cum += t.pnlUsd ?? 0)) }));

  const review = {
    generatedAt: Date.now(),
    totals: {
      trades: enriched.length,
      wins: winners.length,
      winRate: r1((winners.length / enriched.length) * 100),
      pnlUsd: r2(enriched.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)),
      grossWinUsd: r2(winners.reduce((s, t) => s + t.pnlUsd, 0)),
      grossLossUsd: r2(losses.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)),
      feeUsd: r2(enriched.reduce((s, t) => s + Math.abs(t.feeUsd ?? 0), 0)),
      fundingUsd: r2(enriched.reduce((s, t) => s + (t.fundingUsd ?? 0), 0)),
      // 이익 포착률 — 수익 거래가 보유 중 최대 이익(MFE)의 몇 %를 실제로 가져갔나.
      mfeCapturePct: r1(
        (() => {
          const ws = winners.filter((t) => t.path && t.path.mfeMarginPct > 0 && t.finalMarginPct !== null);
          return ws.length ? (ws.reduce((s, t) => s + Math.min(t.finalMarginPct / t.path.mfeMarginPct, 1.5), 0) / ws.length) * 100 : null;
        })(),
      ),
      lossDespiteMfe30: losses.filter((t) => t.path && t.path.mfeMarginPct >= 30).length,
      liqCount: enriched.filter((t) => t.liq).length,
      worst: r2(Math.min(...enriched.map((t) => t.pnlUsd ?? 0))),
      avgHoldMinWin: r1(avg(winners, (t) => t.holdMin)),
      avgHoldMinLoss: r1(avg(losses, (t) => t.holdMin)),
      days: Object.keys(byDayCount).length,
      maxPerDay: Math.max(...Object.values(byDayCount)),
    },
    aggregates: {
      byIntent: agg(enriched, (t) => t.intent),
      byIntentGroup: agg(enriched, (t) => t.intentGroup),
      byLever: agg(enriched, leverBucket),
      byHold: agg(enriched, holdBucket),
      byHourKst: agg(enriched, (t) => t.hourKst),
      bySymbol: agg(enriched, (t) => t.instId.replace("-USDT-SWAP", "")),
      bySource: agg(enriched, (t) => t.sourceName),
      byNthOfDay: agg(enriched, (t) => (t.nthOfDay <= 2 ? "그날 1–2번째" : t.nthOfDay <= 5 ? "그날 3–5번째" : "그날 6번째+")),
      bySide: agg(enriched, (t) => (t.side === "long" ? "롱" : "숏")),
      byWeekday: agg(enriched, (t) => WEEKDAYS[t.weekdayKst] + "요일"),
      bySession: agg(enriched, (t) => t.session),
      byRsi: agg(enriched, (t) => rsiBucket(t.context?.rsi)),
      byAtrVol: agg(enriched, (t) => atrBucket(t.context?.atrPct)),
      byTrendAlign: agg(enriched, (t) => t.trendAlign),
      byRegime: agg(enriched, (t) => t.regime ?? "판정 불가"),
      byInterval: agg(enriched, (t) => intervalBucket(t.sinceprevMin)),
      byConsecLoss: agg(enriched, (t) => (t.consecLossBefore === 0 ? "연패 0에서 진입" : t.consecLossBefore === 1 ? "1연패 뒤" : t.consecLossBefore === 2 ? "2연패 뒤" : "3연패 이상 뒤")),
      byDay: agg(enriched, (t) => t.day),
      reentry: {
        fast: { n: reentryFast.length, winRate: r1(avg(reentryFast, (t) => (t.win ? 100 : 0))), pnl: r2(reentryFast.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)) },
        rest: { n: rest.length, winRate: r1(avg(rest, (t) => (t.win ? 100 : 0))), pnl: r2(rest.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)) },
      },
      failureRanking: [...failureAgg.values()].map((s) => ({ ...s, lost: r2(s.lost) })).sort((a, b) => a.lost - b.lost),
      tagRanking: [...tagAgg.values()].map((s) => ({ ...s, pnl: r2(s.pnl) })).sort((a, b) => a.pnl - b.pnl),
    },
    curve,
    ledger,
    trades: enriched,
  };
  saveData("manual-review.json", review);

  const cols = ["id", "source", "instId", "side", "lever", "day", "hourKst", "holdMin", "entryPx", "exitPx", "pnlUsd", "intent", "intentGroup", "tags", "tf"];
  saveDataText("manual-review.csv", toCsv(enriched.map((t) => ({ ...t, tags: t.tags.join("|") })), cols));

  console.log(`거래 ${review.totals.trades}건 · 승률 ${review.totals.winRate}% · 순손익 $${review.totals.pnlUsd} · 강제청산 ${review.totals.liqCount}회`);
  for (const f of review.aggregates.failureRanking) console.log(`  실패: ${f.label} — ${f.n}건 · $${f.lost}`);
  console.log("저장 완료 → re_sys/data/manual-review.{json,csv}");
}

main();
