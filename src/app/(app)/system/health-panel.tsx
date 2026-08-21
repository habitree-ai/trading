import type { SystemHealth } from "@/lib/system-health";
import { TONE_CLASS, type Tone } from "@/lib/verdict";

/**
 * 운전 상태와 점검 — "봇이 돌고 있나"에 화면이 답하는 자리.
 *
 * 성적표(잔고·승률)는 봇이 정상이라는 전제 위에서만 뜻이 있다. 멈춘 봇의 곡선은
 * 평평하지, 나쁘지 않다 — 그래서 이 판이 성적 위쪽에 있다. 판정은 하지 않고
 * `assessSystemHealth` 가 낸 결과를 그리기만 한다.
 */

/** 색만으로는 못 읽는 사람이 있다 — 점 옆에 말로도 붙여 둔다. */
const TONE_TEXT: Record<Tone, string> = {
  good: "정상",
  warn: "주의",
  bad: "이상",
  neutral: "참고",
};

/** 헤더에 세우는 한 마디 — 모드 배지 옆에서 "지금 도는가"가 바로 읽히게. */
export function RunBadge({ health }: { health: SystemHealth }) {
  return (
    <span
      className={`rounded border border-current px-1.5 py-0.5 text-[10px] font-semibold ${TONE_CLASS[health.runTone]}`}
    >
      {health.runLabel}
    </span>
  );
}

export function HealthPanel({ health }: { health: SystemHealth }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2 className="text-sm font-medium">운전 상태</h2>
        <RunBadge health={health} />
        <p className="text-[12px] text-dim">{health.runDetail}</p>
      </div>

      <dl className="mt-3 grid gap-x-6 sm:grid-cols-2">
        {health.checks.map((c) => (
          <div key={c.id} className="flex gap-2 border-t border-border py-2">
            <span className={`mt-[3px] text-[8px] leading-none ${TONE_CLASS[c.tone]}`} aria-hidden>
              ●
            </span>
            <div className="min-w-0">
              <dt className="flex flex-wrap items-baseline gap-x-1.5 text-[12px]">
                <span className="text-dim">{c.label}</span>
                <span className={`tnum font-medium ${TONE_CLASS[c.tone]}`}>{c.value}</span>
                <span className="sr-only">({TONE_TEXT[c.tone]})</span>
              </dt>
              <dd className="mt-0.5 text-[11px] leading-relaxed text-dim">{c.detail}</dd>
            </div>
          </div>
        ))}
      </dl>
    </section>
  );
}
