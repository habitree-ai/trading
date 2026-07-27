import { LoginForm } from "@/app/login/login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold tracking-tight">트레이딩 누적기록</h1>
        <p className="mt-2 text-sm text-dim">
          캡쳐를 올리면 거래가 누적되고 대시보드가 갱신됩니다.
        </p>
        <LoginForm next={next ?? "/dashboard"} />
      </div>
    </main>
  );
}
