import { describe, expect, it } from "vitest";

import { parseAiReviewContent } from "@/lib/ai-review";

const item = {
  title: "청산 후 60분 안 재진입",
  body: "본문",
  severity: "high",
  evidence: [{ tradeId: "t1", label: "#12" }],
};

const valid = {
  headline: "한 줄",
  state: ["상태 1"],
  scores: [{ label: "거래", value: "82", note: "표본" }],
  sections: [
    { key: "psychology", items: [item] },
    { key: "status", items: [{ ...item, severity: "good", evidence: undefined, action: "유지" }] },
  ],
  nextChecks: ["다음"],
  limits: ["한계"],
};

describe("parseAiReviewContent", () => {
  it("정상 내용을 받아 섹션을 정해진 순서로 정렬한다", () => {
    const r = parseAiReviewContent(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sections.map((s) => s.key)).toEqual(["status", "psychology"]);
    expect(r.value.sections[0].items[0]).toEqual({
      title: item.title,
      body: "본문",
      severity: "good",
      evidence: [],
      action: "유지",
    });
    expect(r.value.scores[0].note).toBe("표본");
  });

  it("누락된 칸을 전부 모아 알려준다", () => {
    const r = parseAiReviewContent({ ...valid, headline: "", state: undefined });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual(expect.arrayContaining(["headline: 필수", "state: 문자열 배열이어야 합니다"]));
  });

  it("모르는 섹션 key·중복 key·틀린 severity·근거 형식을 거부한다", () => {
    const r = parseAiReviewContent({
      ...valid,
      sections: [
        { key: "astrology", items: [] },
        { key: "rules", items: [] },
        { key: "rules", items: [] },
        { key: "fixes", items: [{ ...item, severity: "fatal" }, { ...item, evidence: [{ tradeId: "x" }] }] },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.startsWith("sections[0].key"))).toBe(true);
    expect(r.errors).toContain("sections[2].key: rules 중복");
    expect(r.errors.some((e) => e.startsWith("sections[3].items[0].severity"))).toBe(true);
    expect(r.errors).toContain("sections[3].items[1].evidence[0]: { tradeId, label } 필요");
  });

  it("객체가 아니면 거부한다", () => {
    expect(parseAiReviewContent([]).ok).toBe(false);
    expect(parseAiReviewContent(null).ok).toBe(false);
  });
});
