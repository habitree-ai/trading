import { EmptyBook } from "@/components/empty-book";
import { StatTile } from "@/components/stat-tile";
import { PRINCIPLE_CATEGORY_LABEL, SIDE_LABEL, type Side } from "@/lib/domain";
import { DASH, num, pct, pnlClass, signed, signedPct } from "@/lib/format";
import {
  computeMetrics,
  deriveTrades,
  groupPerformance,
  summarizePrinciples,
  type BookMetrics,
  type GroupPerformance,
} from "@/lib/metrics";
import {
  getActiveBook,
  listCashFlows,
  listPrincipleChecksByBook,
  listPrinciples,
  listTrades,
} from "@/lib/queries";
import { readKelly, readKellyFit, RELIABLE_SAMPLE, TONE_CLASS } from "@/lib/verdict";

const LENSES = [
  { field: "emotion", title: "감정별", hint: "시트의 `감정` 칸 — 무너지는 지점을 찾는다" },
  { field: "setup", title: "기준(셋업)별", hint: "시트의 `기준` 칸 — 어떤 셋업이 돈을 버는가" },
  { field: "rationale", title: "근거별", hint: "시트의 `근거` 칸" },
  { field: "symbol", title: "종목별", hint: "" },
  { field: "side", title: "방향별", hint: "롱/숏 편향" },
] as const;

export default async function ReviewPage() {
  const book = await getActiveBook();
  if (!book) return <EmptyBook />;

  const [trades, flows, principles, checks] = await Promise.all([
    listTrades(book.id),
    listCashFlows(book.id),
    listPrinciples(book.id),
    listPrincipleChecksByBook(book.id),
  ]);

  const derived = deriveTrades(book, trades, flows);
  const m = computeMetrics(book, derived, flows);
  const outcomes = summarizePrinciples(derived, checks);

  // 어겼을 때 가장 많이 잃은 원칙이 위로 온다 — 다음에 무엇부터 지켜야 하는지가 순서다.
  const principleRows = principles
    .map((p) => ({ principle: p, outcome: outcomes.get(p.id) }))
    .filter((r) => r.outcome !== undefined && r.outcome.judged > 0)
    .sort((a, b) => (a.outcome!.brokenPnl ?? 0) - (b.outcome!.brokenPnl ?? 0));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">복기 분석</h1>
        <p className="mt-1 text-sm text-dim">
          {book.name} · 손실이 큰 묶음이 위로 옵니다.
        </p>
      </header>

      {derived.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          거래가 쌓이면 감정·셋업·근거별로 성과가 갈라집니다.
        </p>
      ) : (
        <>
          <KellyCard m={m} currency={book.base_currency} />

          <section className="rounded-xl border border-border bg-surface p-4">
            <h2 className="text-sm font-medium">
              원칙별{" "}
              <span className="ml-1 text-xs font-normal text-dim">
                어겼을 때 얼마를 잃었는지 — 판단을 남긴 거래만 셉니다
              </span>
            </h2>

            {principleRows.length === 0 ? (
              <p className="mt-3 text-xs text-dim">
                아직 원칙 준수를 판단한 거래가 없습니다. 거래를 열면 원칙 체크리스트가 뜹니다.
              </p>
            ) : (
              <div className="mt-3 scroll-x">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead className="text-xs text-dim">
                    <tr>
                      <th className="py-1 text-left font-medium">원칙</th>
                      <th className="py-1 text-right font-medium">판단</th>
                      <th className="py-1 text-right font-medium">지킴</th>
                      <th className="py-1 text-right font-medium">
                        어겼을 때 ({book.base_currency})
                      </th>
                      <th className="py-1 text-right font-medium">
                        지켰을 때 ({book.base_currency})
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {principleRows.map(({ principle, outcome }) => {
                      const o = outcome!;
                      return (
                        <tr key={principle.id} className="border-t border-border">
                          <td className="py-1.5">
                            <span className="mr-1.5 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-dim">
                              {PRINCIPLE_CATEGORY_LABEL[principle.category]}
                            </span>
                            <span className={principle.active ? "" : "text-dim"}>
                              {principle.title}
                            </span>
                          </td>
                          <td className="tnum py-1.5 text-right text-dim">{o.judged}건</td>
                          <td className="tnum py-1.5 text-right">
                            {pct((o.judged - o.broken) / o.judged, 0)}
                          </td>
                          <td className={`tnum py-1.5 text-right font-medium ${pnlClass(o.brokenPnl)}`}>
                            {o.brokenPnl === null ? DASH : `${signed(o.brokenPnl, 1)} (${o.broken}건)`}
                          </td>
                          <td className={`tnum py-1.5 text-right ${pnlClass(o.keptPnl)}`}>
                            {o.keptPnl === null
                              ? DASH
                              : `${signed(o.keptPnl, 1)} (${o.judged - o.broken}건)`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            {LENSES.map((lens) => (
              <LensTable
                key={lens.field}
                title={lens.title}
                hint={lens.hint}
                rows={groupPerformance(derived, lens.field)}
                currency={book.base_currency}
                formatKey={
                  lens.field === "side"
                    ? (k) => SIDE_LABEL[k as Side] ?? k
                    : undefined
                }
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 켈리 기준 — 과거 청산 거래에서 추정한 "한 거래에서 잃어도 되는 자금 비율".
 *
 * 대시보드는 답(비율·금액)만 보여 준다. 여기는 그 답이 어디서 나왔는지를 편다 —
 * 산식과 입력값을 같이 두어야 승률 한 건이 바뀌었을 때 켈리가 왜 움직였는지 되짚을 수 있다.
 */
function KellyCard({ m, currency }: { m: BookMetrics; currency: string }) {
  const kelly = readKelly(m.kelly, m.closedCount);
  const fit = readKellyFit(m.kelly, m.avgLossPctOfEquity);
  // 켈리가 0 이하면 걸 폭이 없다 — 분수 켈리도 0 이다.
  const positive = m.kelly === null ? null : Math.max(m.kelly, 0);
  const amount = (fraction: number | null) =>
    fraction === null || m.finalEquity <= 0 ? DASH : `${num(fraction * m.finalEquity, 2)} ${currency}`;

  const inputs: { label: string; value: string; hint: string }[] = [
    { label: "승률 W", value: pct(m.winRate), hint: `${m.wins}승 ÷ (${m.wins}승 + ${m.losses}패) — 본전은 제외` },
    {
      label: "손익비 b",
      value: num(m.payoffRatio, 2),
      hint: `평균수익 ${num(m.avgWin, 1)} ÷ 평균손실 ${num(m.avgLoss, 1)} — 수수료·펀딩비를 뺀 실현손익`,
    },
    { label: "표본 n", value: `${m.closedCount}건`, hint: `청산 완료 거래만 · ${RELIABLE_SAMPLE}건부터 믿고 봅니다` },
    {
      label: "기대치",
      value: m.expectancy === null ? DASH : `${signed(m.expectancy, 2)} R`,
      hint: "W × b − (1 − W) — 켈리는 이 값을 b 로 나눈 것과 같습니다",
    },
  ];

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h2 className="text-sm font-medium">
        켈리 기준{" "}
        <span className="ml-1 text-xs font-normal text-dim">
          과거 청산 거래로 추정한, 한 거래에서 잃어도 되는 자금 비율의 상한
        </span>
      </h2>

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="켈리 비율 (f*)"
          value={signedPct(m.kelly)}
          valueClass={pnlClass(m.kelly)}
          sub={`손실 한도 ≈ ${amount(positive)}`}
          verdict={kelly}
        />
        <StatTile
          label="½ 켈리 — 실전 상한"
          value={pct(positive === null ? null : positive / 2)}
          sub={`손실 한도 ≈ ${amount(positive === null ? null : positive / 2)}`}
        />
        <StatTile
          label="¼ 켈리 — 보수"
          value={pct(positive === null ? null : positive / 4)}
          sub={`손실 한도 ≈ ${amount(positive === null ? null : positive / 4)}`}
        />
        <StatTile
          label="실제로 잃어 온 폭"
          value={pct(m.avgLossPctOfEquity)}
          sub="손실 거래의 |손익| ÷ 진입 직전 자금 평균"
          verdict={fit}
        />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <div className="text-[11px] text-dim">산식</div>
          <div className="tnum mt-1 text-sm">f* = W − (1 − W) ÷ b</div>
          <dl className="mt-2 space-y-1.5">
            {inputs.map((row) => (
              <div key={row.label} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <dt className="w-16 shrink-0 text-dim">{row.label}</dt>
                <dd className="tnum font-medium">{row.value}</dd>
                <dd className="text-[11px] text-dim">{row.hint}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="rounded-lg border border-border bg-surface-2 p-3 text-[11px] leading-relaxed text-dim">
          <div className="text-dim">읽는 법</div>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            <li>
              f* 는 장기 성장률을 최대로 하는 손실 폭입니다. 그 지점을 넘기면 거는 만큼 성장률이
              깎이고, 2배를 넘기면 기대치가 양수여도 자금이 줄어듭니다.
            </li>
            <li>
              승률·손익비는 추정값이라 f* 그대로는 과합니다. 실전은 ½ 켈리를 상한으로, 추정이
              흔들리면 ¼ 켈리로 봅니다.
            </li>
            <li>
              손실 한도 금액은 현재자금 {num(m.finalEquity, 2)} {currency} 기준입니다 — 손절에
              걸렸을 때 빠져나갈 금액이 이 안이면 됩니다.
            </li>
            <li className={TONE_CLASS[fit.tone]}>{fit.text}</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function LensTable({
  title,
  hint,
  rows,
  currency,
  formatKey = (k) => k,
}: {
  title: string;
  hint: string;
  rows: GroupPerformance[];
  currency: string;
  formatKey?: (key: string) => string;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h2 className="text-sm font-medium">
        {title}
        {hint ? <span className="ml-2 font-normal text-xs text-dim">{hint}</span> : null}
      </h2>
      <div className="mt-3 scroll-x">
        <table className="w-full text-sm">
          <thead className="text-xs text-dim">
            <tr>
              <th className="py-1 text-left font-medium">항목</th>
              <th className="py-1 text-right font-medium">거래</th>
              <th className="py-1 text-right font-medium">승률</th>
              <th className="py-1 text-right font-medium">손익비</th>
              <th className="py-1 text-right font-medium">켈리</th>
              <th className="py-1 text-right font-medium">평균</th>
              <th className="py-1 text-right font-medium">누적 ({currency})</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-border">
                <td className="max-w-[14rem] truncate py-1.5" title={r.key}>
                  {formatKey(r.key)}
                </td>
                <td className="tnum py-1.5 text-right text-dim">
                  {r.count}
                  <span className="ml-1 text-[11px]">
                    ({r.wins}/{r.losses})
                  </span>
                </td>
                <td className="tnum py-1.5 text-right">{pct(r.winRate)}</td>
                <td className="tnum py-1.5 text-right">{num(r.payoffRatio, 2)}</td>
                {/* 표본이 얇은 묶음의 켈리는 흐리게 — 숫자는 나오지만 믿을 근거가 없다. */}
                <td
                  className={`tnum py-1.5 text-right ${
                    r.wins + r.losses < RELIABLE_SAMPLE ? "text-dim" : pnlClass(r.kelly)
                  }`}
                >
                  {signedPct(r.kelly)}
                </td>
                <td className={`tnum py-1.5 text-right ${pnlClass(r.avgPnl)}`}>
                  {r.avgPnl === null ? "—" : signed(r.avgPnl, 1)}
                </td>
                <td className={`tnum py-1.5 text-right font-medium ${pnlClass(r.netPnl)}`}>
                  {signed(r.netPnl, 1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? <p className="mt-2 text-xs text-dim">데이터 없음</p> : null}
      <p className="mt-2 text-[11px] text-dim">
        총 {num(rows.reduce((a, r) => a + r.count, 0), 0)}건 · 켈리는 승·패가 모두 있는 묶음만,{" "}
        {RELIABLE_SAMPLE}건 미만은 흐리게
      </p>
    </section>
  );
}
