import { describe, expect, it } from "vitest";

import { isBlogAdminEmail } from "@/lib/senior/admin";

describe("isBlogAdminEmail", () => {
  const admins = ["cdhrich@gmail.com"];

  it("목록에 있으면 관리자 — 대소문자·공백은 가리지 않는다", () => {
    expect(isBlogAdminEmail("cdhrich@gmail.com", admins)).toBe(true);
    expect(isBlogAdminEmail(" CDHrich@Gmail.com ", admins)).toBe(true);
  });

  it("목록에 없거나 이메일이 없으면 아니다", () => {
    expect(isBlogAdminEmail("someone@else.com", admins)).toBe(false);
    expect(isBlogAdminEmail(null, admins)).toBe(false);
    expect(isBlogAdminEmail(undefined, admins)).toBe(false);
  });

  it("목록이 비면 아무도 관리자가 아니다 — ALLOWED_EMAILS 와 반대", () => {
    expect(isBlogAdminEmail("cdhrich@gmail.com", [])).toBe(false);
  });
});
