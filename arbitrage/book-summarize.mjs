/**
 * 호가 로그 요약 — book-logger.mjs 가 쌓은 ndjson 을 읽어 "실제로 체결 가능한" 숫자를 낸다.
 *
 * 캔들 김프는 종가 대 종가라서 호가 스프레드·깊이를 모른다. 여기서는 같은 틱의 양쪽 호가로
 *   (1) 규모별 실행 프리미엄 — OKX 매수(ask VWAP) → 업비트 매도(bid VWAP), 그리고 그 역방향
 *   (2) 거래소별 호가 스프레드(bp)와 8단계 깊이(원화 환산)
 *   (3) 선후행 — OKX 스왑 중간가 수익률과 업비트 중간가 수익률의 지연 상관(±3틱 = ±15초)
 *   (4) 업비트 삼각(KRW-BTC / USDT-BTC / KRW-USDT) 실행 괴리
 *   (5) KST 시간대별 프로파일
 * 을 계산한다. 결과는 .cache/books-summary.json — analyze.mjs 가 있으면 읽어 리포트에 싣는다.
 *
 * 사용: node arbitrage/book-summarize.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchJson } from "./lib/http.mjs";
import { CACHE_DIR, saveCache } from "./lib/cache.mjs";
import { mean, summarize } from "./lib/premium.mjs";

const CORE = ["BTC", "ETH", "XRP", "SOL", "DOGE", "TRX"];
const SIZES_KRW = [1_000_000, 10_000_000, 50_000_000];
const DIR = join(CACHE_DIR, "books");

/** 호가 단계를 걸어 목표 명목(quote 통화)만큼 채운 VWAP. 못 채우면 filled=false. */
function vwap(levels, targetQuote, qtyMul = 1) {
  let spent = 0;
  let qty = 0;
  for (const [p, q] of levels) {
    const avail = p * q * qtyMul;
    const take = Math.min(avail, targetQuote - spent);
    qty += take / p;
    spent += take;
    if (spent >= targetQuote - 1e-9) return { vwap: spent / qty, filled: true };
  }
  return { vwap: qty > 0 ? spent / qty : null, filled: false };
}

function depthQuote(levels, qtyMul = 1) {
  let s = 0;
  for (const [p, q] of levels) s += p * q * qtyMul;
  return s;
}

function corr(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 30) return null;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    sxy += a * b;
    sxx += a * a;
    syy += b * b;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

async function main() {
  const files = readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f)).sort();
  if (!files.length) throw new Error("호가 로그가 없다 — book-logger.mjs 를 먼저 돌린다");
  const swapInst = (await fetchJson("https://www.okx.com/api/v5/market/tickers?instType=SWAP")).data; // 존재 확인용
  const instRows = (await fetchJson("https://www.okx.com/api/v5/public/instruments?instType=SWAP")).data;
  const ctVal = new Map(instRows.map((i) => [i.instId, Number(i.ctVal)]));
  for (const s of CORE) if (!ctVal.has(`${s}-USDT-SWAP`)) throw new Error(`${s}-USDT-SWAP ctVal 없음`);
  void swapInst;

  // 틱별로 묶는다
  const ticks = new Map();
  let rows = 0;
  for (const f of files) {
    for (const line of readFileSync(join(DIR, f), "utf8").split("\n")) {
      if (!line) continue;
      const r = JSON.parse(line);
      rows += 1;
      if (!ticks.has(r.t)) ticks.set(r.t, {});
      ticks.get(r.t)[r.m] = r;
    }
  }
  const tickList = [...ticks.entries()].sort((a, b) => a[0] - b[0]);
  const t0 = tickList[0][0];
  const t1 = tickList[tickList.length - 1][0];
  const hoursCovered = (t1 - t0) / 3600_000;
  const expectedTicks = Math.round((t1 - t0) / 5000) + 1;
  console.log(`파일 ${files.length} · 행 ${rows.toLocaleString()} · 틱 ${tickList.length.toLocaleString()} (기대 ${expectedTicks.toLocaleString()}, ${((tickList.length / expectedTicks) * 100).toFixed(1)}%) · ${hoursCovered.toFixed(1)}시간`);

  const per = {};
  const series = {}; // 선후행용 중간가
  for (const s of CORE) {
    per[s] = { spreadBps: { upbit: [], okxSpot: [], okxSwap: [] }, depthKrw: { upbitBid: [], upbitAsk: [], okxSpotAsk: [], okxSpotBid: [] }, midPremium: [], exec: {}, complete: 0 };
    for (const sz of SIZES_KRW) per[s].exec[sz] = { fwd: [], rev: [], fwdFill: 0, revFill: 0, n: 0 };
    series[s] = { t: [], upMid: [], okSwapMid: [], okSpotMid: [] };
  }
  const tri = { mid: [], execFwd: [], execRev: [] };
  const hourly = Array.from({ length: 24 }, () => ({ n: 0, absPrem: [], upSpread: [], okSpread: [] }));

  for (const [t, b] of tickList) {
    const usdt = b["KRW-USDT"];
    if (!usdt || !usdt.a.length || !usdt.b.length) continue;
    const usdtAsk = usdt.a[0][0];
    const usdtBid = usdt.b[0][0];
    const usdtMid = (usdtAsk + usdtBid) / 2;
    const kstHour = new Date(t + 9 * 3600_000).getUTCHours();

    for (const s of CORE) {
      const up = b[`KRW-${s}`];
      const sp = b[`${s}-USDT`];
      const sw = b[`${s}-USDT-SWAP`];
      if (!up || !sp || !sw || !up.a.length || !up.b.length || !sp.a.length || !sp.b.length || !sw.a.length || !sw.b.length) continue;
      const P = per[s];
      P.complete += 1;
      const upMid = (up.a[0][0] + up.b[0][0]) / 2;
      const spMid = (sp.a[0][0] + sp.b[0][0]) / 2;
      const swMid = (sw.a[0][0] + sw.b[0][0]) / 2;
      P.spreadBps.upbit.push(((up.a[0][0] - up.b[0][0]) / upMid) * 1e4);
      P.spreadBps.okxSpot.push(((sp.a[0][0] - sp.b[0][0]) / spMid) * 1e4);
      P.spreadBps.okxSwap.push(((sw.a[0][0] - sw.b[0][0]) / swMid) * 1e4);
      P.depthKrw.upbitBid.push(depthQuote(up.b));
      P.depthKrw.upbitAsk.push(depthQuote(up.a));
      P.depthKrw.okxSpotAsk.push(depthQuote(sp.a) * usdtMid);
      P.depthKrw.okxSpotBid.push(depthQuote(sp.b) * usdtMid);
      const midPrem = upMid / (spMid * usdtMid) - 1;
      P.midPremium.push(midPrem);
      series[s].t.push(t);
      series[s].upMid.push(upMid);
      series[s].okSwapMid.push(swMid);
      series[s].okSpotMid.push(spMid);
      hourly[kstHour].n += 1;
      hourly[kstHour].absPrem.push(Math.abs(midPrem));
      hourly[kstHour].upSpread.push(((up.a[0][0] - up.b[0][0]) / upMid) * 1e4);
      hourly[kstHour].okSpread.push(((sp.a[0][0] - sp.b[0][0]) / spMid) * 1e4);

      for (const sz of SIZES_KRW) {
        const E = P.exec[sz];
        E.n += 1;
        // 정방향: OKX 현물 ask 로 사서(USDT = sz/usdtAsk) 업비트 bid 에 판다. 테더는 업비트 KRW-USDT ask 로 산 값.
        const okBuy = vwap(sp.a, sz / usdtAsk);
        const upSell = vwap(up.b, sz);
        if (okBuy.filled && upSell.filled) {
          E.fwdFill += 1;
          E.fwd.push(upSell.vwap / (okBuy.vwap * usdtAsk) - 1);
        }
        // 역방향: 업비트 ask 로 사서 OKX 현물 bid 에 판다. 받은 USDT 를 업비트 KRW-USDT bid 에 판 값으로 환산.
        const upBuy = vwap(up.a, sz);
        const okSell = vwap(sp.b, sz / usdtBid);
        if (upBuy.filled && okSell.filled) {
          E.revFill += 1;
          E.rev.push(upBuy.vwap / (okSell.vwap * usdtBid) - 1);
        }
      }
    }

    // 업비트 삼각
    const kb = b["KRW-BTC"];
    const ub = b["USDT-BTC"];
    if (kb && ub && kb.a.length && kb.b.length && ub.a.length && ub.b.length) {
      const kbMid = (kb.a[0][0] + kb.b[0][0]) / 2;
      const ubMid = (ub.a[0][0] + ub.b[0][0]) / 2;
      tri.mid.push(kbMid / (ubMid * usdtMid) - 1);
      // 정방향: USDT 로 BTC 를 USDT-BTC ask 에 사서 KRW-BTC bid 에 판다 (USDT 는 KRW-USDT ask 로 샀다)
      tri.execFwd.push(kb.b[0][0] / (ub.a[0][0] * usdtAsk) - 1);
      // 역방향: KRW-BTC ask 로 사서 USDT-BTC bid 에 팔고 USDT 를 KRW-USDT bid 에 판다
      tri.execRev.push((ub.b[0][0] * usdtBid) / kb.a[0][0] - 1);
    }
  }

  // 선후행 — 5초 수익률의 지연 상관. lag>0 = OKX 스왑이 앞선다(OKX 의 과거 수익률이 업비트 현재 수익률과 상관).
  const leadLag = {};
  for (const s of CORE) {
    const S = series[s];
    const ru = [];
    const rs = [];
    for (let i = 1; i < S.t.length; i += 1) {
      if (S.t[i] - S.t[i - 1] > 7000) continue; // 끊긴 틱은 건너뜀
      ru.push(Math.log(S.upMid[i] / S.upMid[i - 1]));
      rs.push(Math.log(S.okSwapMid[i] / S.okSwapMid[i - 1]));
    }
    const out = [];
    for (let lag = -3; lag <= 3; lag += 1) {
      const x = lag >= 0 ? rs.slice(0, rs.length - lag) : rs.slice(-lag);
      const y = lag >= 0 ? ru.slice(lag) : ru.slice(0, ru.length + lag);
      out.push({ lagSec: lag * 5, corr: corr(x, y) });
    }
    leadLag[s] = { n: ru.length, lags: out };
  }

  const perOut = {};
  for (const s of CORE) {
    const P = per[s];
    perOut[s] = {
      ticks: P.complete,
      spreadBps: { upbit: summarize(P.spreadBps.upbit), okxSpot: summarize(P.spreadBps.okxSpot), okxSwap: summarize(P.spreadBps.okxSwap) },
      depthKrw8: { upbitBid: summarize(P.depthKrw.upbitBid), upbitAsk: summarize(P.depthKrw.upbitAsk), okxSpotAsk: summarize(P.depthKrw.okxSpotAsk), okxSpotBid: summarize(P.depthKrw.okxSpotBid) },
      midPremium: summarize(P.midPremium),
      exec: Object.fromEntries(
        SIZES_KRW.map((sz) => {
          const E = P.exec[sz];
          return [sz, { n: E.n, fwdFillRate: E.n ? E.fwdFill / E.n : null, revFillRate: E.n ? E.revFill / E.n : null, fwd: summarize(E.fwd), rev: summarize(E.rev) }];
        }),
      ),
    };
  }
  const out = {
    generatedAt: new Date().toISOString(),
    files,
    rows,
    ticks: tickList.length,
    expectedTicks,
    coverage: tickList.length / expectedTicks,
    from: new Date(t0).toISOString(),
    to: new Date(t1).toISOString(),
    hours: +hoursCovered.toFixed(2),
    sizesKrw: SIZES_KRW,
    levels: 8,
    perSymbol: perOut,
    leadLag,
    triangle: { mid: summarize(tri.mid), execFwd: summarize(tri.execFwd), execRev: summarize(tri.execRev) },
    hourlyKst: hourly.map((h, i) => ({ hour: i, n: h.n, absPremMean: mean(h.absPrem), upSpreadBps: mean(h.upSpread), okSpreadBps: mean(h.okSpread) })),
  };
  saveCache("books-summary.json", out);
  for (const s of CORE) {
    const p = perOut[s];
    const e = p.exec[SIZES_KRW[1]];
    console.log(
      `  ${s.padEnd(5)} 틱 ${p.ticks} · 스프레드 bp 업비트 ${p.spreadBps.upbit.p50?.toFixed(1)} / OKX현물 ${p.spreadBps.okxSpot.p50?.toFixed(1)} / OKX스왑 ${p.spreadBps.okxSwap.p50?.toFixed(1)}` +
        ` · 중간가 김프 p50 ${(p.midPremium.p50 * 100).toFixed(3)}% · 1천만원 실행 정방향 p50 ${e.fwd.n ? (e.fwd.p50 * 100).toFixed(3) : "-"}% (채움 ${(e.fwdFillRate * 100).toFixed(0)}%) 역방향 p50 ${e.rev.n ? (e.rev.p50 * 100).toFixed(3) : "-"}%`,
    );
  }
  console.log(`  삼각 중간가 p50 ${(out.triangle.mid.p50 * 100).toFixed(3)}% · 정방향 실행 p50 ${(out.triangle.execFwd.p50 * 100).toFixed(3)}% · 역방향 ${(out.triangle.execRev.p50 * 100).toFixed(3)}%`);
  console.log(`  선후행 BTC: ${leadLag.BTC.lags.map((l) => `${l.lagSec}s ${l.corr === null ? "-" : l.corr.toFixed(2)}`).join(" · ")}`);
  console.log("✓ 저장 .cache/books-summary.json");
}

main().catch((e) => {
  console.error("\n✗", e.message);
  process.exit(1);
});
