import { QuadChart } from "@/app/(app)/quad/quad-chart";
import { nowMs } from "@/lib/okx";

/*
 * 4분할 멀티 타임프레임 차트 — 같은 심볼을 15분·1시간·4시간·일봉으로 나란히 본다.
 * 자체 차트 엔진(lightweight-charts + OKX 시세)이라 그리기가 네 창에 실시간으로
 * 함께 반영된다. 설계는 docs/quad-chart.md 참고.
 */
export default function QuadPage() {
  return (
    /*
     * 높이는 페이지가 스스로 잡는다 — chart 페이지와 같은 이유·같은 계산.
     * 뺄셈 값 = 헤더 + main 상하 패딩(모바일은 가로 네비 한 줄 추가).
     */
    <div className="flex h-[calc(100dvh-13rem)] min-h-[480px] flex-col gap-3 md:h-[calc(100dvh-6.5rem)]">
      <header className="shrink-0">
        <h1 className="text-xl font-semibold tracking-tight">4분할 차트</h1>
        <p className="mt-1 text-sm text-dim">
          같은 심볼을 네 가지 봉 단위로 나란히 봅니다. 한 창에 그리면 네 창 모두에
          실시간으로 같이 그려지고, 그린 내용은 새로고침하면 사라집니다.
        </p>
      </header>

      <QuadChart now={nowMs()} />
    </div>
  );
}
