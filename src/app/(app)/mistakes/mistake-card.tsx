import { DASH, num, pct, pnlClass, signed } from "@/lib/format";
import type { MistakeGroup } from "@/lib/mistakes";
import { ACTIONABILITY_HINT } from "@/lib/okx-diagnosis";
import { TONE_CLASS } from "@/lib/verdict";

/**
 * 오답 유형 하나 — 판정 기준 · 증거 · 판정 · 그때 그 거래 순으로 고정한다.
 *
 * 순서를 고정하는 이유는 진단 카드와 같다. 합계 손실만 앞에 세우면 거래가 많았을 뿐인
 * 유형이 늘 1위가 된다. **비교군과의 거래당 차이를 항상 같은 자리**에 두어야
 * "그래서 이게 진짜 오답이냐"에 눈이 먼저 간다.
 */
export function MistakeCard({
  group,
  children,
}: {
  group: MistakeGroup;
  /** 「원칙으로 옮기기」 등 카드 아래에 붙는 것 */
  children?: React.ReactNode;
}) {
  const g = group;
  const controllable = g.control === "entry" || g.control === "exit";

  return (
    <div
      className={`rounded-xl border bg-surface p-4 ${
        g.verdict.tone === "bad"
          ? "border-border border-l-2 border-l-loss"
          : g.verdict.tone === "warn"
            ? "border-border border-l-2 border-l-beta"
            : g.verdict.tone === "good"
              ? "border-border border-l-2 border-l-profit"
              : "border-dashed border-border"
      }`}
    >
      {/* 1. 무엇을 오답이라 부르는가 */}
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5">
        <span className="text-sm font-medium">{g.title}</span>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] ${
              controllable
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-border bg-surface-2 text-dim"
            }`}
            title={ACTIONABILITY_HINT[g.control]}
          >
            {g.controlLabel}
          </span>
        </span>
      </div>

      <p className="mt-1.5 text-[11px] text-dim">판정 기준 — {g.rule}</p>

      {/* 2. 증거 — 비교군과의 거래당 차이가 항상 같은 자리에 온다 */}
      <div className="tnum mt-2 text-[11px] text-dim">
        {num(g.n, 0)}건 · 승률 {pct(g.winRate, 1)}
        {g.baselineWinRate === null ? null : <> (비교군 {pct(g.baselineWinRate, 1)})</>} · 거래당{" "}
        {signed(g.perTrade, 2)}
        {g.gap === null ? null : (
          <>
            {" "}
            (비교군 {signed(g.baselinePerTrade, 2)}, 차이{" "}
            <span className={`font-medium ${pnlClass(g.gap)}`}>{signed(g.gap, 2)}</span>)
          </>
        )}{" "}
        · 합계 <span className={pnlClass(g.sumNet)}>{signed(g.sumNet, 0)}</span>
      </div>

      <div className="tnum mt-1 text-[11px] text-dim">
        {g.baseline ? (
          <>
            비교군 「{g.baseline.label}」 {num(g.baseline.n, 0)}건 · 귀속{" "}
            <span className={pnlClass(g.attributable)}>{signed(g.attributable, 0)}</span>
            <span className="ml-1 text-[10px]">(건수 × 거래당 차이)</span>
          </>
        ) : (
          <>비교군 없음 — 이 유형은 손실 거래에만 붙습니다</>
        )}
      </div>

      {/* 3. 판정 */}
      <p className={`mt-2 text-[11px] leading-snug ${TONE_CLASS[g.verdict.tone]}`}>
        {g.verdict.text}
      </p>

      {/* 4. 그때 그 거래 — 숫자가 사람 기억과 이어지는 유일한 자리 */}
      {g.worst.length > 0 ? (
        <details className="mt-3 border-t border-border pt-2.5">
          <summary className="cursor-pointer text-[11px] text-dim hover:text-text">
            손실이 큰 {g.worst.length}건 보기
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="tnum w-full min-w-[46rem] text-left text-[11px]">
              <thead className="text-dim">
                <tr className="border-b border-border">
                  <th className="py-1 pr-2 font-normal">날짜</th>
                  <th className="py-1 pr-2 font-normal">종목</th>
                  <th className="py-1 pr-2 font-normal">방향</th>
                  <th className="py-1 pr-2 text-right font-normal">레버</th>
                  <th className="py-1 pr-2 text-right font-normal">보유</th>
                  <th className="py-1 pr-2 text-right font-normal">진입가</th>
                  <th className="py-1 pr-2 text-right font-normal">청산가</th>
                  <th className="py-1 pr-2 text-right font-normal">손익</th>
                  <th className="py-1 font-normal">그때 무엇을 보고 들어갔나</th>
                </tr>
              </thead>
              <tbody>
                {g.worst.map((t) => (
                  <tr key={t.id} className="border-b border-border/50 last:border-0">
                    <td className="py-1 pr-2 whitespace-nowrap">
                      {t.day} {String(t.hourKst).padStart(2, "0")}시
                    </td>
                    <td className="py-1 pr-2">{t.symbol}</td>
                    <td className={`py-1 pr-2 ${t.side === "long" ? "text-profit" : "text-loss"}`}>
                      {t.side === "long" ? "롱" : "숏"}
                    </td>
                    <td className="py-1 pr-2 text-right">{t.lever === null ? DASH : `${t.lever}x`}</td>
                    <td className="py-1 pr-2 text-right whitespace-nowrap">{holdText(t.holdMin)}</td>
                    <td className="py-1 pr-2 text-right">{num(t.entryPx, priceDigits(t.entryPx))}</td>
                    <td className="py-1 pr-2 text-right">{num(t.exitPx, priceDigits(t.exitPx))}</td>
                    <td className={`py-1 pr-2 text-right font-medium ${pnlClass(t.net)}`}>
                      {signed(t.net, 0)}
                    </td>
                    <td className="py-1 text-dim">
                      {t.intent ?? DASH}
                      {t.liq ? <span className="ml-1 text-loss">· 강제청산</span> : null}
                      {t.mfeMarginPct !== null && t.mfeMarginPct >= 30 ? (
                        <span className="ml-1 text-beta">· 최대 평가익 +{num(t.mfeMarginPct, 0)}%</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      {children}
    </div>
  );
}

/** 보유 시간 — 분이 세 자리를 넘으면 사람이 못 읽는다. */
function holdText(min: number): string {
  if (min < 60) return `${min}분`;
  if (min < 1440) return `${(min / 60).toFixed(1)}시간`;
  return `${(min / 1440).toFixed(1)}일`;
}

/** 종목마다 자릿수가 다르다 — DOGE 를 소수 둘째 자리로 끊으면 가격이 사라진다. */
function priceDigits(px: number | null): number {
  if (px === null) return 2;
  const abs = Math.abs(px);
  if (abs >= 1000) return 1;
  if (abs >= 1) return 3;
  return 6;
}
