import { DASH, num, pct, pnlClass, signed } from "@/lib/format";
import {
  ACTIONABILITY_HINT,
  ACTIONABILITY_LABEL,
  type Finding,
} from "@/lib/okx-diagnosis";
import { CONFIDENCE_LABEL, TONE_CLASS } from "@/lib/verdict";

/**
 * 발견 하나 — 주장 · 증거 · 기간 검증 · 판정 · 주의 순으로 고정한다.
 *
 * 기간 검증을 접거나 조건부로 감추지 않는 것이 이 카드의 요점이다. 지금까지의 화면은
 * "얼마를 잃었나"만 보여 줬고, 그래서 거래가 많았을 뿐인 칸이 늘 문제 1위였다. 표본 밖에서도
 * 같은 부호였는지가 항상 같은 자리에 있어야 그 착시가 반복되지 않는다.
 */
export function FindingCard({
  finding,
  twin,
  children,
}: {
  finding: Finding;
  /** 동어반복 라벨의 정직한 쌍둥이 — 있으면 나란히 보여 준다 */
  twin?: Finding | null;
  /** 원칙 씨앗 버튼 등 카드 아래에 붙는 것 */
  children?: React.ReactNode;
}) {
  const f = finding;
  const positive = f.lift > 0;

  return (
    <div
      className={`rounded-xl border bg-surface p-4 ${
        f.confidence === "hypothesis" ? "border-dashed border-border" : "border-border"
      } ${f.confidence === "confirmed" ? (positive ? "border-l-2 border-l-profit" : "border-l-2 border-l-loss") : ""}`}
    >
      {/* 1. 주장 */}
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5">
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-dim">{f.axisLabel}</span>
        <span className="text-sm font-medium">{f.bucket}</span>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <ConfidenceBadge finding={f} />
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] ${
              f.actionability === "entry" || f.actionability === "exit"
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-border bg-surface-2 text-dim"
            }`}
            title={ACTIONABILITY_HINT[f.actionability]}
          >
            {ACTIONABILITY_LABEL[f.actionability]}
          </span>
          {f.tautological ? (
            <span
              className="rounded border border-dashed border-beta/40 px-1.5 py-0.5 text-[10px] text-beta"
              title={f.tautologyReason ?? undefined}
            >
              정의상 참
            </span>
          ) : null}
        </span>
      </div>

      {/* 2. 증거 */}
      <div className="tnum mt-2 text-[11px] text-dim">
        {num(f.n, 0)}건 · 거래당 {signed(f.mean, 2)}
        {f.tautological ? null : (
          <>
            {" "}
            (기준선 {signed(f.mean - f.lift, 2)}, 차이{" "}
            <span className={`font-medium ${pnlClass(f.lift)}`}>{signed(f.lift, 2)}</span>)
          </>
        )}{" "}
        · 합계 <span className={pnlClass(f.sumNet)}>{signed(f.sumNet, 0)}</span>
        {f.winRate === null ? null : <> · 승률 {pct(f.winRate, 1)}</>}
      </div>

      {/* 3. 기간 검증 — 항상 같은 자리 */}
      <div className="tnum mt-1 text-[11px] text-dim">
        기간 검증{" "}
        {f.held === null ? (
          <span className="text-dim">
            없음 — 앞 {num(f.split.inN, 0)}건 / 뒤 {num(f.split.outN, 0)}건으로 한쪽이 얇습니다
          </span>
        ) : (
          <>
            앞 절반 {signed(f.inLift, 2)} ({num(f.split.inN, 0)}건) / 뒤 절반 {signed(f.outLift, 2)} (
            {num(f.split.outN, 0)}건) —{" "}
            <span className={f.held ? "text-profit" : "text-loss"}>
              {f.held ? "부호 유지" : "부호 반전"}
            </span>
          </>
        )}
        {f.t === null ? null : <> · 흔들리는 폭의 {num(Math.abs(f.t), 1)}배</>}
      </div>

      {/* 4. 판정 */}
      <p className={`mt-1.5 text-[11px] leading-snug ${TONE_CLASS[f.verdict.tone]}`}>{f.verdict.text}</p>

      {/* 5. 쌍둥이 대조 — 이 진단의 핵심 */}
      {twin ? (
        <div className="mt-2 rounded-lg border border-beta/40 bg-beta/5 p-2.5 text-[11px] leading-relaxed">
          <span className="text-beta">같은 조건을 승패 무관하게 다시 재면</span>{" "}
          <span className="tnum">
            {twin.axisLabel} {twin.bucket} · {num(twin.n, 0)}건 · 차이{" "}
            <span className={`font-medium ${pnlClass(twin.lift)}`}>{signed(twin.lift, 2)}</span> (
            {CONFIDENCE_LABEL[twin.confidence]})
          </span>
          <span className="text-dim">
            {" "}
            — 손실 거래에만 붙인 라벨이{" "}
            {Math.sign(twin.lift) !== Math.sign(f.lift)
              ? "부호까지 뒤집힙니다. 이 분류는 원인이 아니었습니다."
              : "효과를 거의 만들지 않습니다."}
          </span>
        </div>
      ) : null}

      {/* 6. 주의 */}
      {f.pathDependent && !f.tautological ? (
        <p className="mt-2 text-[11px] leading-snug text-beta">
          이 값은 진입 뒤 가격이 만든 것입니다 — 크게 이긴 거래가 큰 평가익 구간을 지나간 것은 당연하므로,
          차이를 효과로 읽지 말고 아래 조건부 비율로 읽습니다.
        </p>
      ) : null}
      {f.defects.length > 0 ? (
        <p className="mt-1 text-[10.5px] text-dim">
          ⓘ 데이터 결함: {f.defects.join(" · ")} — 아래 「출처와 한계」 참조
        </p>
      ) : null}
      {f.evidence ? <p className="mt-1.5 text-[11px] leading-snug text-dim">{f.evidence}</p> : null}

      {children}
    </div>
  );
}

function ConfidenceBadge({ finding }: { finding: Finding }) {
  const label = CONFIDENCE_LABEL[finding.confidence];
  if (finding.confidence === "hypothesis") {
    return (
      <span
        className="rounded border border-dashed border-beta/50 px-1.5 py-0.5 text-[10px] text-beta"
        title="아직 근거가 모자랍니다 — 다음 회차의 질문입니다"
      >
        {label}
      </span>
    );
  }
  if (finding.confidence === "likely") {
    return (
      <span
        className="rounded border border-border px-1.5 py-0.5 text-[10px]"
        title="표본은 통과했지만 확정 문턱에 못 미칩니다"
      >
        {label}
      </span>
    );
  }
  const good = finding.lift > 0;
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] ${
        good ? "border-profit/40 bg-profit/10 text-profit" : "border-loss/40 bg-loss/10 text-loss"
      }`}
      title="표본·크기·기간 셋을 모두 통과했습니다"
    >
      {label}
    </span>
  );
}

/** 조건부 발견 — 리프트가 아니라 비율이 답인 자리. */
export function ConditionalRow({ finding }: { finding: Finding }) {
  const c = finding.conditional;
  if (!c) return null;

  return (
    <tr className="border-t border-border">
      <td className="py-2 pr-3 text-sm">{finding.axisLabel}</td>
      <td className="tnum py-2 pr-3 text-right text-dim">{num(c.givenN, 0)}건</td>
      <td className="tnum py-2 pr-3 text-right">
        {num(c.thenN, 0)}건{" "}
        <span className="font-medium">
          ({finding.conditionalRate === null ? DASH : pct(finding.conditionalRate, 1)})
        </span>
      </td>
      <td className={`tnum py-2 text-right font-medium ${pnlClass(c.thenSumNet)}`}>
        {signed(c.thenSumNet, 0)}
      </td>
    </tr>
  );
}
