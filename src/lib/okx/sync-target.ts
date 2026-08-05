/**
 * 동기화가 어느 북을 받을지 정한다.
 *
 * 예전에는 "거래소 계정이 붙은 북"을 조건 없이 하나 집어 왔다. 그러면 화면이 그리는 북과
 * 받아 오는 북이 갈린다 — 대시보드는 쿠키에 담긴 활성 북을 그리기 때문이다. 계정이 붙은
 * 북이 둘 이상이면 그 쿼리 자체가 에러를 내 동기화가 통째로 실패하기도 했다.
 *
 * 보고 있는 북을 받는 게 맞다. 활성 북에 계정이 없으면 다른 북으로 넘어가지 않고 멈춘다 —
 * 화면에 없는 북을 말없이 건드리는 것보다 낫다.
 */

import type { Book } from "@/lib/domain";

export interface SyncTarget {
  bookId: string;
  startDate: string;
  exchangeAccountId: string;
}

export type SyncTargetResult = { target: SyncTarget } | { error: string };

export function resolveSyncTarget(book: Book | null): SyncTargetResult {
  if (!book) return { error: "북을 먼저 만들어 주세요." };

  if (!book.exchange_account_id) {
    return {
      error: `'${book.name}' 북에 거래소 계정이 연결되어 있지 않습니다. 설정에서 연결해 주세요.`,
    };
  }

  return {
    target: {
      bookId: book.id,
      startDate: book.start_date,
      exchangeAccountId: book.exchange_account_id,
    },
  };
}
