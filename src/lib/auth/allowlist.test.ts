import { describe, expect, it } from "vitest";

import { isEmailAllowed, parseAllowedEmails } from "@/lib/auth/allowlist";

describe("parseAllowedEmails", () => {
  it("쉼표로 나누고 공백·대소문자를 정리한다", () => {
    expect(parseAllowedEmails(" CDHrich@Gmail.com , b@c.io ")).toEqual([
      "cdhrich@gmail.com",
      "b@c.io",
    ]);
  });

  it("비었거나 없으면 빈 목록", () => {
    expect(parseAllowedEmails(undefined)).toEqual([]);
    expect(parseAllowedEmails("")).toEqual([]);
    // 쉼표만 남은 값이 빈 항목으로 들어가면 아무도 통과하지 못한다.
    expect(parseAllowedEmails(" , ,")).toEqual([]);
  });
});

describe("isEmailAllowed", () => {
  const allowed = ["cdhrich@gmail.com"];

  it("목록에 있으면 통과 — 대소문자는 가리지 않는다", () => {
    expect(isEmailAllowed("cdhrich@gmail.com", allowed)).toBe(true);
    expect(isEmailAllowed("CDHrich@Gmail.com", allowed)).toBe(true);
  });

  it("목록에 없으면 막는다", () => {
    expect(isEmailAllowed("someone@else.com", allowed)).toBe(false);
  });

  it("이메일이 없는 계정은 막는다", () => {
    expect(isEmailAllowed(null, allowed)).toBe(false);
    expect(isEmailAllowed(undefined, allowed)).toBe(false);
  });

  it("목록이 비면 제한하지 않는다 — 로컬 개발용", () => {
    expect(isEmailAllowed("anyone@example.com", [])).toBe(true);
    expect(isEmailAllowed(null, [])).toBe(true);
  });
});
