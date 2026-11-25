import { PositionTab } from "@/app/(app)/kelly/position-tab";
import { EmptyBook } from "@/components/empty-book";
import { getActiveBook } from "@/lib/queries";

/**
 * 현재 포지션 — 보유 포지션의 단계별 흐름(R·E·CR)과 진입 계산기(REQ-0107).
 *
 * 과거데이터 분석의 탭이던 화면이다. 활성 북의 지금 데이터라 수동매매 영역에 둔다 — 차트·자료 쪽에
 * 있으면 메뉴를 누르는 순간 영역 탭·사이드바·북 선택이 통째로 바뀐다.
 */
export default async function PositionPage() {
  const book = await getActiveBook();
  if (!book) return <EmptyBook />;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">현재 포지션</h1>
        <p className="mt-1 text-sm text-dim">{book.name} · 보유 포지션의 단계별 R·E·CR 흐름과 진입 계산기</p>
      </header>
      <PositionTab book={book} />
    </div>
  );
}
