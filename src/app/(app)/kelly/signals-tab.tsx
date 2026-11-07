import { DASH, dateTime, num, pct, price, signed, signedPct } from "@/lib/format";
import { usdCompact } from "@/lib/options/format";
import {
  collectThreshold,
  judgeThresholds,
  JUDGE_TFS,
  THRESHOLD_LABEL,
  type ThresholdKey,
  type ThresholdVerdict,
} from "@/lib/threshold";
import { nextHvnDistPct } from "@/lib/threshold/liquidity";
import type { SignalSide, ThresholdReport, VolatilityTf } from "@/lib/threshold/types";

/**
 * 임계점 지표판 — 피라미딩(추가 진입) 전에 시장 구조가 내 방향으로 열렸는지 본다(REQ-0102).
 *
 * 열 때 계산한다(D11) — 저장하지 않는다. 다리 기록 순간 값만 trade_legs.signals 에 남는다.
 * 측정 못 한 것은 「미확인」(회색) — 꺼짐과 다르다. 꺼짐은 재서 아니었다는 뜻이고, 미확인은 모른다는 뜻이다.
 * 기준값(THRESHOLD_RULES)은 검증 전 시작값이다.
 */

const SIDE_TEXT: Record<SignalSide, string> = { long: "롱", short: "숏" };

const SOURCE_LABEL: Record<keyof ThresholdReport["sources"], string> = {
  candles: "캔들",
  options: "옵션",
  derivs: "펀딩·OI",
  book: "호가",
};

const distPct = (v: number | null) => (v === null ? DASH : `${num(v, 2)}%`);

/** 판정 칸 — 켜짐/꺼짐/미확인 + 그 방향 경고. */
function VerdictCell({ v, side }: { v: ThresholdVerdict; side: SignalSide }) {
  const warn = v.warn[side];
  return (
    <div className="flex flex-wrap items-center gap-1">
      {!v.measured ? (
        <span className="rounded-md border border-dashed border-border px-1.5 py-0.5 text-xs text-dim">미확인</span>
      ) : v.on[side] ? (
        <span className="rounded-md bg-profit/10 px-1.5 py-0.5 text-xs font-medium text-profit">켜짐</span>
      ) : (
        <span className="rounded-md border border-border px-1.5 py-0.5 text-xs">꺼짐</span>
      )}
      {warn ? (
        <span className="rounded-md bg-beta/10 px-1.5 py-0.5 text-xs text-beta" title="추가 금지 경고">
          경고 · {warn}
        </span>
      ) : null}
    </div>
  );
}

/** 판정 표 「지금 값」 한 줄. */
function nowText(key: ThresholdKey, r: ThresholdReport): string {
  switch (key) {
    case "volatility":
      return r.volatility
        .filter((v) => JUDGE_TFS.includes(v.tf))
        .map((v) => `${v.tf} ${v.label}`)
        .join(" · ");
    case "gamma": {
      const g = r.gamma;
      if (g === null) return r.sources.options === "ok" ? "옵션 행 없음" : r.sources.options;
      const sign = g.netGexNearSpot === null ? "부호 미확인" : g.netGexNearSpot >= 0 ? "순 GEX +" : "순 GEX −";
      return `${sign} · 플립 ${g.flipStrike === null ? DASH : price(g.flipStrike)}`;
    }
    case "fuel": {
      const f = r.fuel;
      if (f === null) return DASH;
      return `펀딩 연 ${signedPct(f.fundingAnnual, 1)} · OI 24h ${f.oiChg24hPct === null ? DASH : `${signed(f.oiChg24hPct, 2)}%`} · 가격 24h ${signedPct(f.priceChg24h, 2)}`;
    }
    case "liquidity": {
      const l = r.liquidity;
      if (l === null) return "거래량 프로파일 없음";
      return `위 공백 ${distPct(l.gapUpDistPct)} · 아래 공백 ${distPct(l.gapDownDistPct)} · 깊이비 ${l.depthRatio === null ? "미측정" : num(l.depthRatio, 2)}`;
    }
  }
}

function Reasons({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[12.5px] leading-snug text-dim">
      {reasons.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}

function squeezeText(v: VolatilityTf): string {
  if (!v.state.measured) return DASH;
  return v.squeezeNow ? "지금 스퀴즈" : v.squeezeWithin10 ? "직전 10봉 안" : "없음";
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-border py-1.5 text-sm first:border-t-0">
      <span className="text-dim">{label}</span>
      <span className="tnum text-right">
        {value}
        {sub ? <span className="ml-1 text-xs text-dim">{sub}</span> : null}
      </span>
    </div>
  );
}

export async function SignalsTab({ symbol = "BTC-USDT-SWAP" }: { symbol?: string }) {
  const report = await collectThreshold(symbol);
  const { summary, spot, gamma, fuel, liquidity, sources } = report;
  const verdicts = judgeThresholds(report);
  const curBin =
    liquidity !== null && spot !== null ? (liquidity.bins.find((b) => b.lo <= spot && spot < b.hi) ?? null) : null;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">임계점 지표판</h1>
        <p className="mt-1 text-sm text-dim">
          {report.symbol} · 현재가 {spot === null ? DASH : price(spot)} — 변동성 팽창·감마·스퀴즈 연료·유동성
          공백을 화면을 열 때 계산합니다(저장하지 않음).
        </p>
      </header>

      {/* ── 종합 ─────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="tnum flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span>
            롱 켜짐 <span className={`font-semibold ${summary.on.long > 0 ? "text-profit" : ""}`}>{summary.on.long}</span>
          </span>
          <span>
            숏 켜짐 <span className={`font-semibold ${summary.on.short > 0 ? "text-profit" : ""}`}>{summary.on.short}</span>
          </span>
          <span>
            롱 경고{" "}
            <span className={`font-semibold ${summary.warnings.long.length > 0 ? "text-beta" : ""}`}>
              {summary.warnings.long.length}
            </span>
          </span>
          <span>
            숏 경고{" "}
            <span className={`font-semibold ${summary.warnings.short.length > 0 ? "text-beta" : ""}`}>
              {summary.warnings.short.length}
            </span>
          </span>
          <span className={summary.measured ? "" : "text-dim"}>측정 {summary.measuredCount}/4</span>
          <span className="text-dim">수집 {dateTime(report.collectedAt)} KST</span>
        </div>
        <p className="mt-2 text-[12.5px] text-dim">
          피라미딩은 경고 0, 내 방향 켜짐 1개 이상일 때만 검토
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1 text-[12.5px] text-dim">
          {(Object.keys(SOURCE_LABEL) as (keyof ThresholdReport["sources"])[]).map((key) => {
            const status = sources[key];
            const ok = status === "ok";
            return (
              <span
                key={key}
                title={ok ? undefined : status}
                className={`rounded-md border border-border px-1.5 py-0.5 ${ok ? "" : "text-beta"}`}
              >
                {SOURCE_LABEL[key]} {ok ? "OK" : "확인"}
              </span>
            );
          })}
        </div>
        {(Object.keys(SOURCE_LABEL) as (keyof ThresholdReport["sources"])[])
          .filter((key) => sources[key] !== "ok")
          .map((key) => (
            <p key={key} className="mt-1 break-all text-xs text-dim">
              {SOURCE_LABEL[key]}: {sources[key]}
            </p>
          ))}
      </section>

      {/* ── 판정 표 ─────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          판정 <span className="font-normal text-dim">— 미확인은 측정 못 함(꺼짐과 다름)</span>
        </h2>
        <div className="mt-3 scroll-x">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="text-xs text-dim">
              <tr>
                <th className="py-1 pr-3 text-left font-medium">임계점</th>
                <th className="py-1 pr-3 text-left font-medium">롱</th>
                <th className="py-1 pr-3 text-left font-medium">숏</th>
                <th className="py-1 text-left font-medium">지금 값</th>
              </tr>
            </thead>
            <tbody>
              {verdicts.map((v) => (
                <tr key={v.key} className="border-t border-border align-top">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{THRESHOLD_LABEL[v.key]}</td>
                  <td className="py-1.5 pr-3">
                    <VerdictCell v={v} side="long" />
                  </td>
                  <td className="py-1.5 pr-3">
                    <VerdictCell v={v} side="short" />
                  </td>
                  <td className="tnum py-1.5 text-[12.5px] text-dim">{nowText(v.key, report)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 변동성 ─────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          변동성 팽창 <span className="font-normal text-dim">— 판정은 15m·1H, 4H·1D 는 맥락 · 마감 봉 기준</span>
        </h2>
        <div className="mt-3 scroll-x">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="text-xs text-dim">
              <tr>
                <th className="py-1 pr-3 text-left font-medium">TF</th>
                <th className="py-1 pr-3 text-left font-medium">상태</th>
                <th className="py-1 pr-3 text-right font-medium">BB폭 백분위</th>
                <th className="py-1 pr-3 text-right font-medium">ATR 비율</th>
                <th className="py-1 pr-3 text-left font-medium">스퀴즈</th>
                <th className="py-1 text-right font-medium">ATR÷비용</th>
              </tr>
            </thead>
            <tbody>
              {report.volatility.map((v) => {
                const judged = JUDGE_TFS.includes(v.tf);
                return (
                  <tr key={v.tf} className="border-t border-border">
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {v.tf}
                      <span className="ml-1 text-xs text-dim">{judged ? "판정" : "맥락"}</span>
                    </td>
                    <td
                      className={`py-1.5 pr-3 whitespace-nowrap ${
                        !v.state.measured
                          ? "text-dim"
                          : v.state.on
                            ? "text-profit"
                            : v.state.warn
                              ? "text-beta"
                              : ""
                      }`}
                    >
                      {v.label}
                      {v.state.on ? ` · ${SIDE_TEXT[v.state.on]} 켜짐` : ""}
                    </td>
                    <td className="tnum py-1.5 pr-3 text-right">{pct(v.bbwPct, 0)}</td>
                    <td className="tnum py-1.5 pr-3 text-right">{num(v.atrRatio, 2)}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{squeezeText(v)}</td>
                    <td className="tnum py-1.5 text-right">
                      {v.atrOverCost === null ? DASH : `${num(v.atrOverCost, 1)}배`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs leading-snug text-dim">
          켜짐 = 직전 10봉 안 압축 + ATR(5)/ATR(50) ≥ 1.3 + BB폭 3봉 연속 확대 + 종가가 밴드 밖. 경고 = ATR비 ≥ 2.0
          또는 BB폭 백분위 ≥ 95%. ATR÷비용 = ATR(14) ÷ 왕복 수수료(설정 수수료율 × 2).
        </p>
        {report.volatility
          .filter((v) => JUDGE_TFS.includes(v.tf))
          .map((v) => (
            <div key={v.tf} className="mt-2">
              <p className="text-xs font-medium">{v.tf} 근거</p>
              <Reasons reasons={v.state.reasons} />
            </div>
          ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── 감마 ─────────────────────────────── */}
        <section className="rounded-xl border border-border bg-surface p-4">
          <h2 className="text-sm font-medium">
            감마 <span className="font-normal text-dim">— BTC 전용</span>
          </h2>
          {gamma === null ? (
            <p className="mt-3 text-sm text-dim">미확인 — {sources.options === "ok" ? "옵션 행 없음" : sources.options}</p>
          ) : (
            <div className="mt-2">
              <Row
                label="순 GEX 부호"
                value={
                  gamma.netGexNearSpot === null ? "미확인" : gamma.netGexNearSpot >= 0 ? "양(+) · 변동 억제" : "음(−) · 변동 증폭"
                }
                sub={gamma.netGexNearSpot === null ? undefined : `${usdCompact(gamma.netGexNearSpot)}/1%`}
              />
              <Row label="감마 플립" value={gamma.flipStrike === null ? DASH : price(gamma.flipStrike)} />
              <Row
                label="콜 벽"
                value={gamma.callWall === null ? DASH : price(gamma.callWall)}
                sub={gamma.wallDistPct.call === null ? undefined : `위 ${distPct(gamma.wallDistPct.call)}`}
              />
              <Row
                label="풋 벽"
                value={gamma.putWall === null ? DASH : price(gamma.putWall)}
                sub={gamma.wallDistPct.put === null ? undefined : `아래 ${distPct(gamma.wallDistPct.put)}`}
              />
              <Row
                label="대형 만기(48h 안)"
                value={gamma.bigExpiry === null ? "없음" : gamma.bigExpiry.expiry}
                sub={
                  gamma.bigExpiry === null
                    ? undefined
                    : `${num(gamma.bigExpiry.hoursLeft, 0)}시간 · OI ${pct(gamma.bigExpiry.oiShare, 0)}`
                }
              />
              <Reasons reasons={gamma.state.reasons} />
            </div>
          )}
          <p className="mt-2 text-xs leading-snug text-beta">
            부호는 가정(딜러 콜 롱·풋 숏) · Deribit+OKX 합산 — 실제 딜러 포지션은 알 수 없습니다.
          </p>
        </section>

        {/* ── 스퀴즈 연료 ─────────────────────────────── */}
        <section className="rounded-xl border border-border bg-surface p-4">
          <h2 className="text-sm font-medium">
            스퀴즈 연료 <span className="font-normal text-dim">— 펀딩 · 미결제약정 · 가격 24h</span>
          </h2>
          {fuel === null ? (
            <p className="mt-3 text-sm text-dim">미확인 — {sources.derivs}</p>
          ) : (
            <div className="mt-2">
              <Row
                label="펀딩 8h"
                value={fuel.fundingRate === null ? "미확인" : pct(fuel.fundingRate, 4)}
                sub={fuel.fundingAnnual === null ? undefined : `연 ${signedPct(fuel.fundingAnnual, 1)}`}
              />
              <Row
                label="OI 24h"
                value={fuel.oiChg24hPct === null ? "미확인" : `${signed(fuel.oiChg24hPct, 2)}%`}
              />
              <Row label="가격 24h" value={fuel.priceChg24h === null ? "미확인" : signedPct(fuel.priceChg24h, 2)} />
              <Reasons reasons={fuel.state.reasons} />
            </div>
          )}
          <p className="mt-2 text-xs leading-snug text-dim">
            켜짐(롱) = 펀딩 ≤ 0 · 가격 상승 · OI +5% 이상(숏이 쌓인 채 밀림). 연환산 = 8h × 3 × 365, ±30% 넘으면 그쪽
            추가 경고.
          </p>
        </section>
      </div>

      {/* ── 유동성 ─────────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          유동성 공백 <span className="font-normal text-dim">— 1H 20일 거래량 프로파일(0.25% 칸) · 호가 ±0.5%</span>
        </h2>
        {liquidity === null || spot === null ? (
          <p className="mt-3 text-sm text-dim">미확인 — {sources.candles}</p>
        ) : (
          <div className="mt-2 grid gap-x-6 sm:grid-cols-2">
            <div>
              <Row label="위 공백(LVN)까지" value={distPct(liquidity.gapUpDistPct)} />
              <Row label="아래 공백(LVN)까지" value={distPct(liquidity.gapDownDistPct)} />
              <Row
                label="위 다음 HVN 까지"
                value={distPct(nextHvnDistPct(liquidity.hvn, spot, "up"))}
                sub={liquidity.inHvn ? "지금 HVN 제외" : undefined}
              />
              <Row
                label="아래 다음 HVN 까지"
                value={distPct(nextHvnDistPct(liquidity.hvn, spot, "down"))}
                sub={liquidity.inHvn ? "지금 HVN 제외" : undefined}
              />
            </div>
            <div>
              <Row
                label="현재가 칸"
                value={curBin === null ? "프로파일 밖" : `${price(curBin.lo)}–${price(curBin.hi)}`}
                sub={liquidity.inHvn ? "HVN" : undefined}
              />
              <Row
                label="호가 깊이 비율"
                value={liquidity.depthRatio === null ? "미측정" : num(liquidity.depthRatio, 2)}
                sub={liquidity.depthRatio === null ? (sources.book === "ok" ? undefined : sources.book) : "위 매도 ÷ 아래 매수"}
              />
              <Row label="LVN · HVN 구간" value={`${liquidity.lvn.length} · ${liquidity.hvn.length}`} />
            </div>
          </div>
        )}
        {liquidity !== null ? <Reasons reasons={liquidity.state.reasons} /> : null}
        <p className="mt-2 text-xs leading-snug text-dim">
          켜짐(롱) = 현재 칸 HVN 아님 + 위 공백 입구까지 ≤ 0.3% + 깊이비 &lt; 0.5. 숏은 대칭(깊이비 &gt; 2). 바로 위 칸
          HVN 은 롱 추가 경고, 바로 아래 칸 HVN 은 숏 추가 경고.
        </p>
      </section>

      <p className="text-xs text-dim">기준값은 검증 전 시작값 · 투자 조언 아님</p>
    </div>
  );
}
