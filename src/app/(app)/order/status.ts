import type { Book } from "@/lib/domain";
import { manualClient } from "@/lib/okx-live";
import { loadOkxCredentials } from "@/lib/okx/credentials";
import { okxPrivateGet } from "@/lib/okx/private";

/**
 * 주문이 나갈 계좌와 일지가 받는 계좌 — 둘을 나란히 읽어 같은지 본다. 서버 전용.
 *
 * 주문 키(`OKX_MANUAL_*`)와 동기화 키(Vault)는 서로 다른 자격이다. 코드가 옳아도 둘이
 * 다른 계좌를 가리키면 주문은 한 계좌로 나가고 일지는 다른 계좌를 받아, 방금 만든
 * 거래 행이 영원히 안 닫힌다. 그래서 화면과 액션이 모두 이 함수로 확인한다 —
 * 화면은 보여 주기 위해, 액션은 막기 위해.
 */
export interface OrderAccountStatus {
  hasKeys: boolean;
  /** 주문 키가 붙는 계좌. 키가 없거나 조회가 막히면 null */
  order: { uid: string; mainUid: string | null; posMode: string; equity: number } | null;
  /** 활성 북에 연결된 동기화 계좌. 북이 연결돼 있지 않거나 조회가 막히면 null */
  sync: { uid: string } | null;
  /** 두 uid 가 같은가 — 어느 한쪽을 못 읽었으면 null */
  match: boolean | null;
  /** 사람이 읽는 문제 목록 — 비어 있으면 주문 계좌 쪽은 열린 것이다 */
  errors: string[];
}

export async function readOrderStatus(book: Book): Promise<OrderAccountStatus> {
  const client = manualClient();
  const errors: string[] = [];
  let order: OrderAccountStatus["order"] = null;
  let sync: OrderAccountStatus["sync"] = null;

  if (client.hasKeys()) {
    try {
      const [cfg, equity] = await Promise.all([client.accountConfig(), client.equityUsd()]);
      order = {
        uid: cfg.uid ?? "",
        mainUid: cfg.mainUid ?? null,
        posMode: cfg.posMode ?? "",
        equity,
      };
    } catch (e) {
      errors.push(`주문 계좌 조회 실패: ${e instanceof Error ? e.message : "알 수 없는 오류"}`);
    }
  }

  if (!book.exchange_account_id) {
    errors.push(
      `'${book.name}' 북에 거래소 계정이 연결돼 있지 않습니다 — 설정에서 연결해야 주문이 일지에 닿습니다.`,
    );
  } else {
    try {
      const creds = await loadOkxCredentials(book.exchange_account_id);
      const rows = (await okxPrivateGet("/api/v5/account/config", {}, creds)) as { uid?: string }[];
      const uid = rows[0]?.uid;
      if (!uid) throw new Error("uid 가 비어 있습니다");
      sync = { uid };
    } catch (e) {
      errors.push(`동기화 계좌 조회 실패: ${e instanceof Error ? e.message : "알 수 없는 오류"}`);
    }
  }

  const match = order && sync ? order.uid === sync.uid : null;
  if (match === false) {
    errors.push(
      `주문 계좌(uid ${order!.uid})와 이 북의 동기화 계좌(uid ${sync!.uid})가 다릅니다 — OKX_MANUAL_* 키가 어느 계좌 것인지 확인하세요.`,
    );
  }
  if (order && order.posMode !== "long_short_mode") {
    errors.push(`주문 계좌의 포지션 모드가 ${order.posMode || "미상"} — OKX에서 롱/숏 모드로 바꿔 주세요.`);
  }

  return { hasKeys: client.hasKeys(), order, sync, match, errors };
}
