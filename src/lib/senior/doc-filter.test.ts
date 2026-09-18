import { describe, expect, it } from "vitest";

import { normalize, sectionLabel } from "@/lib/senior/doc-filter";

describe("normalize", () => {
  it("대소문자를 내리고 연속 공백을 한 칸으로 고른다", () => {
    expect(normalize("  Trend   Following\n")).toBe("trend following");
  });
});

describe("sectionLabel", () => {
  it("헤딩의 편수·기간을 떼고 이름만 남긴다", () => {
    // 통째로 쓰면 「2015-01」 검색에 이 게시판 262행이 전부 걸린다.
    expect(sectionLabel("07. 매매일지 — 262편 (2007-10-04 ~ 2015-01-09)")).toBe("07. 매매일지");
    expect(sectionLabel("2024 — 25편")).toBe("2024");
    expect(sectionLabel("1. 심리·기질 — 103편 (목록 25편)")).toBe("1. 심리·기질");
  });

  it("`—` 가 없는 헤딩은 그대로 쓴다", () => {
    expect(sectionLabel("게시판 한눈에")).toBe("게시판 한눈에");
  });

  it("제목이 `—` 로 시작하면 이름이 비지 않게 전체를 쓴다", () => {
    expect(sectionLabel("— 덧붙임")).toBe("— 덧붙임");
  });
});
