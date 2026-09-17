import { describe, expect, it } from "vitest";

import { firstLine, orderByThought } from "@/lib/senior/note-list";

describe("orderByThought — 내 생각 작성일 최신순", () => {
  it("작성일이 늦은 것이 먼저, 생각이 없는 노트는 뒤, 같은 조건은 들어온 순서", () => {
    const notes = [
      { id: "none-a", think_at: null },
      { id: "old", think_at: "2026-09-04T07:14:00+00:00" },
      { id: "none-b", think_at: null },
      { id: "new", think_at: "2026-09-17T02:12:57.169468+00:00" },
      { id: "mid", think_at: "2026-09-10T00:13:00+00:00" },
    ];
    expect(orderByThought(notes).map((n) => n.id)).toEqual(["new", "mid", "old", "none-a", "none-b"]);
  });

  it("같은 시각끼리도 들어온 순서를 지키고, 원래 배열은 건드리지 않는다", () => {
    const notes = [
      { id: "a", think_at: "2026-09-10T00:00:00+00:00" },
      { id: "b", think_at: "2026-09-10T00:00:00+00:00" },
    ];
    const copy = [...notes];
    expect(orderByThought(notes).map((n) => n.id)).toEqual(["a", "b"]);
    expect(notes).toEqual(copy);
  });

  it("시간대 표기가 달라도 실제 시각으로 비교한다", () => {
    const notes = [
      { id: "utc-earlier", think_at: "2026-09-17T00:30:00+00:00" },
      { id: "kst-later", think_at: "2026-09-17T10:00:00+09:00" }, // = 01:00 UTC
    ];
    expect(orderByThought(notes).map((n) => n.id)).toEqual(["kst-later", "utc-earlier"]);
  });
});

describe("firstLine — 한 줄 목록에 놓을 첫 줄", () => {
  it("앞의 빈 줄을 건너뛰고 비어 있지 않은 첫 줄을 다듬는다 (CRLF 포함)", () => {
    expect(firstLine("\r\n   \r\n  지금의 흔들리는 마음이 그대로 대입된다  \r\n\r\n26.9.17 BTC")).toBe(
      "지금의 흔들리는 마음이 그대로 대입된다",
    );
  });

  it("비었거나 공백뿐이면 빈 문자열", () => {
    expect(firstLine("")).toBe("");
    expect(firstLine(" \n\t\n")).toBe("");
  });
});
