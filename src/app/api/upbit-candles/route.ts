import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { fetchMinuteCandles } from "@/lib/upbit";

/** 업비트 공개 캔들 프록시 — 현물신호 상세 차트용. /api/candles(OKX)와 같은 얇은 층. */
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const market = searchParams.get("market")?.trim() ?? "";
  const unit = Number(searchParams.get("unit") ?? "60");
  const count = Math.min(Number(searchParams.get("count") ?? "200"), 200);
  const to = Number(searchParams.get("to"));

  if (!/^KRW-[A-Z0-9]{2,10}$/.test(market)) {
    return NextResponse.json({ error: "market은 KRW-XXX 형식이어야 합니다." }, { status: 400 });
  }
  if (unit !== 60 && unit !== 240) {
    return NextResponse.json({ error: "unit은 60 또는 240이어야 합니다." }, { status: 400 });
  }
  if (!Number.isFinite(count) || count < 1) {
    return NextResponse.json({ error: "count가 올바르지 않습니다." }, { status: 400 });
  }

  try {
    const candles = await fetchMinuteCandles(market, unit, count, Number.isFinite(to) ? to : undefined);
    return NextResponse.json({ market, unit, candles });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json({ error: `캔들을 가져오지 못했습니다: ${message}` }, { status: 502 });
  }
}
