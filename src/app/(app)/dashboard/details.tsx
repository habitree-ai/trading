import { TONE_CLASS, type Tone } from "@/lib/verdict";

/**
 * 상세 지표 — 기본은 접혀 있다.
 *
 * 예전 대시보드는 네 층을 전부 펼쳐 놓아, 차트 넷과 표 셋을 지나야 거래 기록에
 * 닿았다. 매일 보는 것은 "지금 얼마인가 · 잘 하고 있나 · 뭘 했나" 셋뿐이고,
 * 비용 구성이나 낙폭 구간은 이상한 낌새가 있을 때 찾아보는 자료다. 그 둘을
 * 같은 높이에 두면 매일 보는 것이 파묻힌다 — 그래서 여기로 접어 넣는다.
 *
 * 접었다고 숨기는 것은 아니다: 안쪽에 주의·위험 판정이 있으면 접힌 채로도
 * 제목 옆에 배지가 뜨고, 자본 점검처럼 손대야 하는 경고는 대시보드 맨 위에 따로 선다.
 */
export function Details({
  tone = "neutral",
  children,
}: {
  /** 안쪽에서 가장 나쁜 판정 — 접힌 채로 열어 볼 이유가 되는 값 */
  tone?: Tone;
  children: React.ReactNode;
}) {
  return (
    <details className="group rounded-xl border border-border bg-surface">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span className="text-dim transition-transform group-open:rotate-90">▸</span>
        상세 지표
        <span className="font-normal text-dim">
          — 기간별 손익 · 낙폭 · 성과 요약 · 자본 점검
        </span>
        {tone === "warn" || tone === "bad" ? (
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] ${
              tone === "bad" ? "border-loss/40 text-loss" : "border-beta/40 text-beta"
            }`}
          >
            {tone === "bad" ? "위험" : "주의"}
          </span>
        ) : null}
      </summary>
      <div className="space-y-4 border-t border-border p-4">{children}</div>
    </details>
  );
}

/** 숫자 묶음 밑에 붙는 설명 한 줄. */
export function Note({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  return <p className={`text-[11px] leading-snug ${TONE_CLASS[tone]}`}>{children}</p>;
}

/** 여럿 중 가장 나쁜 판정 — 접힌 상세의 배지가 이 값을 쓴다. */
export function worstTone(tones: readonly Tone[]): Tone {
  if (tones.includes("bad")) return "bad";
  if (tones.includes("warn")) return "warn";
  if (tones.includes("good")) return "good";
  return "neutral";
}
