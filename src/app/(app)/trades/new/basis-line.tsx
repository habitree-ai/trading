import { JOURNAL_EVENT_LABEL, type JournalBasis, type JournalBasisChange, type JournalEvent } from "@/lib/domain";
import { DASH, dateTime, num } from "@/lib/format";

/**
 * 추가 기록의 기준 한 줄 — 폼 미리보기와 두 목록(포지션 시간순·최근 기록)이 같은 말을 한다.
 *
 * 추가 진입은 체결(시각·가격·수량), 변경은 달라진 항목, 메모는 아무것도 안 적는다. 변경인데
 * 견줄 직전이 없었으면 그 사실을 적는다 — 빈 줄이면 "변경이 없었다"로 읽힌다.
 */

/** 수량 — 코인 개수는 자릿수가 제각각이라 유효숫자 4개(0.0033 · 12.5 · 1,234). */
function qtyText(qty: number | null): string {
  return qty === null ? DASH : qty.toLocaleString("ko-KR", { maximumSignificantDigits: 4 });
}

export function changeText(c: JournalBasisChange): string {
  return `${c.label} ${num(c.from)} → ${num(c.to)}`;
}

export function fillText(fill: NonNullable<JournalBasis["fill"]>): string {
  return `${dateTime(fill.filled_at)} · ${num(fill.price)} × ${qtyText(fill.amount)}`;
}

/** 기준 요약 — 없으면 null(메모, 또는 체결 없는 추가 진입). */
export function basisText(event: JournalEvent, basis: JournalBasis | null): string | null {
  if (basis === null) return null;
  if (event === "add") return basis.fill ? fillText(basis.fill) : "체결 없음";
  if (event === "change") {
    if (basis.changes === null || basis.changes.length === 0) return "직전 기록 없음 — 내용 참고";
    return basis.changes.map(changeText).join(" · ");
  }
  return null;
}

const EVENT_CHIP: Record<JournalEvent, string> = {
  add: "border-profit/40 text-profit",
  change: "border-beta/40 text-beta",
  note: "border-border text-dim",
};

export function EventChip({ event }: { event: JournalEvent }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[11px] ${EVENT_CHIP[event]}`}>
      {JOURNAL_EVENT_LABEL[event]}
    </span>
  );
}

export function BasisLine({ event, basis }: { event: JournalEvent; basis: JournalBasis | null }) {
  const text = basisText(event, basis);
  if (text === null) return null;
  return <span className="tnum text-xs text-dim">{text}</span>;
}
