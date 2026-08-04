import { NextResponse } from "next/server";

import { BAR_MS, BARS, fetchCandles, toInstId, type Bar } from "@/lib/okx";
import { createClient } from "@/lib/supabase/server";

function isBar(value: string): value is Bar {
  return (BARS as readonly string[]).includes(value);
}

/** OKX 공개 캔들 프록시 — 브라우저 CORS를 피하고 응답을 캐시하기 위한 얇은 층. */
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol")?.trim();
  const bar = searchParams.get("bar") ?? "";
  const from = Number(searchParams.get("from"));
  const to = Number(searchParams.get("to"));

  if (!symbol) return NextResponse.json({ error: "symbol이 필요합니다." }, { status: 400 });
  if (!isBar(bar)) {
    return NextResponse.json(
      { error: `bar는 ${BARS.join(", ")} 중 하나여야 합니다.` },
      { status: 400 },
    );
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return NextResponse.json({ error: "from/to 구간이 올바르지 않습니다." }, { status: 400 });
  }

  try {
    const instId = toInstId(symbol);
    // OKX는 한 번에 100개만 준다. 며칠짜리 거래를 15분봉으로 보면 기본 4페이지로는
    // 진입 지점까지 닿지 못한다 — 구간에 필요한 만큼 늘리되 상한을 둔다.
    const pages = Math.ceil((to - from) / BAR_MS[bar] / 100);
    const candles = await fetchCandles(instId, bar, from, to, Math.min(Math.max(pages, 1), 12));
    return NextResponse.json({ instId, bar, candles });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json({ error: `캔들을 가져오지 못했습니다: ${message}` }, { status: 502 });
  }
}
