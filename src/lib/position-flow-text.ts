import { num, price } from "@/lib/format";
import type { Stage } from "@/lib/position-r";

const EPS = 1e-9;

/**
 * 단계 머리의 한 줄 — 직전 단계와 비교해 이 단계에서 바뀐 것만 적는다(REQ-0109).
 *
 * 수량 변화와 손절 변화를 따로 보고 둘 다 있으면 함께 적는다. 「현재」 열은 바뀐 것이 아니라
 * 지금의 상태라 문구가 없다.
 */
export function stageChange(prev: Stage | null, s: Stage): string | null {
  if (s.kind === "now") return null;
  if (prev === null) return `${num(s.qty, 0)}개 진입`;

  const parts: string[] = [];
  const dq = s.qty - prev.qty;
  if (Math.abs(dq) > EPS) parts.push(`${dq > 0 ? "+" : "−"}${num(Math.abs(dq), 0)}개`);

  const stopChanged =
    (prev.stopPx === null) !== (s.stopPx === null) ||
    (prev.stopPx !== null && s.stopPx !== null && Math.abs(prev.stopPx - s.stopPx) > EPS);
  if (stopChanged) {
    parts.push(
      s.stopPx === null
        ? "손절 해제"
        : prev.stopPx === null
          ? `손절 ${price(s.stopPx)}`
          : `손절 ${price(prev.stopPx)}→${price(s.stopPx)}`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * 지금 손절에 걸리면 어떻게 되는지 — CR 은 0 아래로 내려가지 않고 그 몫은 잠긴 R 이 든다.
 * 둘 다 모르면 null.
 */
export function stopOutcome(s: Stage): { text: string; tone: "bad" | "good" | "flat" } | null {
  if (s.cr !== null && s.cr > EPS) return { text: `손절되면 −${num(s.cr, 2)}R`, tone: "bad" };
  if (s.lockedR !== null && s.lockedR > EPS) return { text: `손절돼도 +${num(s.lockedR, 2)}R 확보`, tone: "good" };
  if (s.cr === null && s.lockedR === null) return null;
  return { text: "손절되면 본전", tone: "flat" };
}
