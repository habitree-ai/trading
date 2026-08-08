import {
  BookLinkSelect,
  ConnectionTestButton,
  DeleteAccountButton,
} from "@/app/(app)/settings/account-controls";
import { ExchangeAccountForm } from "@/app/(app)/settings/exchange-account-form";
import { EXCHANGE_LABEL } from "@/lib/domain";
import { dateTime } from "@/lib/format";
import { getExchangeAccount, listBooks, requireUser } from "@/lib/queries";

export default async function SettingsPage() {
  const { user } = await requireUser();
  const [account, books] = await Promise.all([getExchangeAccount(), listBooks()]);
  const linked = books.find((b) => b.exchange_account_id === account?.id) ?? null;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">설정</h1>
        <p className="mt-1 text-sm text-dim">{user.email}</p>
      </header>

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium">거래소 계정</h2>
          {account ? (
            <>
              <span className="rounded border border-accent/40 px-1.5 py-0.5 text-[10px] text-accent">
                {EXCHANGE_LABEL[account.exchange]} 등록됨
              </span>
              <span className="text-xs text-dim">
                {account.label} · {dateTime(account.updated_at)} 갱신
              </span>
              <div className="ml-auto">
                <DeleteAccountButton label={account.label} />
              </div>
            </>
          ) : (
            <span className="text-xs text-dim">미등록</span>
          )}
        </div>

        <p className="mt-2 text-xs text-dim">
          키는 Supabase Vault 가 암호화해 보관하고, 복호화는 서버에서만 일어납니다. 저장한
          뒤에는 화면에 다시 표시되지 않으니 교체할 때는 새 값을 전부 입력해 주세요.
          <br />
          OKX에서 반드시 <strong className="text-text">읽기 전용(Read)</strong> 권한으로
          발급하세요. 출금·거래 권한을 주면 안 됩니다.
        </p>

        {account ? (
          <div className="mt-3">
            <ConnectionTestButton />
          </div>
        ) : null}

        <ExchangeAccountForm replacing={account !== null} />
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">동기화 받을 북</h2>
        <p className="mt-1 text-xs text-dim">
          이 계정의 거래가 쌓일 북 하나를 고릅니다. 둘에 붙이면 같은 거래가 양쪽에 들어가
          자금 곡선이 두 배로 부풀기 때문에 하나만 고를 수 있습니다.
        </p>

        <div className="mt-3">
          {account === null ? (
            <p className="text-sm text-dim">먼저 위에서 OKX 계정을 등록해 주세요.</p>
          ) : books.length === 0 ? (
            <p className="text-sm text-dim">북이 없습니다. 북 관리에서 먼저 만들어 주세요.</p>
          ) : (
            <BookLinkSelect books={books} linkedBookId={linked?.id ?? null} />
          )}
        </div>
      </section>
    </div>
  );
}
