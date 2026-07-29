import { NextResponse } from "next/server";

import { syncOkx } from "@/lib/okx/sync";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * 매일 도는 OKX 동기화.
 *
 * OKX는 3개월치만 돌려주므로, 사람이 앱을 안 열어도 이 크론이 구간을 이어 붙인다.
 * Vercel Cron이 `Authorization: Bearer $CRON_SECRET`을 붙여 부른다.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_SECRET_KEY가 없어 크론 동기화를 할 수 없습니다." },
      { status: 501 },
    );
  }

  const { data: books, error } = await supabase
    .from("books")
    .select("id, user_id, start_date")
    .eq("okx_sync_enabled", true);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 한 북이 실패해도 나머지는 돌린다 — 한 계정 문제로 전부 멈추면 안 된다.
  const results = [];
  for (const book of books ?? []) {
    try {
      const result = await syncOkx({
        supabase,
        userId: book.user_id,
        bookId: book.id,
        startDate: book.start_date,
      });
      results.push({ bookId: book.id, ...result });
    } catch (cause) {
      results.push({
        bookId: book.id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return NextResponse.json({ books: results.length, results });
}
