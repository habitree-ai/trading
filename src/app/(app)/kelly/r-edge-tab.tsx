import { CumulativeR, RDistribution, RollingEdge } from "@/components/r-edge-charts";
import { StatTile } from "@/components/stat-tile";
import { SIDE_LABEL, type Book, type Side } from "@/lib/domain";
import { EDGE_MIN_SAMPLE, EDGE_VERDICT_LABEL, type EdgeVerdict } from "@/lib/edge";
import { DASH, num, pct, pnlClass, signed } from "@/lib/format";
import { listTrades } from "@/lib/queries";
import { buildREdgeReport } from "@/lib/r-edge-report";
import { R_UNMEASURED_LABEL, tradeR, type RUnmeasuredReason } from "@/lib/r-multiple";
import type { Tone } from "@/lib/verdict";

export interface REdgeFilters {
  from?: string;
  to?: string;
  side?: string;
  symbol?: string;
  setup?: string;
}

const VERDICT_TONE: Record<EdgeVerdict, Tone> = {
  insufficient: "warn",
  undetermined: "neutral",
  positive: "good",
  negative: "bad",
};

const rText = (v: number | null) => (v === null ? DASH : `${signed(v, 2)}R`);

/**
 * R 엣지 탭 — 활성 북의 청산 거래를 R 배수로 모아 "한 거래에 평균 몇 R 을 버는가"를 판정한다(REQ-0089).
 *
 * 켈리 탭(OKX 전 이력 정적 집계)과 달리 앱 DB 의 거래를 읽는다. 승패는 R 배수 부호로 가른다 —
 * 금액 기준 승률(대시보드)과 숫자가 다를 수 있는 이유다(본전·수수료로 진 거래가 여기선 패).
 */
export async function REdgeTab({ book, filters }: { book: Book; filters: REdgeFilters }) {
  // 엣지는 청산 거래만 — 진입 수량은 거래 행에서 나오므로 체결은 읽지 않는다.
  const trades = await listTrades(book.id);

  const symbols = [...new Set(trades.map((t) => t.symbol))].sort();
  const setups = [...new Set(trades.map((t) => (t.setup ?? "").trim()).filter((s) => s !== ""))].sort();

  // 기간은 청산일 기준(한국 시간 날짜) — 엣지는 확정된 거래로만 잰다.
  const fromMs = filters.from ? Date.parse(`${filters.from}T00:00:00+09:00`) : null;
  const toMs = filters.to ? Date.parse(`${filters.to}T23:59:59.999+09:00`) : null;
  const picked = trades.filter((t) => {
    if (filters.side && t.side !== filters.side) return false;
    if (filters.symbol && t.symbol !== filters.symbol) return false;
    if (filters.setup && (t.setup ?? "").trim() !== filters.setup) return false;
    if (fromMs !== null || toMs !== null) {
      if (t.exit_at === null) return false;
      const at = Date.parse(t.exit_at);
      if (fromMs !== null && at < fromMs) return false;
      if (toMs !== null && at > toMs) return false;
    }
    return true;
  });

  const report = buildREdgeReport(picked.map((t) => ({ trade: t, r: tradeR(t) })));
  const { stats, interval, verdict, unmeasured } = report;
  const verdictText =
    verdict === "insufficient"
      ? `표본 ${stats.n}건 — ${EDGE_MIN_SAMPLE}건이 안 돼 판정하지 않습니다.`
      : verdict === "undetermined"
        ? "95% 구간이 0 을 품습니다 — 아직 엣지가 있다고도 없다고도 말할 수 없습니다."
        : verdict === "positive"
          ? "95% 구간 하단이 0 보다 큽니다 — 이 방식에 엣지가 있습니다."
          : "95% 구간 상단이 0 보다 작습니다 — 이 방식은 반복할수록 잃습니다.";

  const SELECT =
    "rounded-lg border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent";
  const reasons = (Object.keys(unmeasured.byReason) as RUnmeasuredReason[]).filter(
    (k) => unmeasured.byReason[k] > 0,
  );

  return (
    <div className="space-y-5">
      {/* 필터는 그림 위 한 줄 — GET 폼이라 주소에 남아 같은 화면을 다시 열 수 있다. */}
      <form className="flex flex-wrap items-center gap-2" method="get">
        <input type="hidden" name="tab" value="r" />
        <label className="text-xs text-dim">
          청산일{" "}
          <input type="date" name="from" defaultValue={filters.from} className={SELECT} aria-label="시작일" />
        </label>
        <span className="text-xs text-dim">~</span>
        <input type="date" name="to" defaultValue={filters.to} className={SELECT} aria-label="종료일" />
        <select name="side" defaultValue={filters.side ?? ""} className={SELECT} aria-label="방향">
          <option value="">전체 방향</option>
          {(["long", "short"] as Side[]).map((s) => (
            <option key={s} value={s}>
              {SIDE_LABEL[s]}
            </option>
          ))}
        </select>
        <select name="symbol" defaultValue={filters.symbol ?? ""} className={SELECT} aria-label="종목">
          <option value="">전체 종목</option>
          {symbols.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select name="setup" defaultValue={filters.setup ?? ""} className={SELECT} aria-label="셋업">
          <option value="">전체 셋업</option>
          {setups.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="submit" className={`${SELECT} text-accent`}>
          적용
        </button>
        <a href="?tab=r" className="text-xs text-dim hover:underline">
          초기화
        </a>
        <span className="ml-auto text-xs text-dim">{book.name}</span>
      </form>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          트레이딩 엣지{" "}
          <span className="font-normal text-dim">— 승률 × 평균수익R − (1 − 승률) × 평균손실R</span>
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="엣지 (R 배수 기준)"
            value={rText(stats.edge)}
            valueClass={pnlClass(stats.edge)}
            sub={`검산(R 배수 평균) ${rText(stats.meanR)}`}
            verdict={{ tone: VERDICT_TONE[verdict], text: `${EDGE_VERDICT_LABEL[verdict]} — ${verdictText}` }}
          />
          <StatTile
            label="표본 N"
            value={`${num(stats.n, 0)}건`}
            sub={
              report.estimated > 0
                ? `추정 손절 ${report.estimated}건 포함(마지막 거래소 손절로 잼)`
                : "모두 계획·처음 본 손절로 잼"
            }
          />
          <StatTile
            label="95% 구간"
            value={interval === null ? DASH : `${signed(interval[0], 2)} ~ ${signed(interval[1], 2)}`}
            sub="부트스트랩 1만 회"
          />
          <StatTile
            label="R 미측정 (제외)"
            value={`${num(unmeasured.count, 0)}건`}
            valueClass={unmeasured.count > 0 ? "text-beta" : ""}
            sub={`순손익 합계 ${signed(unmeasured.net)} USDT`}
          />
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          {[
            ["승률 (R > 0)", `${pct(stats.winRate)} · ${stats.wins}승 ${stats.losses}패`],
            ["평균수익R W̄", rText(stats.avgWinR)],
            ["평균손실R L̄", stats.avgLossR === null ? DASH : `${num(stats.avgLossR, 2)}R`],
            ["손익비 W̄ ÷ L̄", num(stats.payoff, 2)],
            ["본전 승률", pct(stats.breakEvenWinRate)],
            ["수수료 전 엣지 (가격R)", rText(report.edgeBeforeCost)],
            ["평균 비용R", report.avgCostR === null ? DASH : `${num(report.avgCostR, 2)}R`],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-dim">{label}</dt>
              <dd className="tnum">{value}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-3 text-xs leading-relaxed text-dim">
          승패는 R 배수 부호로 가릅니다 — 본전(0R)·수수료로 진 거래는 패입니다. 대시보드의 금액 기준 승률과 다를 수
          있습니다.
          {unmeasured.count > 0 ? (
            <>
              {" "}
              R 미측정 {unmeasured.count}건 제외(순손익 합계 {signed(unmeasured.net)} USDT) —{" "}
              {reasons.map((k) => `${R_UNMEASURED_LABEL[k]} ${unmeasured.byReason[k]}`).join(" · ")}.
              {unmeasured.net > 0 ? " 빠진 거래가 이긴 쪽에 몰려 있으면 위 엣지는 실제보다 낮게 나옵니다." : ""}
            </>
          ) : null}
        </p>
      </section>

      {stats.n > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-xl border border-border bg-surface p-4">
            <h2 className="mb-2 text-sm font-medium">R 배수 분포</h2>
            <RDistribution bins={report.bins} />
          </section>
          <section className="rounded-xl border border-border bg-surface p-4">
            <h2 className="mb-2 text-sm font-medium">
              누적 R <span className="font-normal text-dim">— 청산 순서</span>
            </h2>
            <CumulativeR points={report.points} />
          </section>
          <section className="rounded-xl border border-border bg-surface p-4 lg:col-span-2">
            <h2 className="mb-2 text-sm font-medium">
              이동 엣지 <span className="font-normal text-dim">— 최근 N건의 R 배수 평균</span>
            </h2>
            <RollingEdge points={report.points} />
          </section>
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          조건에 맞는 R 측정 거래가 없습니다.
        </p>
      )}
    </div>
  );
}
