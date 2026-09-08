import Link from "next/link";

import { MistakeCard } from "@/app/(app)/mistakes/mistake-card";
import { SeedButton } from "@/app/(app)/diagnosis/seed-button";
import { PrincipleForm } from "@/app/(app)/principles/principle-form";
import { PrincipleRow } from "@/app/(app)/principles/principle-row";
import { StatTile } from "@/components/stat-tile";
import { num, pct, pnlClass, signed } from "@/lib/format";
import { deriveTrades, NO_OUTCOME, summarizePrinciples } from "@/lib/metrics";
import {
  byAttributable,
  LIMIT_NOTES,
  loadMistakes,
  seedDraft,
  type MistakeGroup,
} from "@/lib/mistakes";
import { seedTagOf } from "@/lib/okx-diagnosis";
import {
  getActiveBook,
  listCashFlows,
  listPrincipleChecksByBook,
  listPrinciples,
  listTrades,
} from "@/lib/queries";
import { TONE_CLASS } from "@/lib/verdict";

/**
 * 오답노트 — 과거에 무엇을 잘못했고, 그래서 다음 주문에서 무엇을 하지 않을 것인가.
 *
 * `/diagnosis` 가 "무엇이 통계적으로 확정됐나"에 답한다면 여기는 그 답을 **행동 금지 문장**
 * 으로 옮기는 자리다. 그래서 화면의 마지막이 목록이 아니라 「하지 말 것」 편집란이다.
 *
 * 정렬을 합계 손실이 아니라 귀속(건수 × 거래당 차이)으로 하는 것이 이 화면의 요점이다.
 * 합계로 줄 세우면 늘 같은 답이 나온다 — 많이 한 것이 많이 잃었다. 그건 오답이 아니라 산수다.
 */

/** 원칙에 붙는 마커의 이름 공간 — 진단의 발견 id 와 섞이지 않게 접두사를 준다. */
const seedIdOf = (g: MistakeGroup) => `mistake:${g.id}`;

export default async function MistakesPage() {
  const report = loadMistakes();
  const { round } = report;

  /*
   * 북이 없어도 이 화면은 열린다 — 집계본은 정적이고 DB 를 보지 않는다.
   * 북에 매인 것은 「하지 말 것」 목록뿐이라 그 자리만 비운다. (`/diagnosis` 와 같다)
   */
  const book = await getActiveBook();
  const [principles, trades, flows, checks] = book
    ? await Promise.all([
        listPrinciples(book.id),
        listTrades(book.id),
        listCashFlows(book.id),
        listPrincipleChecksByBook(book.id),
      ])
    : [[], [], [], []];

  const outcomes = book ? summarizePrinciples(deriveTrades(book, trades, flows), checks) : new Map();
  const taboos = principles.filter((p) => p.category === "taboo");

  // 유형 id → 이미 옮긴 원칙의 성적. `detail` 의 마커로 잇는다.
  const seededBy = new Map(
    principles.flatMap((pr) => {
      const tag = seedTagOf(pr.detail);
      if (!tag) return [];
      const o = outcomes.get(pr.id);
      return [
        [
          tag,
          { judged: o?.judged ?? 0, broken: o?.broken ?? 0, brokenPnl: o?.brokenPnl ?? null },
        ] as const,
      ];
    }),
  );

  // 판정으로 가른다 — 확인·조짐이 위, 차이 없는 것과 오답이 아닌 것이 아래.
  const controllable = report.groups.filter((g) => g.control !== "outcome");
  const real = controllable
    .filter((g) => g.verdict.tone === "bad" || g.verdict.tone === "warn")
    .sort(byAttributable);
  const noDiff = controllable.filter((g) => g.verdict.tone === "neutral").sort(byAttributable);
  const notMistake = controllable.filter((g) => g.verdict.tone === "good").sort(byAttributable);
  const outcomeGroups = report.groups
    .filter((g) => g.control === "outcome")
    .sort((a, b) => a.sumNet - b.sumNet);

  const confirmedLoss = real
    .filter((g) => g.verdict.tone === "bad")
    .reduce((a, g) => a + (g.attributable ?? 0), 0);

  const seedFor = (g: MistakeGroup) =>
    g.canSeed ? (
      <SeedButton
        findingId={seedIdOf(g)}
        bookId={book?.id ?? null}
        bookName={book?.name ?? null}
        draft={seedDraft(g, round.no, round.generatedAt)}
        seeded={seededBy.get(seedIdOf(g)) ?? null}
      />
    ) : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">오답노트</h1>
        <p className="mt-1 text-sm text-dim">
          회차 {round.no} · OKX 원장 {num(round.tradeCount, 0)}건 ({round.period.from} ~{" "}
          {round.period.to} · {num(round.period.tradingDays, 0)}일). 봇 계정{" "}
          {num(round.excludedBot, 0)}건은 뺐습니다 — 내 손이 낸 주문만 봅니다.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="표본"
          value={`${num(round.tradeCount, 0)}건`}
          sub={`승 ${num(round.totals.wins, 0)}건`}
        />
        <StatTile
          label="순손익"
          value={signed(round.totals.sumNet, 0)}
          sub={`수수료 ${signed(round.totals.sumFee, 0)} · 펀딩 ${signed(round.totals.sumFunding, 0)}`}
          valueClass={pnlClass(round.totals.sumNet)}
        />
        <StatTile
          label="승률"
          value={pct(round.totals.n > 0 ? round.totals.wins / round.totals.n : null, 1)}
          sub={`거래당 ${signed(round.totals.n > 0 ? round.totals.sumNet / round.totals.n : null, 2)}`}
        />
        <StatTile
          label="확인된 오답"
          value={`${real.filter((g) => g.verdict.tone === "bad").length}개`}
          sub={`후보 ${report.groups.length}개 중 · 귀속 ${signed(confirmedLoss, 0)}`}
          valueClass={confirmedLoss < 0 ? "text-loss" : ""}
        />
      </section>

      {/* 빠른매매 — 사용자가 콕 집어 물어본 것이라 유형 카드보다 앞에 둔다. */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          얼마나 들고 있었나
          <span className="ml-2 text-xs font-normal text-dim">
            빠른매매가 어디서부터 나빠지는가 — 보유 시간 구간별 전 이력
          </span>
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="tnum w-full min-w-[34rem] text-left text-xs">
            <thead className="text-dim">
              <tr className="border-b border-border">
                <th className="py-1.5 pr-2 font-normal">보유 시간</th>
                <th className="py-1.5 pr-2 text-right font-normal">건수</th>
                <th className="py-1.5 pr-2 text-right font-normal">승률</th>
                <th className="py-1.5 pr-2 text-right font-normal">거래당</th>
                <th className="py-1.5 pr-2 text-right font-normal">순손익</th>
                <th className="py-1.5 text-right font-normal">수수료</th>
              </tr>
            </thead>
            <tbody>
              {report.holdBuckets.map((b) => (
                <tr key={b.id} className="border-b border-border/50 last:border-0">
                  <td className="py-1.5 pr-2">{b.label}</td>
                  <td className="py-1.5 pr-2 text-right">{num(b.n, 0)}</td>
                  <td className="py-1.5 pr-2 text-right">{pct(b.winRate, 1)}</td>
                  <td className={`py-1.5 pr-2 text-right ${pnlClass(b.perTrade)}`}>
                    {signed(b.perTrade, 2)}
                  </td>
                  <td className={`py-1.5 pr-2 text-right font-medium ${pnlClass(b.sumNet)}`}>
                    {signed(b.sumNet, 0)}
                  </td>
                  <td className="py-1.5 text-right text-dim">{signed(b.sumFee, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 진짜 오답 */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium">
          확인된 오답
          <span className="ml-2 text-xs font-normal text-dim">
            비교군보다 거래당 더 잃었고, 그 차이가 표본 흔들림보다 크다 — 귀속이 큰 순
          </span>
        </h2>
        {real.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-dim">
            비교군과 뚜렷하게 갈리는 유형이 없습니다.
          </p>
        ) : (
          real.map((g) => (
            <MistakeCard key={g.id} group={g}>
              {seedFor(g)}
            </MistakeCard>
          ))
        )}
      </section>

      {/* 착시 — 이 자리가 이 화면에서 가장 중요할 수 있다 */}
      {noDiff.length > 0 || notMistake.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">
            오답처럼 보였지만 아닌 것
            <span className="ml-2 text-xs font-normal text-dim">
              합계 손실은 크지만 비교군과 거래당 차이가 없거나, 오히려 나은 쪽
            </span>
          </h2>
          {[...noDiff, ...notMistake].map((g) => (
            <MistakeCard key={g.id} group={g} />
          ))}
        </section>
      ) : null}

      {/* 결과로 정의된 것 */}
      {outcomeGroups.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">
            결과로 정의된 것
            <span className="ml-2 text-xs font-normal text-dim">
              손실 거래에만 붙는 라벨이라 규칙이 되지 못한다 — 얼마를 잃었는지만 센다
            </span>
          </h2>
          {outcomeGroups.map((g) => (
            <MistakeCard key={g.id} group={g} />
          ))}
        </section>
      ) : null}

      {/* 하지 말 것 — 이 화면이 결국 만들려는 것 */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium">
          하지 말 것
          <span className="ml-2 text-xs font-normal text-dim">
            {book ? `${book.name} · ` : ""}거래를 열면 체크리스트로 뜹니다
          </span>
        </h2>

        {book ? (
          <>
            <div className="rounded-xl border border-border bg-surface p-4">
              <PrincipleForm
                bookId={book.id}
                fixedCategory="taboo"
                titleLabel="하지 말 것 *"
                placeholder="예) 2시간 안에 닫지 않는다"
                submitLabel="추가"
              />
            </div>

            {taboos.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-dim">
                아직 적은 것이 없습니다. 위 카드의 「원칙으로 옮기기」를 누르거나 직접 한 줄씩
                적어 두면, 거래마다 지켰는지 표시할 수 있고 복기에서 어긴 날의 손익이 모입니다.
              </p>
            ) : (
              taboos.map((p, i) => (
                <PrincipleRow
                  key={p.id}
                  principle={p}
                  stats={outcomes.get(p.id) ?? NO_OUTCOME}
                  isFirst={i === 0}
                  isLast={i === taboos.length - 1}
                  currency={book.base_currency}
                />
              ))
            )}
          </>
        ) : (
          <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-dim">
            북을 먼저 만들어야 「하지 말 것」을 적을 수 있습니다.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-border bg-surface p-4 text-[11px] leading-relaxed text-dim">
        <h2 className="text-xs font-medium text-text">출처와 한계</h2>
        <p className="mt-2">
          원본은 <code>{report.source.file}</code> (로컬), 집계본은{" "}
          <code>docs/mistakes/okx-mistakes.json</code>, 생성기는{" "}
          <code>re_sys/mistakes.mjs</code> 입니다. 계정:{" "}
          {report.source.origins.join(" · ")}.
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          {LIMIT_NOTES.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <p className={`mt-2 ${TONE_CLASS.neutral}`}>
          같은 원장을 축 전수로 훑어 FDR 로 거른 것은{" "}
          <Link href="/diagnosis" className="text-accent underline-offset-2 hover:underline">
            매매 진단
          </Link>
          에 있습니다. 여기는 이름이 이미 붙어 있는 오답 후보 {report.groups.length}개만 봅니다.
        </p>
      </section>
    </div>
  );
}
