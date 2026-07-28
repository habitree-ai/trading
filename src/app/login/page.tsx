import { LoginForm } from "@/app/login/login-form";
import { OAuthErrorRelay } from "@/app/login/oauth-error";

const REASON: Record<string, string> = {
  oauth: "구글 로그인이 완료되지 않았습니다.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; detail?: string }>;
}) {
  const { next, error, detail } = await searchParams;

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <OAuthErrorRelay />
        <h1 className="text-2xl font-semibold tracking-tight">트레이딩 누적기록</h1>
        <p className="mt-2 text-sm text-dim">
          캡쳐를 올리면 거래가 누적되고 대시보드가 갱신됩니다.
        </p>
        {error ? (
          <p className="mt-4 rounded-lg border border-loss/50 bg-loss/10 px-3 py-2 text-sm text-loss">
            {REASON[error] ?? "로그인에 실패했습니다."}
            {detail ? <span className="mt-1 block text-xs opacity-80">{detail}</span> : null}
          </p>
        ) : null}
        <LoginForm next={next ?? "/dashboard"} />
      </div>
    </main>
  );
}
