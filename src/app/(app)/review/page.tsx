import { EmptyBook } from "@/components/empty-book";
import { PRINCIPLE_CATEGORY_LABEL, SIDE_LABEL, type Side } from "@/lib/domain";
import { DASH, num, pct, pnlClass, signed } from "@/lib/format";
import {
  deriveTrades,
  groupPerformance,
  summarizePrinciples,
  type GroupPerformance,
} from "@/lib/metrics";
import {
  getActiveBook,
  listCashFlows,
  listPrincipleChecksByBook,
  listPrinciples,
  listTrades,
} from "@/lib/queries";

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
              <div className="mt-3 overflow-x-auto">
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
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-dim">
            <tr>
              <th className="py-1 text-left font-medium">항목</th>
              <th className="py-1 text-right font-medium">거래</th>
              <th className="py-1 text-right font-medium">승률</th>
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
        총 {num(rows.reduce((a, r) => a + r.count, 0), 0)}건
      </p>
    </section>
  );
}
