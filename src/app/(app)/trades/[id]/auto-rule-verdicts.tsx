import { TRADE_RULES, type RuleVerdict } from "@/lib/trade-rules";

/**
 * 이 거래의 자동 판정 — 손 체크리스트 위에 세 줄.
 *
 * 누르는 것이 없다. 기록이 정한 값이라 사람이 뒤집을 수 없고, 뒤집고 싶으면 손절가·목표가를
 * 채우면 된다. 기계가 못 재는 부분(손절선 이동, 목표 도달 후 미익절)은 아래 체크리스트다.
 */
export function AutoRuleVerdicts({ verdicts }: { verdicts: readonly RuleVerdict[] }) {
  if (verdicts.length === 0) return null;
  const broken = verdicts.filter((v) => !v.kept).length;

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-dim">
        자동 판정 {verdicts.length}개
        {broken > 0 ? <span className="ml-1.5 text-loss">· {broken}개 어김</span> : null}
      </p>
      <ul className="space-y-1.5">
        {verdicts.map((v) => {
          const rule = TRADE_RULES.find((r) => r.id === v.rule);
          return (
            <li
              key={v.rule}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2"
            >
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
                  v.kept ? "border-profit/40 text-profit" : "border-loss/40 text-loss"
                }`}
              >
                {v.kept ? "지킴" : "어김"}
              </span>
              <span className={`text-sm ${v.kept ? "" : "text-loss"}`}>{rule?.title ?? v.rule}</span>
              <span className="tnum ml-auto text-[11px] text-dim">{v.reason}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
