import { GexChart, IvTermChart, PcrHistoryChart, StrikeOiChart } from "@/app/(app)/options/options-charts";
import { StatTile } from "@/components/stat-tile";
import { DASH, dateTime, num, pct, signed, signedPct } from "@/lib/format";
import { analyzeOptions, HEADLINE_MIN_DTE, pickHeadline } from "@/lib/options/analyze";
import { collectOptionsSnapshot } from "@/lib/options/collect";
import { usdCompact } from "@/lib/options/format";
import {
  OPTION_GUIDE,
  readDvol,
  readFlow,
  readGex,
  readIvMinusRv,
  readIvTerm,
  readMaxPain,
  readPcr,
  readSkew,
  readWalls,
  type IndicatorKey,
} from "@/lib/options/guide";
import {
  OPTION_SOURCE_KEYS,
  type OptionSourceKey,
  type OptionVenue,
  type TakerBlockFlow,
} from "@/lib/options/types";
import { TONE_CLASS, type Verdict } from "@/lib/verdict";

/**
 * 옵션 분석 — BTC 옵션 시장의 현재 상태를 한 장으로.
 *
 * 저장하지 않는다. 열 때마다 OKX·Deribit 공개 API 를 부르고(60초 캐시) 그 자리에서 계산한다 —
 * 리서치 스냅샷과 달리 이력을 쌓지 않는 것은 사용자 결정(REQ-0070)이다. 그래서 이 화면은
 * "지금" 만 말하고, 추이는 거래소가 주는 24일치(OKX)만 보여 준다.
 *
 * 숫자마다 「무엇인가 · 어떻게 읽나」(guide.ts 의 고정 문구)와 「지금 값의 뜻」(verdict)을
 * 같은 카드에 붙인다. 옵션 지표는 숫자만 봐서는 방향조차 안 잡히는 것이 많아, 설명이 다른
 * 자리에 있으면 매번 찾아 읽게 된다.
 */

/** 소스 칩·부제에 쓰는 이름 — 키는 코드, 화면은 사람 말. */
const SOURCE_LABEL: Record<OptionSourceKey, string> = {
  okx: "OKX",
  deribit: "Deribit",
  dvol: "DVOL",
  candles: "일봉",
};

const VENUE_LABEL: Record<OptionVenue, string> = { okx: "OKX", deribit: "Deribit" };

/** 「지표 읽는 법」 목록의 제목 — OPTION_GUIDE 키 순서대로 찍는다. */
const GUIDE_LABEL: Record<IndicatorKey, string> = {
  oi: "총 OI",
  volume: "24h 거래량",
  pcrOi: "풋콜비 (OI)",
  pcrVol: "풋콜비 (거래량)",
  dvol: "DVOL",
  atmIv: "ATM IV",
  rv30: "실현변동성 30일",
  ivMinusRv: "IV − RV",
  maxPain: "맥스페인",
  walls: "콜벽 · 풋벽",
  ivTerm: "IV 기간구조",
  skew: "25Δ 스큐",
  gex: "GEX",
  flow: "테이커 흐름",
  history: "OKX 추이",
};

function usdPrice(value: number | null): string {
  return value === null ? DASH : `$${num(value, 0)}`;
}

/** 두 IV 의 차이(0.032)는 %p 로 읽는다 — `+3.2%p`. */
function pctPoints(value: number | null): string {
  return value === null ? DASH : `${signedPct(value, 1)}p`;
}

/** 올림 — 0.76일 남은 만기는 "내일" 이라 D-1. 해석 문구(guide.ts)와 같은 규칙. */
function dday(dte: number): string {
  return `D-${Math.ceil(dte)}`;
}

/** 카드마다 붙는 고정 두 줄. */
function Guide({ id }: { id: IndicatorKey }) {
  const guide = OPTION_GUIDE[id];
  return (
    <div className="space-y-0.5 text-[11.5px] leading-relaxed text-dim">
      <p>
        <span className="text-text">무엇인가</span> · {guide.what}
      </p>
      <p>
        <span className="text-text">어떻게 읽나</span> · {guide.how}
      </p>
    </div>
  );
}

/** 「지금 값의 뜻」 한 줄 — 색은 verdict 의 tone. */
function VerdictLine({ verdict }: { verdict: Verdict }) {
  return <p className={`text-[11.5px] leading-snug ${TONE_CLASS[verdict.tone]}`}>{verdict.text}</p>;
}

function FlowRow({ label, buy, sell }: { label: string; buy: number; sell: number }) {
  const net = buy - sell;
  return (
    <tr className="border-t border-border">
      <td className="py-1.5 pr-3">{label}</td>
      <td className="tnum py-1.5 pr-3 text-right">{num(buy, 1)}</td>
      <td className="tnum py-1.5 pr-3 text-right">{num(sell, 1)}</td>
      <td className={`tnum py-1.5 text-right ${net > 0 ? "text-profit" : net < 0 ? "text-loss" : ""}`}>
        {signed(net, 1)}
      </td>
    </tr>
  );
}

/** 테이커 넷만 — 블록 두 값은 OKX 가 단위를 밝히지 않아(실측도 BTC 가 아니다) 표에 넣지 않는다. */
function FlowTable({ flow }: { flow: TakerBlockFlow }) {
  return (
    <div className="scroll-x">
      <table className="w-full min-w-[20rem] text-sm">
        <thead>
          <tr className="text-left text-[11px] text-dim">
            <th className="py-1 pr-3 font-normal">BTC</th>
            <th className="py-1 pr-3 text-right font-normal">테이커 매수</th>
            <th className="py-1 pr-3 text-right font-normal">테이커 매도</th>
            <th className="py-1 text-right font-normal">순매수</th>
          </tr>
        </thead>
        <tbody>
          <FlowRow label="콜" buy={flow.callBuy} sell={flow.callSell} />
          <FlowRow label="풋" buy={flow.putBuy} sell={flow.putSell} />
        </tbody>
      </table>
    </div>
  );
}

export default async function OptionsPage() {
  const snapshot = await collectOptionsSnapshot();
  // 시각은 수집기가 한 번 잡은 값을 그대로 쓴다 — 만기 필터·D-day·GEX 잔여기간이 같은 기준을
  // 쓰고, 렌더 안에서 `Date.now()` 를 부르지 않는다(react-hooks/purity).
  const nowMs = Date.parse(snapshot.collectedAt);
  const analysis = analyzeOptions(snapshot, nowMs);
  const { spot, totals, expiries, walls, gex, ivTerm, ivVenue } = analysis;

  // 근월 — 맥스페인은 첫 만기(내일 만기의 끌림이 곧 관심사). ATM IV·스큐는 만기 직전 잡음을
  // 피해 일주일 이상 남은 첫 만기(`pickHeadline`). 표에는 전 만기가 그대로 있다.
  const near = expiries[0] ?? null;
  const headline = pickHeadline(expiries);
  const nearIv = pickHeadline(ivTerm);
  const flow = snapshot.okxFlow;

  // 거래소가 하나 죽으면 남은 쪽 값은 "시장 전체" 가 아니다 — 라벨이 그 사실을 말해야 한다.
  // 죽은 거래소를 0% 로 찍지도 않는다(CONFIG: 잘못된 숫자는 빈 자리보다 나쁘다).
  const okxLive = snapshot.sources.okx === "ok";
  const deribitLive = snapshot.sources.deribit === "ok";
  const venueNote =
    okxLive && deribitLive ? "두 거래소 합" : okxLive ? "OKX 값만 — Deribit 실패" : "Deribit 값만 — OKX 실패";
  // 거래소별 OI 몫 — 큰 쪽부터. "Deribit 92% · OKX 8%". 둘 다 살아 있을 때만 뜻이 있다.
  const venueShare =
    okxLive && deribitLive && totals.oi > 0
      ? [...totals.byVenue]
          .sort((a, b) => b.oi - a.oi)
          .map((v) => `${VENUE_LABEL[v.venue]} ${pct(v.oi / totals.oi, 0)}`)
          .join(" · ")
      : venueNote;

  const wallsVerdict = readWalls(walls.callWall, walls.putWall, spot);
  const ivTermVerdict = readIvTerm(ivTerm);
  const gexVerdict = readGex(gex.total);
  const flowVerdict = readFlow(flow);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">옵션 분석</h1>
        <p className="mt-1 text-sm text-dim">
          BTC 옵션 시장이 어느 가격을 방어하고 어디에 베팅하는지 — OKX·Deribit 공개 데이터, 화면을 열 때
          조회
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-dim">
          <span className="tnum">
            기준가 <span className="font-medium text-text">{usdPrice(spot)}</span>
          </span>
          <span className="tnum">수집 {dateTime(snapshot.collectedAt)}</span>
          <span className="flex flex-wrap items-center gap-1">
            {OPTION_SOURCE_KEYS.map((key) => {
              const status = snapshot.sources[key];
              const ok = status === "ok";
              return (
                <span
                  key={key}
                  title={ok ? undefined : status}
                  className={`rounded-md border border-border px-1.5 py-0.5 ${ok ? "" : "text-loss"}`}
                >
                  {SOURCE_LABEL[key]} {ok ? "OK" : "실패"}
                </span>
              );
            })}
          </span>
        </div>
        <p className="mt-1 text-[11.5px] text-dim">
          OI·거래량·맥스페인·벽·GEX 는 {venueNote} · IV 지표(ATM IV·기간구조·25Δ 스큐·선도가)는{" "}
          {ivVenue === null ? "재료가 없어 비어 있습니다" : `${VENUE_LABEL[ivVenue]} 값`}
          {ivVenue === "okx" ? " (Deribit IV 를 받지 못해 OKX 로 대체)" : ""}
        </p>
      </header>

      {/* ── 1. 한눈에 ─────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">한눈에</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatTile
            label="총 OI"
            value={`${num(totals.oi, 0)} BTC`}
            sub={[usdCompact(totals.oiUsd), venueShare].filter(Boolean).join(" · ")}
          />
          <StatTile
            label="24h 거래량"
            value={`${num(totals.vol24h, 0)} BTC`}
            sub={totals.oi > 0 ? `${venueNote} · OI 대비 ${pct(totals.vol24h / totals.oi, 0)}` : venueNote}
          />
          <StatTile
            label="풋콜비 (OI)"
            value={num(totals.pcrOi, 2)}
            sub="풋 OI ÷ 콜 OI"
            verdict={readPcr(totals.pcrOi, "oi")}
          />
          <StatTile
            label="풋콜비 (거래량)"
            value={num(totals.pcrVol, 2)}
            sub="24h 풋 거래량 ÷ 콜 거래량"
            verdict={readPcr(totals.pcrVol, "vol")}
          />
          <StatTile
            label="DVOL"
            value={pct(analysis.dvol, 1)}
            sub="Deribit 30일 내재변동성 지수"
            verdict={readDvol(analysis.dvol)}
          />
          <StatTile
            label={`ATM IV (D-${HEADLINE_MIN_DTE}↑ 근월)`}
            value={pct(nearIv?.atmIv ?? null, 1)}
            sub={
              nearIv === null
                ? "IV 재료 없음"
                : `만기 ${nearIv.expiry} (${dday(nearIv.dte)})${ivVenue ? ` · ${VENUE_LABEL[ivVenue]}` : ""}`
            }
          />
          <StatTile
            label="실현변동성 30일"
            value={pct(analysis.rv30, 1)}
            sub="OKX 일봉 종가 30개 로그수익률 표본표준편차 × √365"
          />
          <StatTile
            label="IV − RV"
            value={pctPoints(analysis.ivMinusRv)}
            sub="DVOL − RV30"
            verdict={readIvMinusRv(analysis.ivMinusRv)}
          />
          <StatTile
            label="맥스페인 (근월)"
            value={usdPrice(near?.maxPain ?? null)}
            sub={near === null ? "만기 없음" : `만기 ${near.expiry} (${dday(near.dte)})`}
            verdict={readMaxPain(near?.maxPain ?? null, spot, near?.dte ?? null)}
          />
        </div>
      </section>

      {/* ── 2. 지표 읽는 법 ───────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          지표 읽는 법{" "}
          <span className="font-normal text-dim">— 무엇을 재는 값이고, 높고 낮음이 각각 무슨 뜻인지</span>
        </h2>
        <dl className="mt-3 grid gap-x-6 gap-y-3 lg:grid-cols-2">
          {(Object.keys(OPTION_GUIDE) as IndicatorKey[]).map((key) => (
            <div key={key} className="text-[11.5px] leading-relaxed">
              <dt className="font-medium">{GUIDE_LABEL[key]}</dt>
              <dd className="text-dim">
                <span className="text-text">무엇인가</span> · {OPTION_GUIDE[key].what}
              </dd>
              <dd className="text-dim">
                <span className="text-text">어떻게 읽나</span> · {OPTION_GUIDE[key].how}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ── 3. 만기별 ─────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          만기별{" "}
          <span className="font-normal text-dim">
            — OI 는 {venueNote}, IV·선도가는 {ivVenue === null ? "없음" : VENUE_LABEL[ivVenue]}
          </span>
        </h2>
        {expiries.length === 0 ? (
          <p className="mt-3 text-xs text-dim">남은 만기가 없습니다.</p>
        ) : (
          <div className="mt-2 scroll-x">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="text-left text-[11px] text-dim">
                  <th className="py-1 pr-3 font-normal">만기</th>
                  <th className="py-1 pr-3 font-normal">D-day</th>
                  <th className="py-1 pr-3 text-right font-normal">콜 OI</th>
                  <th className="py-1 pr-3 text-right font-normal">풋 OI</th>
                  <th className="py-1 pr-3 text-right font-normal">풋콜비</th>
                  <th className="py-1 pr-3 text-right font-normal">맥스페인</th>
                  <th className="py-1 pr-3 text-right font-normal">ATM IV</th>
                  <th className="py-1 pr-3 text-right font-normal">25Δ RR</th>
                  <th className="py-1 text-right font-normal">선도가</th>
                </tr>
              </thead>
              <tbody>
                {expiries.map((e) => (
                  <tr key={e.expiry} className="border-t border-border">
                    <td className="tnum py-1.5 pr-3">{e.expiry}</td>
                    <td className="tnum py-1.5 pr-3 text-dim">{dday(e.dte)}</td>
                    <td className="tnum py-1.5 pr-3 text-right">{num(e.callOi, 0)}</td>
                    <td className="tnum py-1.5 pr-3 text-right">{num(e.putOi, 0)}</td>
                    <td className="tnum py-1.5 pr-3 text-right">{num(e.pcrOi, 2)}</td>
                    <td className="tnum py-1.5 pr-3 text-right">{usdPrice(e.maxPain)}</td>
                    <td className="tnum py-1.5 pr-3 text-right">{pct(e.atmIv, 1)}</td>
                    {/* 색을 칠하지 않는다 — 양수가 좋은 것이 아니다(+3%p 위는 FOMO 경계). */}
                    <td className="tnum py-1.5 pr-3 text-right">{pctPoints(e.rr25)}</td>
                    <td className="tnum py-1.5 text-right">{usdPrice(e.forward)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-dim">
          D-day 는 올림 · 25Δ RR 은 감싸는 행사가가 없으면(만기 직전·좁은 행사가) 비워 둡니다 · 해석은 D-
          {HEADLINE_MIN_DTE} 이상 남은 첫 만기{headline ? `(${headline.expiry})` : ""} 기준
        </p>
        <div className="mt-3 space-y-2">
          <VerdictLine verdict={ivTermVerdict} />
          <VerdictLine verdict={readSkew(headline?.rr25 ?? null)} />
          <Guide id="skew" />
        </div>
      </section>

      {/* ── 4. 행사가별 OI ─────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          행사가별 OI <span className="font-normal text-dim">— {venueNote}, BTC 개수</span>
        </h2>
        <div className="mt-3">
          <StrikeOiChart
            strikesByExpiry={analysis.strikesByExpiry}
            expiries={expiries.map((e) => e.expiry)}
            spot={spot}
            callWall={walls.callWall}
            putWall={walls.putWall}
          />
        </div>
        <div className="mt-3 space-y-2">
          <VerdictLine verdict={wallsVerdict} />
          <Guide id="walls" />
        </div>
      </section>

      {/* ── 5. IV 기간구조 ─────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          IV 기간구조{" "}
          <span className="font-normal text-dim">
            — 만기별 ATM IV{ivVenue === null ? "" : ` · ${VENUE_LABEL[ivVenue]}`}
          </span>
        </h2>
        <div className="mt-3">
          <IvTermChart data={ivTerm} />
        </div>
        <div className="mt-3 space-y-2">
          <VerdictLine verdict={ivTermVerdict} />
          <Guide id="ivTerm" />
        </div>
      </section>

      {/* ── 6. GEX ────────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">
            GEX <span className="font-normal text-dim">— 감마 익스포저, USD / 현물 1% 변동</span>
          </h2>
          <span className="tnum text-[11.5px] text-dim">
            총합{" "}
            <span className={`font-medium ${gex.total === null ? "" : gex.total > 0 ? "text-profit" : gex.total < 0 ? "text-loss" : ""}`}>
              {gex.total === null ? DASH : `${usdCompact(gex.total)}/1%`}
            </span>
            {" · "}플립 {usdPrice(gex.flipStrike)}
          </span>
        </div>
        <div className="mt-3">
          <GexChart data={gex.byStrike} spot={spot} flipStrike={gex.flipStrike} />
        </div>
        <div className="mt-3 space-y-2">
          <VerdictLine verdict={gexVerdict} />
          <Guide id="gex" />
          <p className="rounded-lg border border-beta/40 bg-beta/5 p-2.5 text-[11.5px] leading-relaxed text-dim">
            <span className="text-beta">추정치입니다.</span> 딜러가 콜 롱·풋 숏 포지션이라는 표준 가정(콜 +, 풋 −)
            위에서 마크 IV 로 낸 블랙-숄즈 감마 × OI × 현물² × 1% 를 더한 값입니다. 실제 딜러 포지션은 공개되지
            않으므로 부호와 자릿수만 참고하고, 플립 행사가도 그 가정 아래의 경계입니다.
          </p>
        </div>
      </section>

      {/* ── 7. OKX 추이 ───────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          OKX 추이 (24일){" "}
          <span className="font-normal text-dim">
            — 풋콜비 OI·거래량, 8시간 간격 · OKX 한 곳 값이라 위 타일(두 거래소 합)과 수준이 다릅니다
          </span>
        </h2>
        <div className="mt-3">
          <PcrHistoryChart data={snapshot.okxHistory} />
        </div>
        <div className="mt-3">
          <Guide id="history" />
        </div>
      </section>

      {/* ── 8. OKX 테이커·블록 ─────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          OKX 테이커 일간 흐름{" "}
          <span className="font-normal text-dim">
            — BTC 개수 · Deribit 은 공개 집계가 없어 OKX 한 곳 값입니다
          </span>
        </h2>
        {flow === null ? (
          <p className="mt-3 text-xs text-dim">OKX 테이커 흐름을 받지 못했습니다.</p>
        ) : (
          <div className="mt-2">
            <FlowTable flow={flow} />
            <p className="tnum mt-1 text-[11px] text-dim">
              OKX 1D 집계 — {dateTime(new Date(flow.ts - 86_400_000).toISOString())} ~{" "}
              {dateTime(new Date(flow.ts).toISOString())} (UTC+8 하루, 마감값) · 블록 거래량은 OKX 가 단위를
              밝히지 않아 표시하지 않습니다
            </p>
          </div>
        )}
        <div className="mt-3 space-y-2">
          <VerdictLine verdict={flowVerdict} />
          <Guide id="flow" />
        </div>
      </section>

      {/* ── 9. 출처 ───────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface-2 p-4 text-[11.5px] leading-relaxed text-dim">
        <h2 className="text-sm font-medium text-text">출처와 단위</h2>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>
            OKX: <code className="rounded bg-surface px-1">public/open-interest</code> ·{" "}
            <code className="rounded bg-surface px-1">public/opt-summary</code> ·{" "}
            <code className="rounded bg-surface px-1">market/tickers</code> ·{" "}
            <code className="rounded bg-surface px-1">rubik/stat/option/*</code> ·{" "}
            <code className="rounded bg-surface px-1">market/index-tickers</code> ·{" "}
            <code className="rounded bg-surface px-1">market/candles</code>(1D, 실현변동성 재료)
          </li>
          <li>
            Deribit: <code className="rounded bg-surface px-1">get_book_summary_by_currency</code> ·{" "}
            <code className="rounded bg-surface px-1">get_volatility_index_data</code>(DVOL) ·{" "}
            <code className="rounded bg-surface px-1">get_index_price</code>
          </li>
          <li>공개 API, 키 없음, 60초 캐시(일봉은 300초). 화면을 열 때 조회하고 저장하지 않습니다.</li>
          <li>
            단위 — OI·거래량은 BTC 개수(두 거래소 모두 코인 정산), IV·DVOL·실현변동성은 연율 %, 가격은 USD, GEX 는 USD /
            현물 1% 변동. 만기는 UTC 날짜(두 거래소 모두 08:00 UTC 정산).
          </li>
          <li>
            산식·가정·해석 밴드의 정본은 <code className="rounded bg-surface px-1">docs/options/README.md</code> 입니다.
          </li>
        </ul>
      </section>
    </div>
  );
}
