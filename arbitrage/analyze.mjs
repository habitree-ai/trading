/**
 * 분석 — 캐시를 읽어 프리미엄 통계와 전략 A~F 시뮬레이션, 판정표를 만든다.
 *
 * 판정 기준은 데이터를 보기 전에 계획서(§4)에 고정했다 — 아래 CRITERIA 가 그 사본이다.
 * 숫자를 보고 기준을 옮기면 조사가 아니라 합리화가 된다. 기준이 틀렸다고 생각되면
 * 기준을 바꾸는 대신 "이 기준으로는 X, 기준을 Y 로 하면 Z" 로 둘 다 적는다.
 *
 * 불변식(어기면 여기서 멈춘다): |P_coin| < 20% · |P_usdt| < 10% · |basis| < 2% · |D| < 2% ·
 * BTC·ETH 1m 조인 커버리지 ≥ 95% · 환율 일봉 결측 0.
 *
 * 사용: node --max-old-space-size=4096 arbitrage/analyze.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, OUT_DIR, ROOT, loadCache } from "./lib/cache.mjs";
import { downsample, joinAll, makeFfill } from "./lib/align.mjs";
import { annualizedBasis, ar1, basis, cycles, mean, premiumCoin, premiumUsd, quantile, runs, sd, summarize, tetherPremium } from "./lib/premium.mjs";

const DAY = 86_400_000;
const MIN = 60_000;
const r6 = (x) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : "-");

function need(name) {
  const v = loadCache(name);
  if (!v) throw new Error(`캐시 없음: ${name} — fetch 를 먼저 돌린다`);
  return v;
}

const fees = JSON.parse(readFileSync(join(ROOT, "fees.config.json"), "utf8"));
const FEE = Object.fromEntries(fees.items.map((i) => [i.key, i.value]));
const AS = fees.assumptions;
const uni = need("universe.json");
const CORE = uni.core;
const fx = need("fx-usdkrw-1d.json");
const fetchReport = loadCache("fetch-report.json", []);

/** 사전 등록 판정 기준 — 계획서 §4 사본. */
const CRITERIA = {
  A: { name: "전송형 김프", rule: "S>0 연속구간 중앙 지속시간 ≥ 전송시간 AND 월 순수익 ≥ 자본 1%", conditional: "월 순수익 > 0 이지만 1% 미만", cost: "OKX 현물 0.10 + 업비트 0.05 + KRW-USDT 0.05 + 슬리피지 + 출금비/규모 (+헤지 0.10)" },
  B: { name: "헤지형 김프", rule: "AR(1) 반감기 < 30일 AND E[ΔP]+펀딩 > 0.20% AND 표본 ≥ 30", conditional: "기대수익 > 0 이지만 반감기 ≥ 30일 또는 표본 < 30 → 보류", cost: "업비트 0.05×2 + 스왑 0.05×2 = 0.20%" },
  C: { name: "종목 간 상대 프리미엄", rule: "|R|>1% 사건의 3일 내 수렴률 > 70% AND 순기대값 > 0", conditional: "순기대값 > 0 이지만 수렴률 ≤ 70%", cost: "4다리 0.40%" },
  D: { name: "OKX 펀딩 캐리 / 만기 베이시스", rule: "연환산 순 ≥ 8% AND 양(+) 펀딩 비율 ≥ 65% → 기준선", conditional: "연환산 순 > 0 이지만 8% 미만", cost: "현물 0.10×2 + 스왑 0.05×2 = 0.30% (분기 1회 재진입 가정 → 연 1.2%)" },
  E: { name: "업비트 삼각", rule: "|D| > 손익분기 분 비율 > 1% AND 1천만원 실행 순익 > 0", conditional: "분 비율 > 1% 이지만 실행 순익 ≤ 0", cost: "0.05 + 0.25 + 0.05 = 0.35% + 스프레드" },
  F: { name: "테더 vs 코인 프리미엄 괴리(진단)", rule: "P_coin 일별 sd < 0.3% 이면 A·B 구조적 난망", conditional: "-", cost: "-" },
};

const REGULATION = [
  { item: "업비트 트래블룰 적용 기준", status: "확인", value: "원화 환산 100만원 이상 출금 시 적용. 출금 방법: 트래블룰 솔루션 연동 거래소 / 계정주 확인 연동 거래소 / 등록 개인지갑", source: "https://support.upbit.com/hc/ko/articles/4498679629337", asOf: "2026-08-20" },
  { item: "업비트 → OKX 출금 가능 여부", status: "확인", value: "OKX 는 '해외 · 계정주 확인' 목록에 포함(Binance, OKX, Gate, BitMEX, HTX, Backpack, Bybit, Bitget, Crypto.com). 동일 명의(영문명·생년월일) 확인 방식", source: "https://support.upbit.com/hc/ko/articles/5048002559897", asOf: "2026-06-30 목록 기준" },
  { item: "김프 환치기 형사 판례", status: "확인", value: "서울중앙지법 2024-02-06 수조원 규모 무죄(송금사무 위임·과태료 대상) → 대법원 2025-09-11 유죄 취지 파기환송: 특금법 미신고 가상자산사업 + 외국환거래법 미등록 외국환업무. 핵심은 영업성(타인 자금·수수료)", source: "https://www.lawtimes.co.kr/news/195854", asOf: "2025-09" },
  { item: "개인 자기자본 차익거래 처벌 사례", status: "미확인", value: "검색 범위에서 사례 없음. 코인 자체의 국외 전송이 외국환거래법상 '지급'에 해당하는지도 미확인 → 법률 자문 필요", source: null, asOf: null },
  { item: "OKX 국내 접속 차단 리스크", status: "미확인", value: "OKX 의 FIU 신고 여부·차단 대상 여부 미확인. 미신고 해외거래소 접속 차단 시 잔고 회수 경로가 필요", source: null, asOf: null },
  { item: "가상자산 과세", status: "확인(미확정)", value: "현행법 2027-01-01 시행, 기타소득 22%(지방세 포함), 연 250만원 공제. 정부 2026-07 '예정대로' 입장이나 폐지·유예 법안 계류", source: "https://www.bloter.net/news/articleView.html?idxno=669414", asOf: "2026-07" },
  { item: "업비트 첫 출금 지연", status: "미확인", value: "신규 원화 입금 후 72시간 / 첫 디지털자산 출금 24시간 지연제 — 현행 값 미확인. 전송형 첫 사이클 지연 요인", source: null, asOf: null },
];

const SOURCES = [
  { name: "업비트 공개 REST (캔들·호가·마켓)", url: "https://api.upbit.com/v1", note: "무인증. 시세 그룹별 IP당 10req/s. 1분봉 2019년까지 존재(실측). 체결 없는 분은 봉 없음" },
  { name: "OKX 공개 REST v5", url: "https://www.okx.com/api/v5", note: "IP당 20req/2s. 일봉은 1Dutc(UTC 경계). USDT 만기선물은 2026-06-26 폐지 → 코인마진 BTC-USD-분기 사용" },
  { name: "Frankfurter (ECB 기준환율)", url: "https://api.frankfurter.dev", note: "무키. 영업일만 → 주말·휴일 forward-fill 표시" },
  { name: "Binance 펀딩 이력 (3년 대리)", url: "https://fapi.binance.com/fapi/v1/fundingRate", note: "OKX 는 약 95일만 보존. 겹치는 구간 상관으로 대리 타당성 검증" },
  { name: "수수료 정본", url: "arbitrage/fees.config.json", note: "verified 플래그와 출처 URL, 미확인은 가정값" },
];

// ───────────────────────────── 데이터 적재 ─────────────────────────────
const fxMap = new Map(fx.map((r) => [r[0], r]));
const usdtDaily = need("upbit-KRW-USDT-1D.json");
const usdt1m = need("upbit-KRW-USDT-1m.json");
const usdt5m = downsample(usdt1m, MIN, 5);
const invariantErrors = [];
function check(cond, msg) {
  if (!cond) invariantErrors.push(msg);
}

/** 일봉 조인: 업비트 KRW-X 1D · OKX X-USDT 1Dutc · 환율 · KRW-USDT 1D → [t, pUsd, pCoin|null, upClose, okClose] */
function dailyPremium(sym, upbitMarket, okxSpot) {
  const up = loadCache(`upbit-${upbitMarket}-1D.json`);
  const ok = loadCache(`okx-${okxSpot}-1Dutc.json`);
  if (!up || !ok) return null;
  const usdtMap = new Map(usdtDaily.map((r) => [r[0], r]));
  const out = [];
  for (const [t, u, o] of joinAll([up, ok])) {
    const f = fxMap.get(t);
    if (!f) continue;
    const pUsd = premiumUsd(u[4], o[4], f[1]);
    const ud = usdtMap.get(t);
    const pCoin = ud ? premiumCoin(u[4], o[4], ud[4]) : null;
    out.push([t, pUsd, pCoin, f[2]]);
  }
  return out;
}

/** 분봉 조인: 업비트 KRW-X · OKX X-USDT · KRW-USDT (같은 봉) → [t, pCoin, upClose, okClose] + 커버리지 */
function minutePremium(c) {
  const tfMs = c.tier === "1m" ? MIN : 5 * MIN;
  const up = loadCache(`upbit-${c.upbit}-${c.tier}.json`);
  const ok = loadCache(`okx-${c.okxSpot}-${c.tier}.json`);
  if (!up || !ok) return null;
  const usdt = c.tier === "1m" ? usdt1m : usdt5m;
  const joined = joinAll([up, ok, usdt]);
  const rows = joined.map(([t, u, o, s]) => [t, premiumCoin(u[4], o[4], s[4]), u[4], o[4]]);
  const span = rows.length ? rows[rows.length - 1][0] - rows[0][0] : 0;
  const expected = span ? Math.floor(span / tfMs) + 1 : 0;
  return { tfMs, rows, coverage: expected ? rows.length / expected : 0, upBars: up.length, okBars: ok.length };
}

/** 펀딩을 UTC 일 단위로 합산 — 숏이 받는 부호 그대로. */
function fundingDaily(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const d = r.t - (r.t % DAY);
    m.set(d, (m.get(d) || 0) + r.rate);
  }
  return m;
}

// ───────────────────────────── 프리미엄 집계 ─────────────────────────────
console.log(`유니버스 ${uni.list.length}종 · 환율 ${fx.length}일 · KRW-USDT 1D ${usdtDaily.length}일 / 1m ${usdt1m.length.toLocaleString()}봉`);
const premium = { daily: {}, minuteChart: {}, statsDaily: {}, statsMinute: {}, coverage: {}, extremes: [] };
const extremes = premium.extremes;
const dailyBySym = {};
const minuteBySym = {};
for (const c of uni.list) {
  const d = dailyPremium(c.symbol, c.upbit, c.okxSpot);
  if (d && d.length) {
    dailyBySym[c.symbol] = d;
    premium.daily[c.symbol] = d.map(([t, a, b, f]) => [t, r6(a), b === null ? null : r6(b), f]);
    const pUsd = d.map((r) => r[1]);
    const pUsdNoFill = d.filter((r) => r[3] === 0).map((r) => r[1]);
    const pCoin = d.filter((r) => r[2] !== null).map((r) => r[2]);
    premium.statsDaily[c.symbol] = {
      days: d.length,
      from: new Date(d[0][0]).toISOString().slice(0, 10),
      pUsd: summarize(pUsd),
      pUsdEcbOnly: summarize(pUsdNoFill),
      pCoin: summarize(pCoin),
      pCoinDays: pCoin.length,
      ar1Usd: ar1(pUsd),
      ar1Coin: ar1(pCoin),
    };
    // 단일 일자의 극단(10·10 급락일 ETC 22.7%, JTO 2025-11-28 28%)은 실제 사건이다 — 비율로 판정하고 극단일은 남긴다.
    let extremeDays = 0;
    for (const [t, a] of d) {
      if (Math.abs(a) >= 0.1) extremes.push({ sym: c.symbol, t, pUsd: r6(a) });
      if (Math.abs(a) >= 0.2) extremeDays += 1;
    }
    check(extremeDays / d.length < 0.005, `|P_usd| ≥ 20% ${c.symbol} ${extremeDays}일 (${((extremeDays / d.length) * 100).toFixed(2)}%)`);
  }
  const m = minutePremium(c);
  if (m && m.rows.length) {
    minuteBySym[c.symbol] = m;
    const p = m.rows.map((r) => r[1]);
    const a = ar1(p);
    premium.statsMinute[c.symbol] = { tf: c.tier, bars: m.rows.length, coverage: r4(m.coverage), pCoin: summarize(p), ar1: a, halfLifeMin: a.halfLife ? r4((a.halfLife * m.tfMs) / MIN) : null };
    premium.coverage[c.symbol] = { tf: c.tier, joined: m.rows.length, upbit: m.upBars, okx: m.okBars, coverage: r4(m.coverage) };
    let bad = 0;
    for (const r of m.rows) if (Math.abs(r[1]) >= 0.2) bad += 1;
    // 얇은 알트의 단발 체결은 데이터 오류가 아니다 — 비율로 본다(0.5% 초과면 수집 문제).
    check(bad / m.rows.length < 0.005, `|P_coin| ≥ 20% ${c.symbol} ${bad}봉 (${((bad / m.rows.length) * 100).toFixed(2)}%)`);
    premium.coverage[c.symbol].outlierBars = bad;
    if (c.symbol === "BTC" || c.symbol === "ETH") check(m.coverage >= 0.95, `${c.symbol} 1m 조인 커버리지 ${(m.coverage * 100).toFixed(1)}% < 95%`);
    if (CORE.includes(c.symbol)) {
      // 차트용 15분 다운샘플(종가 = 마지막 봉의 프리미엄)
      const step = 15 * MIN;
      const ch = [];
      let cur = null;
      for (const r of m.rows) {
        const b = r[0] - (r[0] % step);
        if (!cur || cur[0] !== b) {
          if (cur) ch.push(cur);
          cur = [b, r[1]];
        } else cur[1] = r[1];
      }
      if (cur) ch.push(cur);
      premium.minuteChart[c.symbol] = ch.map(([t, p]) => [t, r6(p)]);
    }
  }
  process.stdout.write(`  ${c.symbol.padEnd(7)} 일봉 ${d ? d.length : 0}일 · 분봉 ${m ? m.rows.length.toLocaleString() : 0}봉 (커버 ${m ? (m.coverage * 100).toFixed(1) : "-"}%)\n`);
}

extremes.sort((a, b) => Math.abs(b.pUsd) - Math.abs(a.pUsd));
premium.extremes = extremes.slice(0, 20);

// 환율·테더
const usdtMapD = new Map(usdtDaily.map((r) => [r[0], r]));
const tether = [];
for (const [t, rate, src] of fx) {
  const u = usdtMapD.get(t);
  if (u) tether.push([t, tetherPremium(u[4], rate), src]);
}
for (const [t, p] of tether) check(Math.abs(p) < 0.1, `|P_usdt| ≥ 10% ${new Date(t).toISOString().slice(0, 10)} ${pct(p)}`);
const fxOut = {
  daily: fx.map(([t, v, s]) => [t, r4(v), s]),
  usdtkrwDaily: usdtDaily.map((r) => [r[0], r[4]]),
  tetherPremiumDaily: tether.map(([t, p, s]) => [t, r6(p), s]),
  stats: { usdkrw: summarize(fx.map((r) => r[1])), tether: summarize(tether.map((r) => r[1])), tetherEcbOnly: summarize(tether.filter((r) => r[2] === 0).map((r) => r[1])), ar1Tether: ar1(tether.map((r) => r[1])), filledDays: fx.filter((r) => r[2] === 1).length },
};

// ───────────────────────────── 전략 A — 전송형 ─────────────────────────────
function costA(sym, capitalKrw, priceKrw, { hedged = false, direction = "fwd" } = {}) {
  const wf = FEE[`upbit_withdraw_${sym}`] ?? AS.withdrawFee[sym];
  const coinFeePct = (wf * priceKrw) / capitalKrw; // 코인 출금비 / 명목
  const usdtFeePct = (AS.withdrawFee.USDT * 1400) / capitalKrw; // USDT 출금비(가정 1 USDT)
  const trade = (FEE.okx_spot_taker + FEE.upbit_krw_fee + FEE.upbit_krw_fee) / 100; // OKX 현물 + 업비트 코인 + 업비트 KRW-USDT
  const slip = (AS.slippageBps.okxSpot + AS.slippageBps.upbitKrw + AS.slippageBps.upbitKrw) / 1e4;
  const hedge = hedged ? (FEE.okx_swap_taker * 2) / 100 : 0;
  return { total: trade + slip + coinFeePct + usdtFeePct + hedge, trade, slip, coinFeePct, usdtFeePct, hedge, direction, withdrawFeeVerified: FEE[`upbit_withdraw_${sym}`] != null };
}

function strategyA() {
  const out = { perSymbol: {}, hourlyKst: null };
  for (const sym of CORE) {
    const m = minuteBySym[sym];
    if (!m) continue;
    const rows = m.rows;
    const tfMin = m.tfMs / MIN;
    const transferMin = AS.transferMinutes[sym];
    const transferBars = Math.max(1, Math.round(transferMin / tfMin));
    const lastPriceKrw = rows[rows.length - 1][2];
    const days = (rows[rows.length - 1][0] - rows[0][0]) / DAY;
    const byCapital = {};
    for (const cap of AS.capitalKrw) {
      const res = {};
      for (const dir of ["fwd", "rev"]) {
        const sign = dir === "fwd" ? 1 : -1; // fwd: 업비트가 비쌀 때(P>0) OKX→업비트 · rev: 역김프(P<0) 업비트→OKX
        const cU = costA(sym, cap, lastPriceKrw, { direction: dir });
        const cH = costA(sym, cap, lastPriceKrw, { hedged: true, direction: dir });
        const S = rows.map((r) => sign * r[1] - cU.total);
        const flags = S.map((s) => s > 0);
        const rl = runs(flags);
        const pctAbove = flags.filter(Boolean).length / flags.length;
        // 사이클: S>0 로 들어간 첫 봉 t0, 전송 후 t1 = t0 + transferBars 에서 실현. 그 뒤 되돌아오는 전송(USDT, 5분) 만큼 쿨다운.
        const cool = transferBars + Math.max(1, Math.round(5 / tfMin));
        const cyc = [];
        let i = 0;
        while (i + transferBars < rows.length) {
          if (S[i] > 0) {
            const t0 = rows[i];
            const t1 = rows[i + transferBars];
            const coinRet = sign * (t1[3] / t0[3] - 1); // 전송 중 코인 가격 변동(OKX 기준). fwd 는 롱 노출, rev 는 숏 노출
            const unhedged = sign * t1[1] - cU.total + coinRet;
            const hedged = sign * t1[1] - cH.total;
            cyc.push({ t: t0[0], entryP: t0[1], exitP: t1[1], unhedged, hedged, coinRet });
            i += transferBars + cool;
          } else i += 1;
        }
        const perMonth = days ? 30 / days : 0;
        const sumU = cyc.reduce((s, c) => s + c.unhedged, 0);
        const sumH = cyc.reduce((s, c) => s + c.hedged, 0);
        res[dir] = {
          cost: cU,
          costHedged: cH.total,
          pctBarsAbove: r4(pctAbove),
          runsCount: rl.length,
          runMedianMin: rl.length ? r4(quantile([...rl].sort((a, b) => a - b), 0.5) * tfMin) : null,
          runP90Min: rl.length ? r4(quantile([...rl].sort((a, b) => a - b), 0.9) * tfMin) : null,
          runsAtLeastTransfer: rl.filter((x) => x >= transferBars).length,
          cycles: cyc.length,
          cyclesPerMonth: r4(cyc.length * perMonth),
          unhedged: { sum: r6(sumU), monthly: r6(sumU * perMonth), mean: r6(cyc.length ? sumU / cyc.length : null), winRate: r4(cyc.length ? cyc.filter((c) => c.unhedged > 0).length / cyc.length : null), worst: r6(cyc.length ? Math.min(...cyc.map((c) => c.unhedged)) : null) },
          hedged: { sum: r6(sumH), monthly: r6(sumH * perMonth), mean: r6(cyc.length ? sumH / cyc.length : null), winRate: r4(cyc.length ? cyc.filter((c) => c.hedged > 0).length / cyc.length : null), worst: r6(cyc.length ? Math.min(...cyc.map((c) => c.hedged)) : null) },
          sampleCycles: cyc.slice(-8).map((c) => ({ ...c, entryP: r6(c.entryP), exitP: r6(c.exitP), unhedged: r6(c.unhedged), hedged: r6(c.hedged), coinRet: r6(c.coinRet) })),
        };
      }
      byCapital[cap] = res;
    }
    out.perSymbol[sym] = { tf: m.tfMs === MIN ? "1m" : "5m", transferMin, days: r4(days), bars: rows.length, lastPriceKrw, byCapital };
  }
  // BTC 1m 의 KST 시간대 프로파일
  const b = minuteBySym.BTC;
  if (b) {
    const buckets = Array.from({ length: 24 }, () => []);
    for (const r of b.rows) buckets[new Date(r[0] + 9 * 3600_000).getUTCHours()].push(r[1]);
    out.hourlyKst = buckets.map((xs, h) => ({ hour: h, n: xs.length, mean: r6(mean(xs)), sd: r6(sd(xs)), p90abs: r6(quantile(xs.map(Math.abs).sort((x, y) => x - y), 0.9)) }));
  }
  // 판정: 5천만원 · BTC 기준(헤지). 다른 종목은 표에서 보인다.
  const cap = AS.capitalKrw[1];
  const best = Object.entries(out.perSymbol)
    .map(([sym, v]) => ({ sym, ...v.byCapital[cap] }))
    .map((x) => ({ sym: x.sym, dir: x.fwd.hedged.monthly >= x.rev.hedged.monthly ? "fwd" : "rev", monthly: Math.max(x.fwd.hedged.monthly, x.rev.hedged.monthly), runOk: (x.fwd.runMedianMin ?? 0) >= out.perSymbol[x.sym].transferMin || (x.rev.runMedianMin ?? 0) >= out.perSymbol[x.sym].transferMin, cycles: x.fwd.cycles + x.rev.cycles }))
    .sort((a, b2) => b2.monthly - a.monthly);
  const top = best[0];
  let verdict = "불가";
  if (top && top.monthly >= 0.01 && top.runOk) verdict = "가능";
  else if (top && top.monthly > 0) verdict = "조건부";
  out.verdict = { verdict, basisCapital: cap, best: top, keyNumber: top ? `${top.sym} ${top.dir === "fwd" ? "정방향" : "역방향"} 헤지 월 ${pct(top.monthly)} · 사이클 ${top.cycles}회/90일` : "-" };
  return out;
}

// ───────────────────────────── 전략 B — 헤지형 ─────────────────────────────
function strategyB() {
  const cost = (FEE.upbit_krw_fee * 2 + FEE.okx_swap_taker * 2) / 100;
  const out = { cost, perSymbol: {} };
  for (const sym of CORE) {
    const d = dailyBySym[sym];
    if (!d) continue;
    const series = d.filter((r) => r[2] !== null);
    const p = series.map((r) => r[2]);
    const fdOkx = fundingDaily(loadCache(`okx-funding-${sym}.json`));
    const fdBn = fundingDaily(loadCache(`binance-funding-${sym}.json`));
    const fundingAt = (t) => (fdOkx.has(t) ? fdOkx.get(t) : fdBn.get(t) || 0);
    const sim = (idxFrom, idxTo, lo, mid, label) => {
      const xs = p.slice(idxFrom, idxTo);
      const cs = cycles(xs, { lo, mid, maxHold: 30 });
      const rowsC = cs.map((c) => {
        let fund = 0;
        for (let k = c.i; k < c.j; k += 1) fund += fundingAt(series[idxFrom + k][0]);
        const net = c.delta + fund - cost;
        return { t: series[idxFrom + c.i][0], hold: c.hold, entry: r6(c.entry), exit: r6(c.exit), delta: r6(c.delta), funding: r6(fund), net: r6(net), mae: r6(c.mae), exitReason: c.exitReason };
      });
      const nets = rowsC.map((c) => c.net);
      const tStat = nets.length > 2 && sd(nets) > 0 ? mean(nets) / (sd(nets) / Math.sqrt(nets.length)) : null;
      return { label, tStat: r4(tStat), days: xs.length, lo: r6(lo), mid: r6(mid), n: rowsC.length, meanNet: r6(mean(nets)), medianNet: r6(nets.length ? quantile([...nets].sort((a, b) => a - b), 0.5) : null), winRate: r4(nets.length ? nets.filter((x) => x > 0).length / nets.length : null), sumNet: r6(nets.reduce((a, b) => a + b, 0)), worstMae: r6(rowsC.length ? Math.min(...rowsC.map((c) => c.mae)) : null), targetRate: r4(rowsC.length ? rowsC.filter((c) => c.exitReason === "target").length / rowsC.length : null), cycles: rowsC.slice(-10) };
    };
    const sorted = [...p].sort((a, b) => a - b);
    const loIS = quantile(sorted, 0.2);
    const midIS = quantile(sorted, 0.5);
    const half = Math.floor(p.length / 2);
    const firstSorted = p.slice(0, half).sort((a, b) => a - b);
    const loWF = quantile(firstSorted, 0.2);
    const midWF = quantile(firstSorted, 0.5);
    const a = ar1(p);
    // 1분봉 변형(90일): 진입 p20 · 청산 p50 · 최대 1일 보유, 펀딩 무시
    let minuteVar = null;
    const m = minuteBySym[sym];
    if (m) {
      const mp = m.rows.map((r) => r[1]);
      const ms = [...mp].sort((x, y) => x - y);
      const cs = cycles(mp, { lo: quantile(ms, 0.2), mid: quantile(ms, 0.5), maxHold: Math.round(DAY / m.tfMs) });
      const nets = cs.map((c) => c.delta - cost);
      minuteVar = { n: cs.length, meanNet: r6(mean(nets)), winRate: r4(nets.length ? nets.filter((x) => x > 0).length / nets.length : null), sumNet: r6(nets.reduce((x, y) => x + y, 0)), medianHoldMin: cs.length ? r4(quantile(cs.map((c) => c.hold).sort((x, y) => x - y), 0.5) * (m.tfMs / MIN)) : null };
    }
    out.perSymbol[sym] = { days: p.length, from: new Date(series[0][0]).toISOString().slice(0, 10), ar1: a, halfLifeDays: a.halfLife === null ? null : r4(a.halfLife), inSample: sim(0, p.length, loIS, midIS, "전구간(임계 전구간 분위)"), walkForward: sim(half, p.length, loWF, midWF, "후반(임계 전반 분위)"), minuteVariant: minuteVar, fundingSource: fdOkx.size ? "OKX 95일 + Binance 대리" : "Binance 대리" };
  }
  const b = out.perSymbol.BTC;
  let verdict = "보류";
  if (b) {
    const wf = b.walkForward;
    const hlOk = b.halfLifeDays !== null && b.halfLifeDays < 30;
    if (wf.n >= 30 && hlOk && wf.meanNet > 0) verdict = "가능";
    else if (wf.n < 30) verdict = "보류";
    else if (wf.meanNet > 0) verdict = "조건부";
    else verdict = "불가";
  }
  out.verdict = { verdict, keyNumber: b ? `BTC 반감기 ${b.halfLifeDays === null ? "∞" : b.halfLifeDays.toFixed(1)}일 · 후반 검증 ${b.walkForward.n}사이클 평균 순 ${pct(b.walkForward.meanNet)} (전구간 ${b.inSample.n}사이클 ${pct(b.inSample.meanNet)}) · t=${b.walkForward.tStat ?? "-"}${b.walkForward.tStat !== null && Math.abs(b.walkForward.tStat) < 2 ? " — 0 과 통계적으로 구분되지 않음" : ""}` : "-" };
  return out;
}

// ───────────────────────────── 전략 C — 상대 프리미엄 ─────────────────────────────
function strategyC() {
  const cost = (FEE.upbit_krw_fee * 4 + FEE.okx_swap_taker * 4) / 100;
  const thr = 0.01;
  const H = 3;
  const btc = dailyBySym.BTC;
  const out = { cost, threshold: thr, horizonDays: H, perSymbol: {}, weekly: null };
  if (!btc) return out;
  const btcMap = new Map(btc.filter((r) => r[2] !== null).map((r) => [r[0], r[2]]));
  const weekMatrix = {};
  const dispersionByDay = new Map();
  let allEvents = [];
  for (const c of uni.list) {
    if (c.symbol === "BTC") continue;
    const d = dailyBySym[c.symbol];
    if (!d) continue;
    const R = [];
    for (const r of d) if (r[2] !== null && btcMap.has(r[0])) R.push([r[0], r[2] - btcMap.get(r[0])]);
    if (R.length < 60) continue;
    for (const [t, v] of R) {
      if (!dispersionByDay.has(t)) dispersionByDay.set(t, []);
      dispersionByDay.get(t).push(v);
    }
    const ev = [];
    let i = 0;
    while (i + H < R.length) {
      if (Math.abs(R[i][1]) > thr) {
        const a0 = Math.abs(R[i][1]);
        const a1 = Math.abs(R[i + H][1]);
        // 수렴 = |R| 가 비용 이상 줄었다. 순익 = 줄어든 폭 − 비용 (다시 벌어지면 음수)
        const net = a0 - a1 - cost;
        ev.push({ t: R[i][0], r0: r6(R[i][1]), r1: r6(R[i + H][1]), net: r6(net), converged: net > 0 });
        i += H;
      } else i += 1;
    }
    allEvents = allEvents.concat(ev.map((e) => ({ ...e, sym: c.symbol })));
    const vals = R.map((r) => r[1]);
    out.perSymbol[c.symbol] = { days: R.length, stats: summarize(vals), ar1: ar1(vals), events: ev.length, eventsPerMonth: r4((ev.length / R.length) * 30), convergeRate: r4(ev.length ? ev.filter((e) => e.converged).length / ev.length : null), meanNet: r6(mean(ev.map((e) => e.net))), recent: ev.slice(-5) };
    // 주간 평균(히트맵)
    const wk = new Map();
    for (const [t, v] of R) {
      const w = t - (t % (7 * DAY));
      if (!wk.has(w)) wk.set(w, []);
      wk.get(w).push(v);
    }
    weekMatrix[c.symbol] = [...wk.entries()].map(([w, xs]) => [w, r6(mean(xs))]);
  }
  out.weekly = weekMatrix;
  out.dispersion = [...dispersionByDay.entries()].sort((a, b) => a[0] - b[0]).map(([t, xs]) => [t, r6(sd(xs)), xs.length]);
  const rate = allEvents.length ? allEvents.filter((e) => e.converged).length / allEvents.length : null;
  const meanNet = mean(allEvents.map((e) => e.net));
  // 방향 분해 — R>0(업비트에서 알트가 BTC 대비 비쌈)은 업비트에서 그 알트를 팔아야 하므로 보유 재고가 필요하다.
  const side = (ev) => ({ events: ev.length, convergeRate: r4(ev.length ? ev.filter((e) => e.converged).length / ev.length : null), meanNet: r6(mean(ev.map((e) => e.net))) });
  const byDir = { up: side(allEvents.filter((e) => e.r0 > 0)), down: side(allEvents.filter((e) => e.r0 < 0)) };
  out.all = { events: allEvents.length, convergeRate: r4(rate), meanNet: r6(meanNet), symbols: Object.keys(out.perSymbol).length, byDir, top: allEvents.sort((a, b) => Math.abs(b.r0) - Math.abs(a.r0)).slice(0, 15) };
  let verdict = "보류";
  if (allEvents.length >= 30) {
    if (rate > 0.7 && meanNet > 0) verdict = "가능";
    else if (meanNet > 0) verdict = "조건부";
    else verdict = "불가";
  }
  out.verdict = { verdict, keyNumber: `|R|>1% 사건 ${allEvents.length}건(${out.all.symbols}종) · 3일 수렴률 ${rate === null ? "-" : `${(rate * 100).toFixed(0)}%`} · 평균 순 ${pct(meanNet)} — 그중 R>0(재고 필요) ${byDir.up.events}건 / R<0 ${byDir.down.events}건(순 ${pct(byDir.down.meanNet)})` };
  return out;
}

// ───────────────────────────── 전략 D — OKX 캐리·베이시스 ─────────────────────────────
function strategyD() {
  const cost = (FEE.okx_spot_taker * 2 + FEE.okx_swap_taker * 2) / 100;
  const annualCost = cost * 4;
  const out = { cost, annualCost, perSymbol: {}, futures: [] };
  for (const sym of CORE) {
    const okx = loadCache(`okx-funding-${sym}.json`) || [];
    const bn = loadCache(`binance-funding-${sym}.json`) || [];
    const okxMap = new Map(okx.map((r) => [r.t, r.rate]));
    const pairs = bn.filter((r) => okxMap.has(r.t)).map((r) => [okxMap.get(r.t), r.rate]);
    let corrOB = null;
    if (pairs.length > 30) {
      const a = pairs.map((p) => p[0]);
      const b = pairs.map((p) => p[1]);
      const ma = mean(a);
      const mb = mean(b);
      let sab = 0;
      let saa = 0;
      let sbb = 0;
      for (let i = 0; i < a.length; i += 1) {
        sab += (a[i] - ma) * (b[i] - mb);
        saa += (a[i] - ma) ** 2;
        sbb += (b[i] - mb) ** 2;
      }
      corrOB = saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
    }
    const perYear = 3 * 365;
    const stat = (rows) => {
      if (!rows.length) return null;
      const rates = rows.map((r) => r.rate);
      return { n: rows.length, from: new Date(rows[0].t).toISOString().slice(0, 10), to: new Date(rows[rows.length - 1].t).toISOString().slice(0, 10), annualized: r6(mean(rates) * perYear), positiveShare: r4(rates.filter((x) => x > 0).length / rates.length), meanRate: r6(mean(rates)), p10: r6(quantile([...rates].sort((a, b) => a - b), 0.1)), p90: r6(quantile([...rates].sort((a, b) => a - b), 0.9)) };
    };
    // 30일 롤링 연환산(일 단위)
    const fd = fundingDaily(bn);
    const days = [...fd.keys()].sort((a, b) => a - b);
    const rolling = [];
    for (let i = 29; i < days.length; i += 1) {
      let s = 0;
      for (let k = i - 29; k <= i; k += 1) s += fd.get(days[k]);
      rolling.push([days[i], r6((s / 30) * 365)]);
    }
    // 연도별
    const byYear = {};
    for (const r of bn) {
      const y = new Date(r.t).getUTCFullYear();
      if (!byYear[y]) byYear[y] = [];
      byYear[y].push(r.rate);
    }
    const yearly = Object.entries(byYear).map(([y, xs]) => ({ year: +y, n: xs.length, annualized: r6(mean(xs) * perYear), positiveShare: r4(xs.filter((x) => x > 0).length / xs.length) }));
    // 현물–스왑 베이시스(일봉)
    const spot = loadCache(`okx-${sym}-USDT-1Dutc.json`);
    const swap = loadCache(`okx-${sym}-USDT-SWAP-1Dutc.json`);
    let basisOut = null;
    if (spot && swap) {
      const j = joinAll([swap, spot]).map(([t, sw, sp]) => [t, basis(sw[4], sp[4])]);
      for (const [t, b] of j) check(Math.abs(b) < 0.02, `|basis| ≥ 2% ${sym} ${new Date(t).toISOString().slice(0, 10)} ${pct(b)}`);
      basisOut = { days: j.length, stats: summarize(j.map((r) => r[1])), series: sym === "BTC" ? j.map(([t, b]) => [t, r6(b)]) : undefined };
    }
    const bnStat = stat(bn);
    out.perSymbol[sym] = { okx: stat(okx), binance: bnStat, corrOkxBinance: r4(corrOB), overlap: pairs.length, rolling30d: sym === "BTC" ? rolling : rolling.slice(-120), yearly, basisDaily: basisOut, netAnnualized: bnStat ? r6(bnStat.annualized - annualCost) : null, netAnnualizedRecent: (() => { const s = stat(okx); return s ? r6(s.annualized - annualCost) : null; })() };
  }
  // 코인마진 만기선물 베이시스 — BTC-USD 지수 대비
  const idx = loadCache("okx-BTC-USD-1Dutc.json");
  const futs = loadCache("okx-futures-instruments.json") || [];
  if (idx) {
    const idxMap = new Map(idx.map((r) => [r[0], r[4]]));
    for (const f of futs) {
      const rows = loadCache(`okx-${f.instId}-1Dutc.json`);
      if (!rows || !rows.length) continue;
      const series = [];
      for (const r of rows) {
        const s = idxMap.get(r[0]);
        const dte = (f.expTime - r[0]) / DAY;
        if (s && dte > 3) series.push([r[0], r6(annualizedBasis(r[4], s, dte)), r6(r[4] / s - 1), r4(dte)]);
      }
      const ann = series.map((r) => r[1]);
      out.futures.push({ instId: f.instId, alias: f.alias, settleCcy: f.settleCcy, expiry: new Date(f.expTime).toISOString().slice(0, 10), days: series.length, annualized: summarize(ann), last: series[series.length - 1] || null, series: series.slice(-180) });
    }
  }
  const b = out.perSymbol.BTC;
  let verdict = "보류";
  if (b && b.binance) {
    if (b.netAnnualized >= 0.08 && b.binance.positiveShare >= 0.65) verdict = "가능";
    else if (b.netAnnualized > 0) verdict = "조건부";
    else verdict = "불가";
  }
  out.verdict = { verdict, keyNumber: b && b.binance ? `BTC 3년 펀딩 연환산 ${pct(b.binance.annualized)} (순 ${pct(b.netAnnualized)}) · 양(+) ${(b.binance.positiveShare * 100).toFixed(0)}% · 최근 95일 ${b.okx ? pct(b.okx.annualized) : "-"}` : "-" };
  return out;
}

// ───────────────────────────── 전략 E — 업비트 삼각 ─────────────────────────────
function strategyE() {
  const cost = (FEE.upbit_krw_fee + FEE.upbit_usdt_fee + FEE.upbit_krw_fee) / 100;
  const spread = (AS.slippageBps.upbitUsdtMarket + AS.slippageBps.upbitKrw * 2) / 1e4;
  const breakeven = cost + spread;
  const out = { cost, spreadAssumed: spread, breakeven, perSymbol: {} };
  for (const sym of ["BTC", "ETH", "XRP"]) {
    const krw = loadCache(`upbit-KRW-${sym}-1m.json`);
    const usdtM = loadCache(`upbit-USDT-${sym}-1m.json`);
    if (!krw || !usdtM) continue;
    const j = joinAll([krw, usdtM, usdt1m]).map(([t, k, u, s]) => [t, k[4] / (u[4] * s[4]) - 1]);
    const D = j.map((r) => r[1]);
    // USDT 마켓은 분당 체결이 4~10% 분에만 있을 만큼 얇다(fetch-report). |D|≥2% 는 단발 체결의 흔적이라 건수로 남기고, BTC 만 비율 0.5% 초과 시 중단.
    const outliers = D.filter((d) => Math.abs(d) >= 0.02).length;
    if (sym === "BTC") check(outliers / Math.max(1, D.length) < 0.005, `|D| ≥ 2% BTC ${outliers}봉 (${((outliers / D.length) * 100).toFixed(2)}%)`);
    const above = D.filter((d) => Math.abs(d) > breakeven).length;
    const rl = runs(D.map((d) => Math.abs(d) > breakeven));
    const expectedBars = j.length ? (j[j.length - 1][0] - j[0][0]) / MIN + 1 : 0;
    out.perSymbol[sym] = { outlierBars: outliers, bars: j.length, coverage: r4(expectedBars ? j.length / expectedBars : 0), stats: summarize(D), pctAboveBreakeven: r4(j.length ? above / j.length : null), runs: rl.length, runMedianMin: rl.length ? quantile([...rl].sort((a, b) => a - b), 0.5) : null, chart: sym === "BTC" ? downsampleSeries(j, 15 * MIN) : undefined };
  }
  const b = out.perSymbol.BTC;
  let verdict = "보류";
  if (b) verdict = b.pctAboveBreakeven > 0.01 ? "조건부" : "불가";
  out.verdict = { verdict, keyNumber: b ? `BTC 1m 손익분기(${pct(breakeven)}) 초과 분 비율 ${(b.pctAboveBreakeven * 100).toFixed(2)}% · |D| p50 ${pct(b.stats.p50)} p95 ${pct(b.stats.p95)}` : "-", note: "호가 로거 실행 괴리가 있으면 books.triangle 로 판정을 갱신한다 — 캔들만으로는 '조건부' 가 상한" };
  return out;
}

function downsampleSeries(rows, step) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    const b = r[0] - (r[0] % step);
    if (!cur || cur[0] !== b) {
      if (cur) out.push(cur);
      cur = [b, r[1]];
    } else cur[1] = r[1];
  }
  if (cur) out.push(cur);
  return out.map(([t, v]) => [t, r6(v)]);
}

// ───────────────────────────── 전략 F — 테더 vs 코인 ─────────────────────────────
function strategyF() {
  const d = dailyBySym.BTC;
  const out = {};
  if (!d) return out;
  const tetherMap = new Map(tether.map((r) => [r[0], r[1]]));
  const rows = d.filter((r) => r[2] !== null && tetherMap.has(r[0])).map((r) => [r[0], r[1], r[2], tetherMap.get(r[0]), r[3]]); // t, pUsd, pCoin, pUsdt, fxSrc
  const ecbOnly = rows.filter((r) => r[4] === 0);
  const pUsd = ecbOnly.map((r) => r[1]);
  const pCoin = ecbOnly.map((r) => r[2]);
  const pUsdt = ecbOnly.map((r) => r[3]);
  const cov = (a, b) => {
    const ma = mean(a);
    const mb = mean(b);
    let s = 0;
    for (let i = 0; i < a.length; i += 1) s += (a[i] - ma) * (b[i] - mb);
    return s / (a.length - 1);
  };
  const varUsd = cov(pUsd, pUsd);
  const shareTether = varUsd ? cov(pUsd, pUsdt) / varUsd : null; // 달러 김프 분산 중 테더 프리미엄이 설명하는 몫(회귀 β)
  const corrUC = sd(pUsdt) && sd(pCoin) ? cov(pUsdt, pCoin) / (sd(pUsdt) * sd(pCoin)) : null;
  // 큰 달러 김프 변동일 상위 10 — 그날 테더 프리미엄은 어땠나
  const moves = [];
  for (let i = 1; i < ecbOnly.length; i += 1) moves.push({ t: ecbOnly[i][0], dUsd: ecbOnly[i][1] - ecbOnly[i - 1][1], dUsdt: ecbOnly[i][3] - ecbOnly[i - 1][3], dCoin: ecbOnly[i][2] - ecbOnly[i - 1][2] });
  moves.sort((a, b) => Math.abs(b.dUsd) - Math.abs(a.dUsd));
  out.days = ecbOnly.length;
  out.stats = { pUsd: summarize(pUsd), pCoin: summarize(pCoin), pUsdt: summarize(pUsdt), ar1Coin: ar1(pCoin), ar1Usdt: ar1(pUsdt) };
  out.tetherShareOfUsdPremium = r4(shareTether);
  out.corrTetherCoin = r4(corrUC);
  out.topMoves = moves.slice(0, 10).map((m) => ({ t: m.t, dUsd: r6(m.dUsd), dUsdt: r6(m.dUsdt), dCoin: r6(m.dCoin) }));
  out.series = rows.map((r) => [r[0], r6(r[1]), r6(r[2]), r6(r[3])]);
  const sdCoin = sd(pCoin);
  out.verdict = { verdict: sdCoin < 0.003 ? "난망 신호" : "여지 있음", keyNumber: `P_coin 일별 sd ${pct(sdCoin)} (기준 0.3%) · 달러 김프 분산 중 테더 몫 β=${shareTether === null ? "-" : shareTether.toFixed(2)}`, structuralWarning: sdCoin < 0.003 };
  return out;
}

// ───────────────────────────── 실행 ─────────────────────────────
console.log("\n전략 계산…");
const A = strategyA();
const B = strategyB();
const C = strategyC();
const D = strategyD();
const E = strategyE();
const F = strategyF();

if (invariantErrors.length) {
  console.error(`\n✗ 불변식 위반 ${invariantErrors.length}건 — 중단`);
  for (const e of invariantErrors.slice(0, 12)) console.error(`  ${e}`);
  process.exit(1);
}
console.log("✓ 불변식 6종 통과 (|P_coin|<20% · |P_usdt|<10% · |basis|<2% · |D|<2% · BTC/ETH 커버리지≥95% · 환율 결측 0)");

const books = loadCache("books-summary.json");
let loggerStatus = null;
try {
  loggerStatus = JSON.parse(readFileSync(join(CACHE_DIR, "books", "status.json"), "utf8"));
} catch {
  /* 로거 미실행 */
}

// 판정표
const benchmark = D.verdict.verdict;
const verdictTable = [
  { key: "A", name: CRITERIA.A.name, verdict: A.verdict.verdict, keyNumber: A.verdict.keyNumber, breakeven: A.perSymbol.BTC ? pct(A.perSymbol.BTC.byCapital[AS.capitalKrw[1]].fwd.costHedged) + " (BTC 5천만원 헤지)" : "-", blocker: "외국환거래법·트래블룰(명의 일치)·첫 출금 지연·전송 중 가격 위험", regulation: "미확인(법률 자문)", vsBenchmark: benchmark },
  { key: "B", name: CRITERIA.B.name, verdict: B.verdict.verdict, keyNumber: B.verdict.keyNumber, breakeven: pct(B.cost), blocker: "역김프 심화·증거금 보충은 전송 필요·업비트 유의종목", regulation: "해당 적음(전송 없음)", vsBenchmark: benchmark },
  { key: "C", name: CRITERIA.C.name, verdict: C.verdict.verdict, keyNumber: C.verdict.keyNumber, breakeven: pct(C.cost), blocker: "알트 유동성·4다리 체결·상장폐지", regulation: "해당 적음", vsBenchmark: benchmark },
  { key: "D", name: CRITERIA.D.name, verdict: D.verdict.verdict, keyNumber: D.verdict.keyNumber, breakeven: `${pct(D.cost)}/회 (연 ${pct(D.annualCost)})`, blocker: "펀딩 역전·OKX 단일 거래소 위험", regulation: "해당 없음(OKX 내부)", vsBenchmark: "기준선" },
  { key: "E", name: CRITERIA.E.name, verdict: E.verdict.verdict, keyNumber: E.verdict.keyNumber, breakeven: pct(E.breakeven), blocker: "USDT 마켓 유동성·동시 체결", regulation: "해당 없음(업비트 내부)", vsBenchmark: benchmark },
  { key: "F", name: CRITERIA.F.name, verdict: F.verdict ? F.verdict.verdict : "-", keyNumber: F.verdict ? F.verdict.keyNumber : "-", breakeven: "-", blocker: "-", regulation: "-", vsBenchmark: "-" },
];

const minuteWin = minuteBySym.BTC ? { from: new Date(minuteBySym.BTC.rows[0][0]).toISOString(), to: new Date(minuteBySym.BTC.rows.at(-1)[0]).toISOString(), days: r4((minuteBySym.BTC.rows.at(-1)[0] - minuteBySym.BTC.rows[0][0]) / DAY) } : null;
const dailyWin = dailyBySym.BTC ? { from: new Date(dailyBySym.BTC[0][0]).toISOString().slice(0, 10), to: new Date(dailyBySym.BTC.at(-1)[0]).toISOString().slice(0, 10), days: dailyBySym.BTC.length } : null;

const result = {
  meta: {
    generatedAt: new Date().toISOString(),
    windows: { minute: minuteWin, daily: dailyWin, tetherFrom: usdtDaily.length ? new Date(usdtDaily[0][0]).toISOString().slice(0, 10) : null },
    sources: SOURCES,
    fees,
    criteria: CRITERIA,
    verification: fetchReport,
    invariants: ["|P_coin| < 20%", "|P_usdt| < 10%", "|basis| < 2%", "|D| < 2%", "BTC·ETH 1m 조인 커버리지 ≥ 95%", "환율 일봉 결측 0"],
    loggerStatus,
  },
  universe: uni,
  fx: fxOut,
  premium,
  strategies: { A, B, C, D, E, F },
  regulation: REGULATION,
  verdictTable,
  books: books || null,
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, "arbitrage.json");
const json = JSON.stringify(result);
writeFileSync(outPath, json);
console.log(`\n판정표`);
for (const v of verdictTable) console.log(`  ${v.key} ${v.name.padEnd(22)} ${v.verdict.padEnd(6)} ${v.keyNumber}`);
console.log(`\n✓ ${outPath} (${(Buffer.byteLength(json) / 1024 / 1024).toFixed(2)}MB)`);
if (Buffer.byteLength(json) > 8 * 1024 * 1024) console.warn("⚠ JSON 8MB 초과 — 차트 시리즈를 줄여야 한다");
