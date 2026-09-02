import { NextResponse } from "next/server";

import { toInstId } from "@/lib/okx";
import { instrument, lastPrice } from "@/lib/okx-live";
import { createClient } from "@/lib/supabase/server";

/**
 * 상품 규격 + 현재가 — 주문 화면이 계약 수·증거금·손익비를 계산하는 재료.
 *
 * 공개 엔드포인트라 키가 필요 없지만 캔들 프록시와 같은 이유로 로그인은 요구한다.
 * 캐시하지 않는다 — 현재가는 매번 새것이어야 손절·목표의 방향 판정이 지금 시세를 본다.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });

  const symbol = new URL(request.url).searchParams.get("symbol")?.trim();
  if (!symbol) return NextResponse.json({ error: "symbol이 필요합니다." }, { status: 400 });

  const instId = toInstId(symbol);
  try {
    const [inst, last] = await Promise.all([instrument(instId), lastPrice(instId)]);
    if (![inst.ctVal, inst.lotSz, inst.minSz, inst.tickSz, last].every(Number.isFinite)) {
      return NextResponse.json(
        { error: `${instId} 상품 정보를 읽지 못했습니다 — 종목명을 확인해 주세요.` },
        { status: 404 },
      );
    }
    return NextResponse.json({ instId, ...inst, last });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json({ error: `상품 정보를 가져오지 못했습니다: ${message}` }, { status: 502 });
  }
}
