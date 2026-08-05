import { describe, expect, it } from "vitest";

import type { Book } from "@/lib/domain";
import { resolveSyncTarget } from "@/lib/okx/sync-target";

function book(partial: Partial<Book> = {}): Book {
  return {
    id: "b1",
    user_id: "u1",
    name: "테스트북",
    exchange: "OKX",
    base_currency: "USDT",
    initial_capital: 100,
    start_date: "2026-01-01",
    status: "active",
    memo: null,
    exchange_account_id: "acc-1",
    created_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

describe("resolveSyncTarget — 보고 있는 북을 받는다", () => {
  it("활성 북의 시작일과 계정을 그대로 쓴다", () => {
    const result = resolveSyncTarget(
      book({ id: "b2", start_date: "2026-03-01", exchange_account_id: "acc-2" }),
    );

    expect(result).toEqual({
      target: { bookId: "b2", startDate: "2026-03-01", exchangeAccountId: "acc-2" },
    });
  });

  /**
   * 예전 동작의 재현 — 활성 북에 계정이 없으면 계정이 붙은 **다른** 북을 집어 왔다.
   * 대시보드는 활성 북을 그리므로, 화면에 없는 북이 동기화되는 셈이었다.
   */
  it("활성 북에 계정이 없으면 다른 북으로 넘어가지 않는다", () => {
    const result = resolveSyncTarget(book({ name: "수동북", exchange_account_id: null }));

    expect(result).toEqual({
      error: "'수동북' 북에 거래소 계정이 연결되어 있지 않습니다. 설정에서 연결해 주세요.",
    });
  });

  it("북이 하나도 없으면 만들라고 한다", () => {
    expect(resolveSyncTarget(null)).toEqual({ error: "북을 먼저 만들어 주세요." });
  });
});
