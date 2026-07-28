"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export interface AuthState {
  error?: string;
}

/**
 * 지금 요청이 도달한 실제 주소. 콜백 URL을 여기에 맞춰야
 * 로컬(`localhost:3000`)과 프로덕션이 각자 자기 자신으로 돌아온다.
 */
async function currentOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function signInWithGoogle(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const next = String(formData.get("next") ?? "/dashboard");
  const safeNext = next.startsWith("/") ? next : "/dashboard";

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${await currentOrigin()}/auth/callback?next=${encodeURIComponent(safeNext)}`,
    },
  });
  if (error) return { error: error.message };
  if (!data.url) return { error: "구글 로그인 주소를 받지 못했습니다." };

  redirect(data.url);
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
