import { afterEach, describe, expect, it, vi } from "vitest";

import { buildQuery, describeOkxCode, okxPrivateGet, OkxApiError, sign } from "@/lib/okx/private";

const CREDS = { apiKey: "k", secretKey: "s", passphrase: "p" };

/** 상태 코드와 본문을 정해 두고 부르는 가짜 거래소. */
function stubOkx(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

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

describe("인증 실패", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /*
   * 재현: 화면에 `OKX 응답 오류 401`만 떴다.
   *
   * 상태 코드를 보고 본문을 읽기 전에 던지고 있었다. OKX는 401에도 실패 이유를 본문
   * 코드로 담아 주므로, 그걸 버리면 키·시크릿·시계·허용 IP 중 무엇이 어긋났는지
   * 알 방법이 없다.
   */
  it("401 본문의 코드와 원인을 살려 낸다", async () => {
    stubOkx(401, { code: "50113", msg: "Invalid Sign", data: [] });

    await expect(okxPrivateGet("/api/v5/account/balance", {}, CREDS)).rejects.toMatchObject({
      code: "50113",
      path: "/api/v5/account/balance",
    });
  });

  it("오류 한 줄에 원인과 엔드포인트가 함께 담긴다", async () => {
    stubOkx(401, { code: "50110", msg: "Invalid IP", data: [] });

    let error: OkxApiError | null = null;
    try {
      await okxPrivateGet("/api/v5/asset/deposit-history", { limit: 100 }, CREDS);
    } catch (thrown) {
      error = thrown as OkxApiError;
    }

    expect(error?.message).toContain("50110");
    expect(error?.message).toContain("허용 IP");
    // 쿼리스트링은 떼고 경로만 — 어느 기능이 막혔는지만 알면 된다.
    expect(error?.message).toContain("(/api/v5/asset/deposit-history)");
  });

  it("본문이 JSON이 아니면 상태 코드로 되돌아간다 — 앞단이 막았을 때", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>blocked</html>", { status: 403 })),
    );

    await expect(okxPrivateGet("/api/v5/account/balance", {}, CREDS)).rejects.toMatchObject({
      code: "403",
    });
  });

  it("모르는 코드는 원인을 지어내지 않는다", () => {
    expect(describeOkxCode("50113")).not.toBeNull();
    expect(describeOkxCode("99999")).toBeNull();
  });
});
