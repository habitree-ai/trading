import { ModeTabs } from "@/app/(app)/system/mode-tabs";
import { MEMBER_LABEL, resolveModes } from "@/app/(app)/system/shared";
import { DASH, dateTime, num } from "@/lib/format";
import { SYSTEM_MODE_META, readSystemDecisions } from "@/lib/system-trading";

/**
 * 판정 로그 — 봇이 매 사이클 무엇을 보고 무엇을 했는지.
 *
 * 신호가 없던 봉도 남는다. "그때 왜 안 들어갔나"에 답할 수 없으면 기준을 고칠 근거가
 * 없기 때문이다. 거래 목록이 결과의 기록이라면 여기는 판단의 기록이다.
 */

const ACTION_META: Record<string, { label: string; cls: string }> = {
  enter: { label: "진입", cls: "border-profit text-profit" },
  skip: { label: "건너뜀", cls: "border-beta text-beta" },
  missed: { label: "놓침", cls: "border-loss text-loss" },
  none: { label: "무신호", cls: "border-border text-dim" },
};

export default async function SystemDecisionsPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode: requested } = await searchParams;
  const selection = await resolveModes(requested);

  if (!selection) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">판정 로그</h1>
        </header>
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          아직 판정 기록이 없습니다.
        </p>
      </div>
    );
  }

  const mode = selection.current;
  const meta = SYSTEM_MODE_META[mode];
  const decisions = await readSystemDecisions(mode, 300);
  const warnings = decisions.filter((d) => d.warn);
  const fired = decisions.filter((d) => d.fired);

  return (
    <div className="space-y-5">
      <header className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">판정 로그</h1>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
              meta.real ? "border-loss text-loss" : "border-alpha text-alpha"
            }`}
          >
            {meta.label}
          </span>
          <p className="tnum text-sm text-dim">
            최근 {decisions.length}줄 · 발화 {fired.length} · 경고 {warnings.length}
          </p>
        </div>
        <ModeTabs items={selection.items} current={mode} />
      </header>

      {warnings.length > 0 ? (
        <section className="rounded-xl border border-loss/40 bg-surface p-4">
          <h2 className="text-sm font-medium text-loss">
            경고 <span className="font-normal text-dim">— 자동 복구가 없는 사건. 손으로 처리해야 한다</span>
          </h2>
          <ul className="mt-2 space-y-1">
            {warnings.map((w, i) => (
              <li key={i} className="tnum text-[12px] text-dim">
                {dateTime(new Date(w.at).toISOString())}
                {w.member ? ` · ${MEMBER_LABEL[w.member] ?? w.member}` : ""} —{" "}
                <span className="text-text">{w.warn}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {decisions.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-dim">
          이 모드에는 판정 기록이 없습니다.
        </p>
      ) : (
        <div className="scroll-x rounded-xl border border-border bg-surface">
          <table className="w-full min-w-[54rem] text-[12.5px]">
            <thead className="border-b border-border text-[11px] text-dim">
              <tr>
                <th className="px-3 py-2 text-left font-medium">시각</th>
                <th className="px-3 py-2 text-left font-medium">기준</th>
                <th className="px-3 py-2 text-left font-medium">봉</th>
                <th className="px-3 py-2 text-left font-medium">발화</th>
                <th className="px-3 py-2 text-left font-medium">행동</th>
                <th className="px-3 py-2 text-left font-medium">사유 / 경고</th>
                <th className="px-3 py-2 text-left font-medium">지표</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((d, i) => {
                const action = ACTION_META[d.action ?? "none"] ?? ACTION_META.none;
                const s = d.indicators;
                const indicators = s
                  ? [
                      s.close !== null ? `종가 ${num(s.close, 0)}` : null,
                      s.rsi !== null ? `RSI ${num(s.rsi, 1)}` : null,
                      s.atr !== null ? `ATR ${num(s.atr, 0)}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : "";
                return (
                  <tr key={i} className={`border-t border-border ${d.warn ? "bg-loss/5" : ""}`}>
                    <td className="tnum px-3 py-1.5 whitespace-nowrap text-dim">
                      {dateTime(new Date(d.at).toISOString()).slice(5)}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {d.member ? (MEMBER_LABEL[d.member] ?? d.member) : DASH}
                    </td>
                    <td className="tnum px-3 py-1.5 whitespace-nowrap text-dim">
                      {d.tf ?? DASH}
                      {d.barTs ? ` ${dateTime(new Date(d.barTs).toISOString()).slice(5, 16)}` : ""}
                    </td>
                    <td className="px-3 py-1.5">
                      {d.fired === null ? DASH : d.fired ? <span className="text-profit">●</span> : <span className="text-dim">○</span>}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] ${action.cls}`}>
                        {action.label}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-[11.5px]">
                      {d.warn ? <span className="text-loss">{d.warn}</span> : (d.skip ?? DASH)}
                    </td>
                    <td className="tnum px-3 py-1.5 text-[11px] whitespace-nowrap text-dim">
                      {indicators || DASH}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
