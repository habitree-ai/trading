/** 표시 포맷 — null은 `—`로 통일한다. 0과 '값 없음'을 눈으로 구분하기 위해. */

export const DASH = "—";

export function num(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return value.toLocaleString("ko-KR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** 비율(0.375) → `37.5%` */
export function pct(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${(value * 100).toLocaleString("ko-KR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}%`;
}

/** 부호를 항상 붙인다 — 손익은 방향이 먼저 읽혀야 한다. */
export function signed(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${value > 0 ? "+" : ""}${num(value, decimals)}`;
}

export function signedPct(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${value > 0 ? "+" : ""}${pct(value, decimals)}`;
}

/** 손익 부호 → 색 클래스. 0은 중립. */
export function pnlClass(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return "text-dim";
  return value > 0 ? "text-profit" : "text-loss";
}

/**
 * 거래 시각은 항상 이 타임존으로 표시한다.
 *
 * `toLocaleString`의 기본 동작에 맡기면 서버(Node)와 브라우저의 로케일·타임존이 달라
 * `PM 08:15` vs `오후 08:15`처럼 갈리면서 하이드레이션이 깨진다. 타임존과 자릿수를
 * 명시해 양쪽이 같은 문자열을 만들게 한다.
 */
export const DISPLAY_TZ = "Asia/Seoul";

const DT_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function parts(iso: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of DT_PARTS.formatToParts(new Date(iso))) out[p.type] = p.value;
  // hour12:false는 자정을 "24"로 주는 구현이 있다.
  if (out.hour === "24") out.hour = "00";
  return out;
}

/** `26.07.25 20:15` */
export function dateTime(iso: string | null): string {
  if (!iso) return DASH;
  const p = parts(iso);
  return `${p.year.slice(2)}.${p.month}.${p.day} ${p.hour}:${p.minute}`;
}

/** `26.07.25` */
export function date(iso: string | null): string {
  if (!iso) return DASH;
  const p = parts(iso);
  return `${p.year.slice(2)}.${p.month}.${p.day}`;
}

/** `<input type="datetime-local">`이 요구하는 형식 — 표시 타임존 기준. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const p = parts(iso);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

const OFFSET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/**
 * `<input type="datetime-local">`이 준 벽시계 문자열을 DISPLAY_TZ의 시각으로 해석해 UTC ISO로 바꾼다.
 *
 * `new Date("2026-07-02T09:15")`는 **실행 환경의 로컬 타임존**으로 파싱된다. 서버는 UTC로
 * 도는 경우가 많아 그대로 두면 입력한 시각이 통째로 밀린다.
 * (한국은 서머타임이 없어 오프셋 1회 보정으로 정확하다.)
 */
export function fromLocalInput(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local)) return null;

  const asUtc = new Date(`${local.slice(0, 16)}:00Z`);
  if (Number.isNaN(asUtc.getTime())) return null;

  const p: Record<string, string> = {};
  for (const x of OFFSET_PARTS.formatToParts(asUtc)) p[x.type] = x.value;

  const shown = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );

  return new Date(asUtc.getTime() - (shown - asUtc.getTime())).toISOString();
}

/**
 * datetime-local 폼값(분 단위)이 기존 시각과 같은 분이면 기존 시각을 돌려준다.
 *
 * 폼 입력은 초를 담지 못한다 — 시각을 건드리지 않고 저장해도 초·밀리초가 잘려 나간다.
 * 같은 분이면 "안 바꾼 것"으로 보고 초까지 있는 기존 값을 지킨다. 같은 분 안의 이체와
 * 순서가 뒤집혀 자금 곡선이 통째로 어긋난 실사례(2026-09-01)가 있다.
 */
export function keepIfSameMinute(
  submitted: string | null,
  current: string | null,
): string | null {
  if (submitted === null || current === null) return submitted;
  return fromLocalInput(toLocalInput(current)) === submitted ? current : submitted;
}
