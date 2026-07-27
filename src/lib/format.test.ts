import { describe, expect, it } from "vitest";

import { date, dateTime, fromLocalInput, toLocalInput } from "@/lib/format";

describe("시각 포맷 — 서버/브라우저가 같은 문자열을 만들어야 한다", () => {
  it("표시 타임존(KST) 기준으로 찍는다", () => {
    // 2026-07-25 11:15Z == 2026-07-25 20:15 KST
    expect(dateTime("2026-07-25T11:15:00Z")).toBe("26.07.25 20:15");
    expect(date("2026-07-25T11:15:00Z")).toBe("26.07.25");
  });

  it("로케일 단어(오후/PM)를 쓰지 않는다 — 하이드레이션 불일치의 원인", () => {
    expect(dateTime("2026-07-25T11:15:00Z")).not.toMatch(/오전|오후|AM|PM/);
  });

  it("자정을 24시가 아닌 00시로 쓴다", () => {
    // 2026-07-24 15:00Z == 2026-07-25 00:00 KST
    expect(dateTime("2026-07-24T15:00:00Z")).toBe("26.07.25 00:00");
  });

  it("null은 대시로 떨어진다", () => {
    expect(dateTime(null)).toBe("—");
    expect(date(null)).toBe("—");
  });
});

describe("fromLocalInput — datetime-local 입력을 KST 벽시계로 해석한다", () => {
  it("서버가 UTC로 돌아도 입력한 시각이 밀리지 않는다", () => {
    // 09:15로 입력했으면 09:15 KST여야 한다 (= 00:15Z)
    expect(fromLocalInput("2026-07-02T09:15")).toBe("2026-07-02T00:15:00.000Z");
  });

  it("자정 직후 입력이 전날로 밀리지 않는다", () => {
    expect(fromLocalInput("2026-07-02T00:30")).toBe("2026-07-01T15:30:00.000Z");
  });

  it("toLocalInput과 왕복해도 값이 보존된다", () => {
    const iso = "2026-07-25T11:15:00.000Z";
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
  });

  it("빈 값이나 형식이 어긋나면 null", () => {
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("2026-07-02")).toBeNull();
    expect(fromLocalInput("nonsense")).toBeNull();
  });
});
