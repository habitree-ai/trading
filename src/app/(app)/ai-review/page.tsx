import Link from "next/link";

import { EmptyBook } from "@/components/empty-book";
import { StatTile } from "@/components/stat-tile";
import {
  AI_SECTION_LABEL,
  AI_SEVERITY_LABEL,
  parseAiReviewContent,
  type AiItem,
  type AiSeverity,
} from "@/lib/ai-review";
import { date, dateTime } from "@/lib/format";
import { getActiveBook, listAiReviews } from "@/lib/queries";
import { TONE_CLASS, type Tone } from "@/lib/verdict";

const SEVERITY_TONE: Record<AiSeverity, Tone> = {
  high: "bad",
  mid: "warn",
  low: "neutral",
  info: "neutral",
  good: "good",
};

function ItemCard({ item }: { item: AiItem }) {
  return (
    <li className="rounded-lg border border-border bg-surface-2/40 p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className={`shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-xs ${TONE_CLASS[SEVERITY_TONE[item.severity]]}`}>
          {AI_SEVERITY_LABEL[item.severity]}
        </span>
        <h3 className="text-sm font-medium">{item.title}</h3>
      </div>
      <p className="mt-2 whitespace-pre-line text-sm leading-relaxed">{item.body}</p>
      {item.action ? (
        <p className="mt-2 rounded-md border-l-2 border-accent bg-surface px-2.5 py-1.5 text-sm">
          <span className="mr-1.5 text-xs text-accent">할 일</span>
          {item.action}
        </p>
      ) : null}
      {item.evidence.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.evidence.map((e) => (
            <Link
              key={`${e.tradeId}-${e.label}`}
              href={`/notes?trade=${e.tradeId}`}
              className="tnum rounded border border-border px-1.5 py-0.5 text-xs text-dim hover:border-accent hover:text-accent"
            >
              {e.label}
            </Link>
          ))}
        </div>
      ) : null}
    </li>
  );
}

/**
 * AI 분석 — 사용자가 대화로 지시할 때만 Claude Code 가 만드는 종합 분석의 회차(REQ-0088).
 *
 * 여기서는 만들지도 고치지도 않는다. 자동으로 돌지 않는 것이 요구사항이고, 회차를 만드는
 * 길은 `scripts/ai-review.mjs save` 하나다(절차 `docs/ai-review/README.md`).
 * 회차는 쌓인다 — 같은 기록을 다른 시점에 다시 본 결과를 나란히 두려는 것이다.
 */
export default async function AiReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ round?: string }>;
}) {
  const [book, params] = await Promise.all([getActiveBook(), searchParams]);
  if (!book) return <EmptyBook />;

  const reviews = await listAiReviews(book.id);
  const wanted = Number(params.round);
  const current = reviews.find((r) => r.round === wanted) ?? reviews[0];

  const header = (
    <header>
      <h1 className="text-xl font-semibold tracking-tight">AI 분석</h1>
      <p className="mt-1 text-sm text-dim">
        {book.name} · 지시할 때만 만드는 종합 분석 — 문제·교정·못 본 것을 기술·기본·심리·기준으로 나눠 봅니다.
      </p>
    </header>
  );

  if (!current) {
    return (
      <div className="space-y-6">
        {header}
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          아직 이 북의 분석이 없습니다. Claude Code 에 「AI 분석 만들어줘」라고 지시하면 새 회차가 생깁니다.
        </p>
      </div>
    );
  }

  const parsed = parseAiReviewContent(current.content);

  return (
    <div className="space-y-6">
      {header}

      <nav className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="회차">
        {reviews.map((r) => (
          <Link
            key={r.id}
            href={`/ai-review?round=${r.round}`}
            className={`rounded-full border px-2.5 py-1 ${
              r.id === current.id ? "border-accent text-accent" : "border-border text-dim hover:text-text"
            }`}
          >
            {r.round}회차 · {date(r.generated_at)}
          </Link>
        ))}
      </nav>

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="text-xs text-dim">
          {current.round}회차 · 생성 {dateTime(current.generated_at)} · 거래 {current.trade_count}건
          {current.period_from ? ` · ${date(current.period_from)} ~ ${date(current.period_to)}` : ""}
        </div>
        <h2 className="mt-1 text-base font-semibold">{current.title}</h2>
        {parsed.ok ? (
          <>
            <p className="mt-3 text-sm font-medium leading-relaxed">{parsed.value.headline}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed">
              {parsed.value.state.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      {!parsed.ok ? (
        <p className="rounded-xl border border-loss/40 p-4 text-sm text-loss">
          이 회차의 내용 형식이 맞지 않아 보여줄 수 없습니다 — {parsed.errors.slice(0, 3).join(" · ")}
        </p>
      ) : (
        <>
          {parsed.value.scores.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {parsed.value.scores.map((s) => (
                <StatTile key={s.label} label={s.label} value={s.value} sub={s.note} />
              ))}
            </div>
          ) : null}

          <nav className="flex flex-wrap gap-1.5 text-xs" aria-label="섹션">
            {parsed.value.sections.map((s) => (
              <a key={s.key} href={`#${s.key}`} className="rounded border border-border px-2 py-1 text-dim hover:text-text">
                {AI_SECTION_LABEL[s.key]} {s.items.length}
              </a>
            ))}
          </nav>

          {parsed.value.sections.map((s) => (
            <section key={s.key} id={s.key} className="scroll-mt-20 rounded-xl border border-border bg-surface p-4">
              <h2 className="text-sm font-medium">{AI_SECTION_LABEL[s.key]}</h2>
              <ul className="mt-3 space-y-3">
                {s.items.map((it) => (
                  <ItemCard key={it.title} item={it} />
                ))}
              </ul>
            </section>
          ))}

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border border-border bg-surface p-4">
              <h2 className="text-sm font-medium">다음 회차에 확인할 것</h2>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-relaxed">
                {parsed.value.nextChecks.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ol>
            </section>
            <section className="rounded-xl border border-border bg-surface p-4">
              <h2 className="text-sm font-medium">이 분석의 한계</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-dim">
                {parsed.value.limits.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
