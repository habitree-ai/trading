import { QuadChart } from "@/app/(app)/quad/quad-chart";
import { nowMs } from "@/lib/okx";

/*
 * 4분할 멀티 타임프레임 차트 — 같은 심볼을 여러 봉 단위로 나란히 본다.
 * 자체 차트 엔진(lightweight-charts + OKX 시세)이라 그리기가 네 창에 실시간으로
 * 함께 반영된다. 설계는 docs/quad-chart.md 참고.
 */
export default function QuadPage() {
  return (
    /*
     * 이 화면의 주인공은 차트 면적이다. (app) layout의 main 패딩(px-4 py-6)을 음수
     * 마진으로 되찾아 가장자리까지 쓴다 — layout을 고치면 모든 페이지가 영향을 받는다.
     * 세로 패딩은 -my-5로 되찾고 남는 0.5rem만 뺀다. 고정 껍데기 높이는 --app-chrome.
     */
    <div className="-mx-3 -my-5 flex h-[calc(100dvh_-_var(--app-chrome)_-_0.5rem)] min-h-[480px] flex-col md:-mx-5">
      <QuadChart now={nowMs()} />
    </div>
  );
}
