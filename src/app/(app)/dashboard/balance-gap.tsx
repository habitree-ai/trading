import { dateTime, num } from "@/lib/format";
import { readBalanceGap, TONE_CLASS } from "@/lib/verdict";

/**
 * 계산 자금과 거래소 실제 잔액의 차이 — 벌어지면 놓친 거래나 입출금이 있다는 뜻.
 *
 * 어느 정도를 '어긋났다'로 볼지는 `readBalanceGap`이 정한다. 여기서 따로 기준을 두면
 * 같은 화면의 판정 배지와 이 줄이 다른 말을 하게 된다.
 *
 * 대시보드에서 입출금 내역 표를 걷어내면서 이 줄만 남겼다. 드나든 돈의 목록은 매일
 * 볼 것이 아니지만, "화면의 숫자가 실제와 맞는가"는 현재자금 바로 밑에 있어야 한다 —
 * 그게 아니면 위의 큰 숫자를 믿어도 되는지 알 수 없다.
 */
export function BalanceGap({
  computed,
  actual,
  unrealizedPnl,
  at,
  currency,
}: {
  computed: number;
  actual: number | null;
  unrealizedPnl: number | null;
  at: string | null;
  currency: string;
}) {
  if (actual === null) {
    return (
      <p className="text-[11px] text-dim">
        거래소 잔액을 아직 받지 못했습니다 — OKX 동기화를 돌리면 채워집니다.
      </p>
    );
  }

  const verdict = readBalanceGap(computed, actual, unrealizedPnl);

  return (
    <p className="text-[11px] text-dim">
      거래소 잔액 <span className="tnum text-text">{num(actual)}</span> {currency}
      {at ? ` · ${dateTime(at)}` : ""} ·{" "}
      <span className={TONE_CLASS[verdict.tone]}>{verdict.text}</span>
    </p>
  );
}
