/**
 * 거래소 키를 Vault 에서 꺼낸다 — 서버 전용.
 *
 * 키 원문은 `exchange_accounts` 에 없다. 표에는 Vault 비밀의 uuid만 있고, 복호화하는
 * `public.okx_credentials()` 는 **service_role 에게만** 열려 있다. 로그인 세션 클라이언트로
 * 부를 수 없다는 뜻이고, 그래서 이 파일은 `SUPABASE_SECRET_KEY` 가 있어야 동작한다.
 *
 * authenticated 에게 열어 두지 않는 이유: 브라우저에 세션이 있는 역할이라
 * XSS 한 번이면 거래소 키가 통째로 새 나간다.
 */

import type { OkxCredentials } from "@/lib/okx/private";
import { createServiceClient } from "@/lib/supabase/service";

export class OkxNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OkxNotConfiguredError";
  }
}

export async function loadOkxCredentials(accountId: string): Promise<OkxCredentials> {
  const supabase = createServiceClient();
  if (!supabase) {
    throw new OkxNotConfiguredError(
      "SUPABASE_SECRET_KEY 가 없어 거래소 키를 읽을 수 없습니다. 서버 환경변수를 확인해 주세요.",
    );
  }

  const { data, error } = await supabase.rpc("okx_credentials", { p_account_id: accountId });
  if (error) throw new OkxNotConfiguredError(`거래소 키를 읽지 못했습니다: ${error.message}`);

  const row = data?.[0];
  if (!row?.api_key || !row.api_secret || !row.passphrase) {
    throw new OkxNotConfiguredError(
      "거래소 키가 비어 있습니다. 설정 화면에서 OKX API 키를 다시 등록해 주세요.",
    );
  }

  return { apiKey: row.api_key, secretKey: row.api_secret, passphrase: row.passphrase };
}
