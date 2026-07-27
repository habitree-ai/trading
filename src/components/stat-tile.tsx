/** KPI 타일 — 차트가 아니라 헤드라인 숫자 하나가 답인 자리. */
export function StatTile({
  label,
  value,
  sub,
  valueClass = "",
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="text-[11px] text-dim">{label}</div>
      <div className={`tnum mt-1 text-xl font-semibold ${valueClass}`}>{value}</div>
      {sub ? <div className="tnum mt-1 text-[11px] text-dim">{sub}</div> : null}
    </div>
  );
}
