import { describe, expect, it } from "vitest";

import { buildQuery, sign } from "@/lib/okx/private";

describe("buildQuery", () => {
  it("빈 값은 빼고 붙인다 — OKX는 빈 파라미터를 오류로 본다", () => {
    expect(buildQuery({ instType: "SWAP", after: undefined, limit: "" })).toBe("?instType=SWAP");
  });

  it("아무것도 없으면 물음표도 붙이지 않는다 — 서명 문자열이 달라진다", () => {
    expect(buildQuery({})).toBe("");
  });

  it("값을 인코딩한다", () => {
    expect(buildQuery({ instId: "BTC-USDT-SWAP", limit: 100 })).toBe(
      "?instId=BTC-USDT-SWAP&limit=100",
    );
  });
});

describe("sign", () => {
  it("같은 입력이면 같은 서명 — 쿼리스트링까지 포함해야 맞는다", () => {
    const a = sign("secret", "2020-12-08T09:08:57.715Z", "GET", "/api/v5/account/balance?ccy=BTC");
    const b = sign("secret", "2020-12-08T09:08:57.715Z", "GET", "/api/v5/account/balance?ccy=BTC");
    expect(a).toBe(b);
  });

  it("쿼리가 다르면 서명도 다르다", () => {
    const withQuery = sign("secret", "t", "GET", "/api/v5/account/balance?ccy=BTC");
    const without = sign("secret", "t", "GET", "/api/v5/account/balance");
    expect(withQuery).not.toBe(without);
  });
});
