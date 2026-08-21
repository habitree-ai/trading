/**
 * 화면 전환 즉시 뜨는 뼈대.
 *
 * 이 앱의 화면은 전부 요청 시점에 DB를 읽는다. 이 파일이 없으면 서버 렌더가 끝날
 * 때까지 **이전 화면이 그대로 멈춰** 있어서, 눌렀는지 안 눌렀는지조차 알 수 없었다.
 * loading 파일 하나가 세그먼트를 Suspense 로 감싸 누른 즉시 이 뼈대를 보여 준다.
 *
 * 모양은 일부러 어느 화면에도 맞지 않게 둔다 — 제목 한 줄과 카드 몇 장. 특정 화면을
 * 흉내 내면 다른 화면에서 뼈대와 실제가 어긋나 더 어수선해진다.
 */
export default function Loading() {
  return (
    <div className="animate-pulse space-y-6" aria-busy="true" aria-label="불러오는 중">
      <div className="space-y-2">
        <div className="h-6 w-40 rounded bg-surface-2" />
        <div className="h-4 w-64 rounded bg-surface-2/70" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-xl border border-border bg-surface" />
        ))}
      </div>

      <div className="h-56 rounded-xl border border-border bg-surface" />
      <div className="h-40 rounded-xl border border-border bg-surface" />
    </div>
  );
}
