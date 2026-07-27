import { EmptyBook } from "@/components/empty-book";
import { GOAL_METRICS } from "@/lib/domain";
import { getActiveBook } from "@/lib/queries";

export default async function GoalsPage() {
  const book = await getActiveBook();
  if (!book) return <EmptyBook />;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">목표</h1>
        <p className="mt-1 text-sm text-dim">
          {book.name} · 계획 β(반드시 지킬 기준)와 목표 α(도전 기준)를 2중으로 관리합니다.
        </p>
      </header>

      <section className="rounded-xl border border-dashed border-border p-6">
        <p className="text-sm text-dim">
          목표 설정과 링 게이지는 <b className="text-text">M4</b>에서 붙습니다. 관리 예정 지표:
        </p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {Object.entries(GOAL_METRICS).map(([key, meta]) => (
            <li key={key} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm">
              {meta.label}
              <span className="ml-2 text-xs text-dim">
                {meta.higherIsBetter ? "높을수록 좋음" : "낮을수록 좋음"} · {meta.unit}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
