import { NextResponse } from "next/server";

import { collectSnapshot, type CollectOutcome } from "@/lib/research/collect";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * 매일 도는 리서치 스냅샷 수집.
 *
 * 대상은 "한 번이라도 수동 수집한 (사용자, 심볼)" 조합이다 — 관심 목록 표를 따로
 * 두지 않는다. 화면에서 한 번 수집하면 그날부터 이력이 자동으로 쌓이고, 그만 쌓고
 * 싶으면 스냅샷을 지우면 된다. Vercel Cron이 `Authorization: Bearer $CRON_SECRET`을
 * 붙여 부른다. service_role로 RLS를 우회하므로 이 인증이 곧 유일한 문이다.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_SECRET_KEY가 없어 크론 수집을 할 수 없습니다." },
      { status: 501 },
    );
  }

  const { data, error } = await supabase.from("research_snapshots").select("user_id, symbol");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // (사용자, 심볼) 조합으로 좁힌다 — 스냅샷이 쌓여도 조합 수는 심볼 수 정도다.
  const combos = new Map<string, { userId: string; symbol: string }>();
  for (const row of data ?? []) {
    combos.set(`${row.user_id}:${row.symbol}`, { userId: row.user_id, symbol: row.symbol });
  }

  // 같은 심볼은 한 번만 걷는다 — 외부 API 호출은 심볼 수만큼이면 충분하다.
  const collected = new Map<string, CollectOutcome>();
  // 한 조합이 실패해도 나머지는 돌린다 — 소스 하나 문제로 전부 멈추면 안 된다.
  const results = [];
  for (const { userId, symbol } of combos.values()) {
    try {
      let outcome = collected.get(symbol);
      if (!outcome) {
        outcome = await collectSnapshot(symbol);
        collected.set(symbol, outcome);
      }

      const { error: insertError } = await supabase
        .from("research_snapshots")
        .insert({ ...outcome.row, user_id: userId });
      if (insertError) throw new Error(insertError.message);

      results.push({ symbol, failed: outcome.failed });
    } catch (cause) {
      results.push({
        symbol,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return NextResponse.json({ targets: results.length, results });
}
