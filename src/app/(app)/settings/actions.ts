"use server";

import { revalidatePath } from "next/cache";

import { getExchangeAccount, requireUser } from "@/lib/queries";

export interface ExchangeAccountState {
  error?: string;
  message?: string;
}

/**
 * OKX API 키를 등록하거나 갈아 끼운다.
 *
 * 키는 이 서버 액션을 지나 곧장 `save_okx_account` RPC 로 들어가고, Vault 가 암호화해
 * 보관한다. 앱은 원문을 어디에도 남기지 않는다 — 로그에도, 폼 되돌림 값에도.
 */
export async function saveOkxAccount(
  _prev: ExchangeAccountState,
  formData: FormData,
): Promise<ExchangeAccountState> {
  const { supabase } = await requireUser();

  const apiKey = String(formData.get("api_key") ?? "").trim();
  const apiSecret = String(formData.get("api_secret") ?? "").trim();
  const passphrase = String(formData.get("passphrase") ?? "").trim();

  if (!apiKey || !apiSecret || !passphrase) {
    return { error: "API 키·시크릿·패스프레이즈를 모두 입력해 주세요." };
  }

  const { error } = await supabase.rpc("save_okx_account", {
    p_label: String(formData.get("label") ?? "").trim() || "OKX",
    p_api_key: apiKey,
    p_api_secret: apiSecret,
    p_passphrase: passphrase,
  });

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { message: "OKX 계정을 저장했습니다." };
}

/**
 * 계정을 지운다 — 북 연결을 먼저 끊는다.
 *
 * FK 가 연결된 계정의 삭제를 막는다. 그 제약이 있어야 대시보드에서 계정만 지웠을 때
 * 북이 조용히 미아가 되는 일이 없다.
 * 행이 사라지면 트리거가 Vault 비밀도 함께 지운다.
 */
export async function deleteOkxAccount() {
  const { supabase } = await requireUser();

  const account = await getExchangeAccount();
  if (!account) return;

  const { error: unlinkError } = await supabase
    .from("books")
    .update({ exchange_account_id: null })
    .eq("exchange_account_id", account.id);
  if (unlinkError) throw new Error(unlinkError.message);

  const { error } = await supabase.from("exchange_accounts").delete().eq("id", account.id);
  if (error) throw new Error(error.message);

  revalidatePath("/", "layout");
}

/**
 * 거래소 계정이 어느 북으로 들어올지 정한다.
 *
 * 한 계정은 북 하나에만 붙는다 — 둘에 붙이면 같은 거래가 양쪽에 쌓여 자금 곡선이
 * 두 배로 부푼다. DB 유니크가 둘째를 막으므로 붙이기 전에 먼저 떼어 낸다.
 */
export async function linkBook(bookId: string | null) {
  const { supabase } = await requireUser();

  const account = await getExchangeAccount();
  if (!account) throw new Error("먼저 OKX 계정을 등록해 주세요.");

  const { error: clearError } = await supabase
    .from("books")
    .update({ exchange_account_id: null })
    .eq("exchange_account_id", account.id);
  if (clearError) throw new Error(clearError.message);

  if (bookId) {
    const { error } = await supabase
      .from("books")
      .update({ exchange_account_id: account.id })
      .eq("id", bookId);
    if (error) throw new Error(error.message);
  }

  revalidatePath("/", "layout");
}
