import Link from "next/link";

import { ConditionalRow, FindingCard } from "@/app/(app)/diagnosis/finding-card";
import { SeedButton } from "@/app/(app)/diagnosis/seed-button";
import { StatTile } from "@/components/stat-tile";
import { DASH, num, pnlClass, signed } from "@/lib/format";
import { deriveTrades, summarizePrinciples } from "@/lib/metrics";
import {
  byRank,
  canSeed,
  findingById,
  loadDiagnosis,
  MIN_SAMPLE_NOTE,
  seedDraft,
  seedTagOf,
  type Finding,
} from "@/lib/okx-diagnosis";
import {
  getActiveBook,
  listCashFlows,
  listPrincipleChecksByBook,
  listPrinciples,
  listTrades,
} from "@/lib/queries";
import { readExitGap, readSample, TONE_CLASS } from "@/lib/verdict";

/**
 * 매매 진단 — 과거 이력에서 무엇이 잘못됐고, 무엇을 지켜야 하고, 무엇을 못 보고 있었나.
 *
 * `/kelly` 가 "얼마를 걸어야 하나"에 답한다면 여기는 "무엇을 고쳐야 하나"에 답한다.
 * 셋을 대칭으로 만들지 않는다 — 순손익이 음수인 원장에서 강점이 문제만큼 나올 이유가 없고,
 * 억지로 채우면 진단이 아니라 위로가 된다. 실제로 확정 등급을 받은 발견은 손에 꼽고,
 * 그 사실 자체가 이 화면이 말하는 가장 중요한 것이다.
 *
 * 회차 구조를 처음부터 넣어 둔다 — 회차 2는 데이터만 바뀌면 되고 코드는 그대로다.
 */

/** 발견을 화면의 자리로 나눈다 — 등급이 아니라 성격으로 가른다. */
function partition(findings: Finding[]) {
  const conditional = findings.filter((f) => f.kind === "conditional");
  const tautological = findings.filter((f) => f.tautological);
  const path = findings.filter((f) => f.kind === "axis" && f.pathDependent && !f.tautological);
  const clean = findings.filter((f) => f.kind === "axis" && !f.pathDependent && !f.tautological);

  return {
    conditional,
    tautological,
    path: [...path].sort(byRank),
    confirmed: clean.filter((f) => f.confidence === "confirmed").sort(byRank),
    problems: clean
      .filter((f) => f.confidence !== "confirmed" && f.lift < 0 && f.actionability !== "context")
      .sort(byRank),
    strengths: clean.filter((f) => f.confidence === "confirmed" && f.lift > 0).sort(byRank),
    reversed: clean.filter((f) => f.held === false && f.n >= 100).sort(byRank),
  };
}

export default async function DiagnosisPage() {
  const report = loadDiagnosis();
  const p = partition(report.findings);

  /*
   * 북이 없어도 이 화면은 열린다 — 발견은 정적 집계본이고 DB 를 보지 않는다.
   * `/principles`·`/review` 처럼 EmptyBook 으로 끊으면 진단 전체를 못 보게 된다.
   * 북에 매인 것은 원칙 씨앗뿐이라 그 자리만 비운다.
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
  // 발견 id → 이미 옮긴 원칙의 성적. `detail` 의 마커로 잇는다.
  const seededBy = new Map(
    principles.flatMap((pr) => {
      const tag = seedTagOf(pr.detail);
      if (!tag) return [];
      const o = outcomes.get(pr.id);
      return [[tag, { judged: o?.judged ?? 0, broken: o?.broken ?? 0, brokenPnl: o?.brokenPnl ?? null }] as const];
    }),
  );

  const seedFor = (f: Finding) =>
    canSeed(f) ? (
      <SeedButton
        findingId={f.id}
        bookId={book?.id ?? null}
        bookName={book?.name ?? null}
        draft={seedDraft(f, report.round.no, report.round.generatedAt)}
        seeded={seededBy.get(f.id) ?? null}
      />
    ) : null;

  const marginCohort = report.cohorts.find((c) => c.key === "margin")!;
  const allCohort = report.cohorts.find((c) => c.key === "all")!;

  const giveback20 = report.findings.find((f) => f.id === "exit/giveback20");
  const neverMfe10 = report.findings.find((f) => f.id === "entry/neverMfe10");

  const exitGap = giveback20?.conditional
    ? readExitGap({
        reached: giveback20.conditional.givenN,
        gaveBack: giveback20.conditional.thenN,
        gaveBackPnl: giveback20.conditional.thenSumNet,
        netPnl: allCohort.baseline.sumNet,
        threshold: 0.2,
      })
    : null;

  const confirmedEntry = p.confirmed.filter((f) => f.actionability === "entry");
  const hypotheses = report.findings.filter(
    (f) => f.kind === "axis" && !f.tautological && !f.pathDependent && f.confidence === "hypothesis",
  );

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">매매 진단</h1>
        <p className="mt-1 text-sm text-dim">
          OKX 두 계정의 청산 거래 {num(report.round.tradeCount, 0)}건({report.round.period.from} ~{" "}
          {report.round.period.to})을 축마다 갈라 기준선과 견줬습니다. 회차 {report.round.no} ·{" "}
          {num(report.round.testCount, 0)}개 구간 검정.
          {report.round.question ? ` 이번 회차의 질문: “${report.round.question}”` : ""}
        </p>
        <nav className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-accent">
          <a href="#confirmed">확정된 것</a>
          <a href="#split">손실의 갈래</a>
          <a href="#problems">문제</a>
          <a href="#strengths">가져가야 할 것</a>
          <a href="#blindspots">사각지대</a>
          <a href="#rounds">회차 변화</a>
          <a href="#guide">고도화 가이드</a>
          <a href="#source">출처와 한계</a>
        </nav>
      </header>

      {/* ── 0. 한 줄 진단 ─────────────────────────── */}
      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="순손익"
            value={signed(allCohort.baseline.sumNet, 0)}
            valueClass={pnlClass(allCohort.baseline.sumNet)}
            sub={`청산 ${num(allCohort.baseline.n, 0)}건`}
          />
          <StatTile
            label="거래당 기준선"
            value={signed(allCohort.baseline.sumNet / allCohort.baseline.n, 2)}
            valueClass={pnlClass(allCohort.baseline.sumNet)}
            sub="모든 발견은 이 값과의 차이로 잽니다"
            verdict={readSample(allCohort.baseline.n)}
          />
          <StatTile
            label="확정된 발견"
            value={`${p.confirmed.length}건`}
            sub={`검정 ${num(report.round.testCount, 0)}개 중 · 진입 통제 가능 ${confirmedEntry.length}건`}
          />
          <StatTile
            label="가설로 남은 것"
            value={`${hypotheses.length}건`}
            sub="다음 회차가 답해야 할 질문"
          />
        </div>

        {exitGap ? (
          <div
            className={`mt-3 rounded-lg border p-3 text-[11.5px] leading-relaxed ${
              exitGap.tone === "bad" ? "border-loss/40 bg-loss/5" : "border-beta/40 bg-beta/5"
            }`}
          >
            <p className={TONE_CLASS[exitGap.tone]}>{exitGap.text}</p>
            <p className="mt-1.5 text-dim">
              잃은 금액이 큰 구간은 대개 거래가 많았을 뿐입니다. 아래 모든 순위는 원시 합계가 아니라
              기준선과의 <strong>차이</strong>로 세웠고, 그 차이가 흔들리는 폭을 넘는지까지 봤습니다.
            </p>
          </div>
        ) : null}
      </section>

      {/* ── 1. 확정된 것 ──────────────────────────── */}
      <section id="confirmed" className="scroll-mt-4 rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          확정된 것{" "}
          <span className="font-normal text-dim">
            — 표본·크기·기간 셋을 모두 통과한 발견. 행동을 바꿔도 되는 자리는 여기뿐입니다
          </span>
        </h2>

        {p.confirmed.length === 0 ? (
          <p className="mt-3 text-xs text-dim">없습니다 — 이번 회차에는 셋을 모두 통과한 발견이 없습니다.</p>
        ) : (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {p.confirmed.map((f) => (
              <FindingCard key={f.id} finding={f}>
                {seedFor(f)}
              </FindingCard>
            ))}
          </div>
        )}

        <p className="mt-3 text-[11px] leading-relaxed text-dim">
          진입 시점에 통제 가능한 확정 발견은 <strong>{confirmedEntry.length}건</strong>입니다. 나머지는
          청산 규율로만 바뀝니다 — 즉 이 원장에서 고칠 것은 &ldquo;어디에 들어갈까&rdquo;보다
          &ldquo;언제 나올까&rdquo;에 가깝습니다.
        </p>
      </section>

      {/* ── 2. 손실의 갈래 ────────────────────────── */}
      <section id="split" className="scroll-mt-4 rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          손실의 갈래{" "}
          <span className="font-normal text-dim">
            — 진입이 틀린 손실과 나오지 못한 손실을 가릅니다 (레버 확인된 {num(marginCohort.baseline.n, 0)}건 기준)
          </span>
        </h2>

        <div className="mt-3 scroll-x">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="text-xs text-dim">
              <tr>
                <th className="py-1 text-left font-medium">조건</th>
                <th className="py-1 text-right font-medium">해당 거래</th>
                <th className="py-1 text-right font-medium">그중 결과까지</th>
                <th className="py-1 text-right font-medium">손익 합계</th>
              </tr>
            </thead>
            <tbody>
              {p.conditional.map((f) => (
                <ConditionalRow key={f.id} finding={f} />
              ))}
            </tbody>
          </table>
        </div>

        {giveback20 && neverMfe10 ? (
          <p className="mt-3 text-[11.5px] leading-relaxed text-dim">
            <strong>같은 크기의 두 문제입니다.</strong> 평가익 20%조차 못 간 채 진 거래가{" "}
            <span className={`tnum ${pnlClass(neverMfe10.conditional!.thenSumNet)}`}>
              {signed(neverMfe10.conditional!.thenSumNet, 0)}
            </span>{" "}
            — 이건 진입이 틀린 몫이고 청산 규율로는 줄지 않습니다. 반대로 20%를 넘겼는데 손실로 닫은
            거래가{" "}
            <span className={`tnum ${pnlClass(giveback20.conditional!.thenSumNet)}`}>
              {signed(giveback20.conditional!.thenSumNet, 0)}
            </span>{" "}
            — 이건 방향이 맞았던 거래라 진입 기준을 고쳐도 남습니다.
          </p>
        ) : null}

        {p.conditional.filter(canSeed).length > 0 ? (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {p.conditional.filter(canSeed).map((f) => (
              <div key={f.id} className="rounded-xl border border-border bg-surface-2 p-3">
                <div className="text-[12.5px] font-medium">{f.axisLabel}</div>
                <div className="tnum mt-1 text-[11px] text-dim">
                  {num(f.conditional!.givenN, 0)}건 중 {num(f.conditional!.thenN, 0)}건 · 합계{" "}
                  <span className={pnlClass(f.conditional!.thenSumNet)}>
                    {signed(f.conditional!.thenSumNet, 0)}
                  </span>
                </div>
                {f.evidence ? (
                  <p className="mt-1 text-[11px] leading-snug text-dim">{f.evidence}</p>
                ) : null}
                {seedFor(f)}
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* ── 3. 문제 ──────────────────────────────── */}
      <section id="problems" className="scroll-mt-4 rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          문제{" "}
          <span className="font-normal text-dim">
            — 확정에 못 미친 것들. 문구가 &ldquo;피하라&rdquo;가 아니라 &ldquo;다음 회차에 확인할 것&rdquo;인 이유입니다
          </span>
        </h2>

        {p.problems.length === 0 ? (
          <p className="mt-3 text-xs text-dim">해당 없음</p>
        ) : (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {p.problems.slice(0, 6).map((f) => (
              <FindingCard key={f.id} finding={f} />
            ))}
          </div>
        )}

        {p.problems.length > 6 ? (
          <details className="mt-3 rounded-lg border border-border bg-surface-2">
            <summary className="cursor-pointer list-none px-3 py-2 text-xs text-dim [&::-webkit-details-marker]:hidden">
              ▸ 나머지 {p.problems.length - 6}건 — 심각도순 전체 표
            </summary>
            <div className="scroll-x border-t border-border p-3">
              <FindingTable rows={p.problems.slice(6)} />
            </div>
          </details>
        ) : null}
      </section>

      {/* ── 4. 가져가야 할 것 ─────────────────────── */}
      <section id="strengths" className="scroll-mt-4 rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          가져가야 할 것 <span className="font-normal text-dim">— 확정 등급의 양(+) 발견만</span>
        </h2>

        {p.strengths.length === 0 ? (
          <p className="mt-3 text-[11.5px] leading-relaxed text-dim">
            <strong>없습니다.</strong> 문제를 여럿 찾고 강점도 그만큼 찾을 수는 없습니다 — 순손익이{" "}
            {signed(allCohort.baseline.sumNet, 0)}인 원장이라면 강점이 적은 것이 맞는 결과입니다.
            여기 없는 것을 채우면 진단이 아니라 위로가 됩니다.
          </p>
        ) : (
          <>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {p.strengths.map((f) => (
                <FindingCard key={f.id} finding={f} />
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-dim">
              문제 {p.problems.length}건에 강점 {p.strengths.length}건입니다. 대칭이 아닌 것이 정상입니다.
            </p>
          </>
        )}
      </section>

      {/* ── 5. 사각지대 ──────────────────────────── */}
      <section id="blindspots" className="scroll-mt-4 rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          사각지대{" "}
          <span className="font-normal text-dim">— 안 보여서 사각지대입니다. 가설도 담되 가설이라고 적습니다</span>
        </h2>

        <h3 className="mt-4 text-[13px] font-medium">
          가. 문제로 세고 있었지만 원인이 아니었던 것
        </h3>
        <p className="mt-1 text-[11.5px] leading-relaxed text-dim">
          기존 복기 리포트의 실패 분류는 <strong>패배한 거래에만</strong> 붙습니다. 승률 0%는 결과가
          아니라 정의입니다. 같은 조건을 승패 무관하게 다시 재면 순위가 통째로 달라집니다.
        </p>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {p.tautological
            .filter((f) => f.axis === "failure")
            .sort((a, b) => a.sumNet - b.sumNet)
            .map((f) => (
              <FindingCard key={f.id} finding={f} twin={findingById(report, f.twinId)} />
            ))}
        </div>

        {p.reversed.length > 0 ? (
          <>
            <h3 className="mt-5 text-[13px] font-medium">나. 기간 밖에서 부호가 뒤집힌 것</h3>
            <p className="mt-1 text-[11.5px] leading-relaxed text-dim">
              찾은 구간 안에서만 참이었던 것들입니다. 지우지 않고 남깁니다 — 몇 번 틀렸는지가 사라지면
              다음 발견을 얼마나 믿어야 할지 알 수 없게 됩니다.
            </p>
            <div className="mt-3 scroll-x">
              <FindingTable rows={p.reversed.slice(0, 8)} showSplit />
            </div>
          </>
        ) : null}

        <h3 className="mt-5 text-[13px] font-medium">다. 청산 품질 — 차이가 아니라 비율로 읽는 축</h3>
        <p className="mt-1 text-[11.5px] leading-relaxed text-dim">
          보유시간·평가익·역행폭은 진입 뒤 가격이 만든 값입니다. 크게 이긴 거래가 큰 평가익 구간을
          지나간 것은 당연하므로 이 축의 차이를 효과로 읽으면 순환 논리가 됩니다. 순위에서 빼고 여기
          따로 둡니다.
        </p>
        <div className="mt-3 scroll-x">
          <FindingTable rows={p.path.slice(0, 10)} />
        </div>
      </section>

      {/* ── 6. 회차 변화 ─────────────────────────── */}
      <section id="rounds" className="scroll-mt-4 rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">
          회차별 변화 <span className="font-normal text-dim">— 지난 회차와 무엇이 달라졌나</span>
        </h2>
        {report.history.length === 0 ? (
          <p className="mt-3 text-[11.5px] leading-relaxed text-dim">
            회차 {report.round.no}입니다 — 비교할 이전 회차가 없습니다. 다음 회차부터 발견마다 차이와
            등급이 어떻게 움직였는지가 여기 쌓입니다. 사라진 발견도 지우지 않고 남깁니다.
          </p>
        ) : (
          <p className="mt-3 text-[11.5px] text-dim">
            보존된 회차 {report.history.length}개 — 발견별 추이는 다음 단계에서 표로 붙습니다.
          </p>
        )}
      </section>

      {/* ── 7. 고도화 가이드 ─────────────────────── */}
      <section id="guide" className="scroll-mt-4 rounded-xl border border-border bg-surface-2 p-4">
        <h2 className="text-sm font-medium">이 진단을 고도화하는 법</h2>
        <ol className="mt-3 list-decimal space-y-2.5 pl-5 text-[11.5px] leading-relaxed text-dim">
          <li>
            <strong className="text-text">회차를 돌린다.</strong>{" "}
            <code className="rounded bg-surface px-1">node re_sys/manual-fetch.mjs</code> →{" "}
            <code className="rounded bg-surface px-1">manual-analyze.mjs</code> →{" "}
            <code className="rounded bg-surface px-1">diagnose.mjs --round &quot;질문&quot;</code>.
            새 청산이 <strong>250건 이상</strong> 쌓였을 때만 돌립니다 — 그 아래에서는 차이가 흔들리는
            폭에 묻혀 무엇이 달라졌는지 갈리지 않습니다.
          </li>
          <li>
            <strong className="text-text">먼저 볼 곳은 회차 변화입니다.</strong> 새 문제를 찾기 전에
            지난 회차의 확정 항목이 이번에도 확정인지를 봅니다. 등급이 내려간 항목이 있으면 그건
            발견이 아니었습니다.
          </li>
          <li>
            <strong className="text-text">해결로 적는 기준 — 둘 다 참일 때만.</strong> ① 차이가 흔들리는
            폭 안으로 들어왔다 ② 그 구간의 <strong>거래 수가 줄었다</strong>(피했다는 증거). 거래 수가
            그대로인데 차이만 줄었다면 고친 게 아니라 흔들린 것입니다.
          </li>
          <li>
            <strong className="text-text">스스로를 속이지 않는 네 가지.</strong>
            <ul className="mt-1.5 list-disc space-y-1 pl-4">
              <li>버킷 경계를 결과를 보고 다시 자르지 않습니다 — 옮기면 원하는 결론은 언제나 나옵니다.</li>
              <li>틀린 발견을 지우지 않습니다. 「부호 반전」으로 남깁니다.</li>
              <li>결과로 정의된 분류가 줄어든 것을 성과로 세지 않습니다 — 손실이 줄었다는 말의 반복입니다.</li>
              <li>
                축을 늘리면 검정 수가 늘어 우연한 확정도 늘어납니다. 이번 회차는{" "}
                {num(report.round.testCount, 0)}개를 검정했습니다.
              </li>
            </ul>
          </li>
        </ol>

        {hypotheses.length > 0 ? (
          <>
            <h3 className="mt-4 text-[13px] font-medium">
              다음 회차가 답해야 할 질문 — 가설 {hypotheses.length}건 중 금액이 큰 순
            </h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[11.5px] text-dim">
              {[...hypotheses]
                .sort((a, b) => Math.abs(b.attributable) - Math.abs(a.attributable))
                .slice(0, 5)
                .map((f) => (
                  <li key={f.id}>
                    <span className="text-text">
                      {f.axisLabel} · {f.bucket}
                    </span>{" "}
                    <span className="tnum">
                      ({num(f.n, 0)}건, 차이 {signed(f.lift, 2)})
                    </span>{" "}
                    — 표본이 더 쌓이면 등급이 정해집니다
                  </li>
                ))}
            </ul>
          </>
        ) : null}
      </section>

      {/* ── 8. 출처와 한계 ───────────────────────── */}
      <section
        id="source"
        className="scroll-mt-4 rounded-xl border border-border bg-surface-2 p-4 text-[11.5px] leading-relaxed text-dim"
      >
        <h2 className="text-sm font-medium text-text">출처와 한계</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-4">
          <li>
            원장: {report.source.origins.join(" · ")} — 종목 {num(report.source.symbols, 0)}개.
            {report.source.analyzedAt ? ` ${report.source.analyzedAt.slice(0, 10)} 분석분` : ""}
          </li>
          <li>
            <strong>다중비교</strong> — 이번 회차는 {num(report.round.testCount, 0)}개 구간을 한꺼번에
            검정했습니다. 관행값(흔들리는 폭의 2배)을 쓰면 우연히 통과하는 칸이 여럿 나오므로, 확정은{" "}
            <strong>3배</strong>를 요구하고 표본 100건과 기간 검증 통과를 함께 봅니다. 그래도 우연히
            섞인 것이 있을 수 있습니다.
          </li>
          <li>
            <strong>기준선을 셋으로 나눴습니다</strong> —{" "}
            {report.cohorts
              .map((c) => `${c.label} ${num(c.baseline.n, 0)}건 거래당 ${signed(c.baseline.sumNet / c.baseline.n, 2)}`)
              .join(" · ")}
            . {MIN_SAMPLE_NOTE}
          </li>
          {report.defects.map((d) => (
            <li key={d.key}>
              <strong>{d.label}</strong> — {d.effect}
            </li>
          ))}
          <li>
            축마다 판정할 수 있는 거래 수가 다릅니다:{" "}
            {report.coverage
              .filter((c) => c.covered !== c.total)
              .map((c) => `${c.axis} ${num(c.covered, 0)}/${num(c.total, 0)}`)
              .join(" · ") || "전 축 전건 판정 가능"}
          </li>
          <li>
            갱신: <code className="rounded bg-surface px-1">node re_sys/diagnose.mjs</code> — 원본은
            로컬에만 있고 집계본(
            <code className="rounded bg-surface px-1">docs/diagnosis/okx-diagnosis.json</code>)만
            저장소에 들어갑니다. 산식·문턱은 집계본이 아니라{" "}
            <code className="rounded bg-surface px-1">src/lib/okx-diagnosis.ts</code> 와{" "}
            <code className="rounded bg-surface px-1">verdict.ts</code> 에 있습니다 — 문턱을 고치면
            보존된 과거 회차까지 같은 기준으로 다시 매겨집니다.
          </li>
          <li>
            이미 일어난 거래의 통계적 재계산입니다. 앞으로의 수익을 예측하지 않으며 투자 판단을
            대신하지 않습니다. 자세한 운영 규칙은{" "}
            <code className="rounded bg-surface px-1">docs/diagnosis/README.md</code> 에 있습니다.
          </li>
        </ul>
        <p className="mt-3">
          <Link href="/kelly" className="text-accent">
            과거데이터 분석(켈리) →
          </Link>
        </p>
      </section>
    </div>
  );
}

/** 카드로 다 못 싣는 발견을 표로. */
function FindingTable({ rows, showSplit = false }: { rows: Finding[]; showSplit?: boolean }) {
  return (
    <table className="w-full min-w-[36rem] text-sm">
      <thead className="text-xs text-dim">
        <tr>
          <th className="py-1 text-left font-medium">축 · 구간</th>
          <th className="py-1 text-right font-medium">거래</th>
          <th className="py-1 text-right font-medium">차이</th>
          {showSplit ? (
            <>
              <th className="py-1 text-right font-medium">앞 절반</th>
              <th className="py-1 text-right font-medium">뒤 절반</th>
            </>
          ) : (
            <th className="py-1 text-right font-medium">흔들리는 폭 대비</th>
          )}
          <th className="py-1 text-right font-medium">귀속 금액</th>
          <th className="py-1 text-right font-medium">등급</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((f) => (
          <tr key={f.id} className="border-t border-border">
            <td className="max-w-[16rem] truncate py-1.5" title={`${f.axisLabel} · ${f.bucket}`}>
              <span className="text-dim">{f.axisLabel}</span> {f.bucket}
            </td>
            <td className="tnum py-1.5 text-right text-dim">{num(f.n, 0)}</td>
            <td className={`tnum py-1.5 text-right font-medium ${pnlClass(f.lift)}`}>
              {signed(f.lift, 2)}
            </td>
            {showSplit ? (
              <>
                <td className={`tnum py-1.5 text-right ${pnlClass(f.inLift)}`}>{signed(f.inLift, 2)}</td>
                <td className={`tnum py-1.5 text-right ${pnlClass(f.outLift)}`}>{signed(f.outLift, 2)}</td>
              </>
            ) : (
              <td className="tnum py-1.5 text-right text-dim">
                {f.t === null ? DASH : `${num(Math.abs(f.t), 1)}배`}
              </td>
            )}
            <td className={`tnum py-1.5 text-right ${pnlClass(f.attributable)}`}>
              {signed(f.attributable, 0)}
            </td>
            <td className="py-1.5 text-right text-[11px] text-dim">
              {f.confidence === "confirmed" ? "확정" : f.confidence === "likely" ? "유력" : "가설"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
