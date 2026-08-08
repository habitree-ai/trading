import { TONE_CLASS, type Verdict } from "@/lib/verdict";

/**
 * KPI 타일 — 차트가 아니라 헤드라인 숫자 하나가 답인 자리.
 *
 * `sub`는 그 숫자가 어떻게 나왔는지(산식·구성)를, `verdict`는 그래서 어떤지를 말한다.
 * 둘을 한 줄에 섞으면 사실과 판단이 구분되지 않는다.
 */
export function StatTile({
  label,
  value,
  sub,
  verdict,
  valueClass = "",
}: {
  label: string;
  value: string;
  sub?: string;
  verdict?: Verdict;
  valueClass?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="text-[11px] text-dim">{label}</div>
      <div className={`tnum mt-1 text-xl font-semibold ${valueClass}`}>{value}</div>
      {sub ? <div className="tnum mt-1 text-[11px] text-dim">{sub}</div> : null}
      {verdict ? (
        <div className={`mt-1.5 text-[11px] leading-snug ${TONE_CLASS[verdict.tone]}`}>
          {verdict.text}
        </div>
      ) : null}
    </div>
  );
}
