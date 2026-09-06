import { NextResponse } from "next/server";

import { listNoteAnnotations, requireUser } from "@/lib/queries";

/**
 * 일반 기록의 차트 한 장에 필요한 것 — 그 기록에 남긴 차트 메모.
 *
 * `/api/trades/[id]/detail` 의 짝이다. 거래가 아니라 체결은 없고, 모양은 같게 돌려준다 —
 * 차트는 소유자가 무엇이든 같은 재료(`fills`·`annotations`)를 받는다.
 * 어느 기록을 읽을 수 있는지는 RLS 가 가른다 — 남의 id 를 넣어도 빈 배열이다.
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
    const annotations = await listNoteAnnotations(id);
    return NextResponse.json({ fills: [], annotations });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: `차트 자료를 가져오지 못했습니다: ${message}` },
      { status: 500 },
    );
  }
}
