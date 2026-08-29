/**
 * 종목 유니버스 — 업비트 KRW 마켓 ∩ OKX USDT 현물 ∩ OKX USDT 스왑.
 *
 * 유의(warning)·주의(caution) 종목은 뺀다 — 업비트가 입출금·가격 이상을 이미 표시한 종목은
 * 김프가 커도 실행할 수 없다. 랭킹은 업비트 24h 거래대금 순위와 OKX 24h 거래대금 순위의
 * 최댓값(양쪽 모두 유동성이 있어야 한다). 핵심 6종은 순위와 무관하게 1m 정밀군.
 *
 * 사용: node arbitrage/universe.mjs
 */
import { fetchJson, sleep } from "./lib/http.mjs";
import { saveCache } from "./lib/cache.mjs";

const UPBIT = "https://api.upbit.com/v1";
const OKX = "https://www.okx.com/api/v5";
export const CORE = ["BTC", "ETH", "XRP", "SOL", "DOGE", "TRX"];
const N = 30;
/** 업비트 표기 → OKX 표기. 같은 코인인데 티커가 다를 때만 적는다. */
const SYMBOL_MAP = {};

async function main() {
  const all = await fetchJson(`${UPBIT}/market/all?is_details=true`);
  const krw = all.filter((m) => m.market.startsWith("KRW-"));
  const flagged = [];
  const clean = krw.filter((m) => {
    const ev = m.market_event || {};
    const caution = ev.caution || {};
    const bad = Boolean(ev.warning) || Object.values(caution).some(Boolean);
    if (bad) flagged.push({ market: m.market, warning: Boolean(ev.warning), caution: Object.keys(caution).filter((k) => caution[k]) });
    return !bad;
  });
  console.log(`업비트 KRW 마켓 ${krw.length}종 · 유의/주의 제외 ${flagged.length} → ${clean.length}`);

  const spot = (await fetchJson(`${OKX}/public/instruments?instType=SPOT`)).data
    .filter((i) => i.quoteCcy === "USDT" && i.state === "live")
    .map((i) => i.baseCcy);
  const swap = (await fetchJson(`${OKX}/public/instruments?instType=SWAP`)).data
    .filter((i) => i.instId.endsWith("-USDT-SWAP") && i.state === "live")
    .map((i) => i.instId.replace(/-USDT-SWAP$/, ""));
  const spotSet = new Set(spot);
  const swapSet = new Set(swap);
  console.log(`OKX USDT 현물 ${spot.length}종 · USDT 스왑 ${swap.length}종`);

  const cand = [];
  const upbitOnly = [];
  for (const m of clean) {
    const up = m.market.slice(4);
    const okx = SYMBOL_MAP[up] ?? up;
    if (spotSet.has(okx) && swapSet.has(okx)) {
      cand.push({ symbol: okx, upbit: m.market, okxSpot: `${okx}-USDT`, okxSwap: `${okx}-USDT-SWAP`, korean: m.korean_name });
    } else {
      upbitOnly.push(up);
    }
  }
  console.log(`교집합(현물+스왑 모두) ${cand.length}종`);

  // 업비트 24h 거래대금
  const upVol = new Map();
  for (let i = 0; i < cand.length; i += 50) {
    const batch = cand.slice(i, i + 50).map((c) => c.upbit).join(",");
    const rows = await fetchJson(`${UPBIT}/ticker?markets=${batch}`);
    for (const r of rows) upVol.set(r.market, Number(r.acc_trade_price_24h));
    await sleep(150);
  }
  // OKX 24h 거래대금(quote = USDT)
  const okxTick = (await fetchJson(`${OKX}/market/tickers?instType=SPOT`)).data;
  const okxVol = new Map(okxTick.map((t) => [t.instId, Number(t.volCcy24h)]));

  for (const c of cand) {
    c.upbitVolKrw = upVol.get(c.upbit) ?? 0;
    c.okxVolUsdt = okxVol.get(c.okxSpot) ?? 0;
  }
  const byUp = [...cand].sort((a, b) => b.upbitVolKrw - a.upbitVolKrw);
  const byOkx = [...cand].sort((a, b) => b.okxVolUsdt - a.okxVolUsdt);
  byUp.forEach((c, i) => {
    c.upbitRank = i + 1;
  });
  byOkx.forEach((c, i) => {
    c.okxRank = i + 1;
  });
  for (const c of cand) c.rank = Math.max(c.upbitRank, c.okxRank);
  cand.sort((a, b) => a.rank - b.rank || a.upbitRank - b.upbitRank);

  const picked = [];
  for (const s of CORE) {
    const c = cand.find((x) => x.symbol === s);
    if (!c) {
      console.error(`✗ 핵심 종목 ${s} 가 교집합에 없다 — 중단`);
      process.exit(1);
    }
    picked.push(c);
  }
  for (const c of cand) {
    if (picked.length >= N) break;
    if (!picked.includes(c)) picked.push(c);
  }
  for (const c of picked) c.tier = CORE.includes(c.symbol) ? "1m" : "5m";

  const out = {
    generatedAt: new Date().toISOString(),
    core: CORE,
    n: picked.length,
    list: picked,
    excluded: { flagged, upbitOnlyCount: upbitOnly.length, upbitOnly: upbitOnly.slice(0, 80) },
    counts: { upbitKrw: krw.length, upbitClean: clean.length, okxSpotUsdt: spot.length, okxSwapUsdt: swap.length, intersection: cand.length },
  };
  saveCache("universe.json", out);
  console.log(`\n선정 ${picked.length}종 (핵심 ${CORE.length} = 1m, 나머지 5m)`);
  for (const c of picked) {
    console.log(
      `  ${String(c.rank).padStart(3)} ${c.symbol.padEnd(6)} ${c.tier} · 업비트 ${(c.upbitVolKrw / 1e8).toFixed(0).padStart(6)}억원(#${c.upbitRank}) · OKX ${(c.okxVolUsdt / 1e6).toFixed(1).padStart(7)}M$(#${c.okxRank})`,
    );
  }
  if (flagged.length) console.log(`\n유의/주의 제외: ${flagged.map((f) => f.market.slice(4)).join(", ")}`);
  console.log("✓ 저장 .cache/universe.json");
}

main().catch((e) => {
  console.error("\n✗", e.message);
  process.exit(1);
});
