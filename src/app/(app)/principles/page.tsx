import { AutoRuleCard } from "@/app/(app)/principles/auto-rule-card";
import { PrincipleForm } from "@/app/(app)/principles/principle-form";
import { PrincipleRow } from "@/app/(app)/principles/principle-row";
import { EmptyBook } from "@/components/empty-book";
import {
  PRINCIPLE_CATEGORIES,
  PRINCIPLE_CATEGORY_LABEL,
  type Principle,
  type PrincipleCategory,
} from "@/lib/domain";
import { deriveTrades, NO_OUTCOME, summarizePrinciples } from "@/lib/metrics";
import {
  getActiveBook,
  listCashFlows,
  listPrincipleChecksByBook,
  listPrinciples,
  listTrades,
} from "@/lib/queries";
import { TRADE_RULES, judgeTradeRules, summarizeTradeRules } from "@/lib/trade-rules";

/** 묶음마다 무엇을 적는 자리인지 — 빈 칸을 보고도 뭘 쓸지 알 수 있게. */
const CATEGORY_HINT: Record<PrincipleCategory, string> = {
  risk: "얼마를 걸 것인가 — 손실 한도, 레버리지, 분할",
  entry: "언제 들어갈 것인가 — 셋업, 확인 조건",
  exit: "언제 나올 것인가 — 손절, 익절, 보유 기간",
  mental: "무너지는 자리 — 연패, 복수매매, 조급함",
  routine: "매매 전후에 반드시 하는 일",
};

export default async function PrinciplesPage() {
  const book = await getActiveBook();
  if (!book) return <EmptyBook />;

  const [principles, trades, flows, checks] = await Promise.all([
    listPrinciples(book.id),
    listTrades(book.id),
    listCashFlows(book.id),
    listPrincipleChecksByBook(book.id),
  ]);

  const outcomes = summarizePrinciples(deriveTrades(book, trades, flows), checks);
  const activeCount = principles.filter((p) => p.active).length;
  // 기록만으로 판정되는 원칙 — 손 판단을 기다리지 않고 통계가 나온다.
  const autoStats = summarizeTradeRules(trades, judgeTradeRules(trades));

  const byCategory = new Map<PrincipleCategory, Principle[]>();
  for (const p of principles) {
    byCategory.set(p.category, [...(byCategory.get(p.category) ?? []), p]);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">원칙</h1>
        <p className="mt-1 text-sm text-dim">
          {book.name} · 지키기로 정한 규칙 {activeCount}개
          {principles.length > activeCount ? ` (보관 ${principles.length - activeCount}개)` : ""}.
          거래를 열면 이 목록이 체크리스트로 뜹니다.
        </p>
      </header>

      {/* 자동 판정 원칙 — 거래 기록이 곧 판정이라 맨 위에 둔다. 손 원칙과 같은 통계 줄. */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium">
          자동으로 재는 원칙
          <span className="ml-2 text-xs font-normal text-dim">
            손절가·목표가·진입 시각·손익만으로 판정 — 누를 것이 없습니다
          </span>
        </h2>
        {TRADE_RULES.map((rule) => (
          <AutoRuleCard
            key={rule.id}
            rule={rule}
            stats={autoStats.get(rule.id) ?? { judged: 0, broken: 0, brokenPnl: null, brokenTrades: [] }}
            currency={book.base_currency}
          />
        ))}
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">원칙 추가</h2>
        <PrincipleForm bookId={book.id} />
      </section>

      {principles.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          아직 원칙이 없습니다. 지키기로 한 규칙을 한 줄씩 적어 두면, 거래마다 지켰는지
          표시할 수 있고 복기에서 어긴 날의 손익이 모입니다.
        </p>
      ) : (
        PRINCIPLE_CATEGORIES.map((category) => {
          const rows = byCategory.get(category) ?? [];
          if (rows.length === 0) return null;

          return (
            <section key={category} className="space-y-2">
              <h2 className="text-sm font-medium">
                {PRINCIPLE_CATEGORY_LABEL[category]}
                <span className="ml-2 text-xs font-normal text-dim">
                  {CATEGORY_HINT[category]}
                </span>
              </h2>
              {rows.map((p, i) => (
                <PrincipleRow
                  key={p.id}
                  principle={p}
                  stats={outcomes.get(p.id) ?? NO_OUTCOME}
                  isFirst={i === 0}
                  isLast={i === rows.length - 1}
                  currency={book.base_currency}
                />
              ))}
            </section>
          );
        })
      )}
    </div>
  );
}
