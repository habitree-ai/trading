import { TONE_CLASS, type Tone } from "@/lib/verdict";

/**
 * 대시보드의 한 층.
 *
 * 지표를 한 줄로 늘어놓으면 무엇을 먼저 봐야 하는지가 화면에 없다. 묻는 질문이
 * 다른 것끼리 층을 나눈다 — 지금 얼마인가 / 잘 벌고 있나 / 얼마나 위험한가 /
 * 돈이 어디로 드나들었나. 층마다 가장 나쁜 판정을 제목 옆에 올려, 접힌 채로도
 * 어느 층을 열어 봐야 하는지 보이게 한다.
 */
export function Layer({
  index,
  title,
  question,
  tone = "neutral",
  children,
}: {
  index: number;
  title: string;
  /** 이 층이 답하는 질문 — 제목만으로는 무엇을 보는 자리인지 좁혀지지 않는다 */
  question: string;
  tone?: Tone;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold">
          <span className="tnum mr-1.5 text-dim">{index}</span>
          {title}
        </h2>
        <span className="text-xs text-dim">{question}</span>
        {tone === "warn" || tone === "bad" ? (
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] ${
              tone === "bad" ? "border-loss/40 text-loss" : "border-beta/40 text-beta"
            }`}
          >
            {tone === "bad" ? "위험" : "주의"}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** 층에서 가장 나쁜 판정 — 제목 옆 배지가 이 값을 쓴다. */
export function worstTone(tones: readonly Tone[]): Tone {
  if (tones.includes("bad")) return "bad";
  if (tones.includes("warn")) return "warn";
  if (tones.includes("good")) return "good";
  return "neutral";
}

/** 층 안에서 숫자 묶음 밑에 붙는 설명 한 줄. */
export function Note({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  return <p className={`text-[11px] leading-snug ${TONE_CLASS[tone]}`}>{children}</p>;
}
