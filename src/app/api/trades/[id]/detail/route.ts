import { NextResponse } from "next/server";

import { listAnnotations, listFills, requireUser } from "@/lib/queries";

/**
 * 차트 한 장에 필요한 것만 — 그 거래의 낱개 체결과 차트 메모.
 *
 * 예전에는 거래 목록이 북 **전량**을 받아 화면에 실어 보냈다. 차트는 한 번에 한 줄만
 * 펼치는데도 거래가 쌓이는 만큼 첫 화면이 무거워졌고, 모바일에서 그 값을 다 내려받는
 * 동안 목록 자체가 늦게 떴다. 차트가 열릴 때 자기 것만 읽는다.
 *
 * 어느 거래를 읽을 수 있는지는 RLS 가 가른다 — 남의 거래 id를 넣어도 빈 배열이다.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireUser();
  } catch {
    return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });
  }

  const { id } = await params;

  try {
    // 인증은 위에서 이미 한 번 했고, 요청 안에서는 재사용된다(queries의 requireUser).
    const [fills, annotations] = await Promise.all([listFills(id), listAnnotations(id)]);
    return NextResponse.json({ fills, annotations });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: `차트 자료를 가져오지 못했습니다: ${message}` },
      { status: 500 },
    );
  }
}
