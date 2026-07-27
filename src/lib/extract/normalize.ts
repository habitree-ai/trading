/**
 * OCR 결과 정규화 — 거래소 화면 공통.
 *
 * OCR은 글자를 자주 헷갈린다(O↔0, l↔1, ,↔.). 여기서 그 잡음을 걷어낸다.
 */

/** 통화 기호·단위·천단위 구분자를 걷어내고 숫자만 남긴다. `₮65,390` → 65390 */
export function toNumber(raw: string | undefined | null): number | undefined {
  if (!raw) return undefined;

  const cleaned = raw
    .replace(/[₮₩$€£¥]/g, "")
    .replace(/\b(USDT|USDC|USD|BTC|ETH)\b/gi, "")
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, "0") // OCR이 0을 O로 읽는 경우
    .replace(/,/g, "")
    .replace(/\s/g, "")
    .trim();

  const m = cleaned.match(/^[+-]?\d*\.?\d+/);
  if (!m) return undefined;

  const n = Number(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

/** `41.75%` → 0.4175 */
export function toPercent(raw: string | undefined | null): number | undefined {
  const n = toNumber(raw);
  return n === undefined ? undefined : n / 100;
}

/** `100x` / `Cross 100x` → 100 */
export function toLeverage(raw: string | undefined | null): number | undefined {
  if (!raw) return undefined;
  const m = raw.match(/(\d+(?:\.\d+)?)\s*[xX×]/);
  return m ? Number(m[1]) : undefined;
}

/**
 * 거래소 화면의 시각 문자열을 KST ISO로 바꾼다.
 *
 * OKX 모바일은 두 가지로 찍는다:
 *   `07/27/2026, 13:20:35`  — 연도 있음
 *   `07/27, 10:48:15`       — **연도 없음** (fallbackYear로 보충한다)
 *
 * @param fallbackYear 연도가 없을 때 쓸 연도. 보통 캡쳐를 올린 시점의 연도.
 */
export function toIsoKst(
  raw: string | undefined | null,
  fallbackYear: number,
): string | undefined {
  if (!raw) return undefined;

  const withYear = raw.match(
    /(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/,
  );
  const withoutYear = raw.match(/(\d{1,2})\/(\d{1,2})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);

  let month: number, day: number, year: number, hour: number, minute: number, second: number;

  if (withYear) {
    [month, day, year, hour, minute] = [
      Number(withYear[1]),
      Number(withYear[2]),
      Number(withYear[3]),
      Number(withYear[4]),
      Number(withYear[5]),
    ];
    second = Number(withYear[6] ?? 0);
  } else if (withoutYear) {
    [month, day, hour, minute] = [
      Number(withoutYear[1]),
      Number(withoutYear[2]),
      Number(withoutYear[3]),
      Number(withoutYear[4]),
    ];
    second = Number(withoutYear[5] ?? 0);
    year = fallbackYear;
  } else {
    return undefined;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return undefined;
  }

  // 화면의 시각은 사용자 기기 시간대(KST) 기준이므로 9시간을 빼 UTC로 만든다.
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, second) - KST_OFFSET_MS,
  ).toISOString();
}

/** 줄 단위로 `라벨 ... 값` 형태를 찾는다. OCR은 라벨과 값을 한 줄에 붙여 내놓는다. */
export function findLine(text: string, label: RegExp): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (label.test(line)) return line;
  }
  return undefined;
}

/** 라벨 뒤에 남은 부분만 돌려준다. `Closed PnL 35.31 USDT` → `35.31 USDT` */
export function valueAfter(text: string, label: RegExp): string | undefined {
  const line = findLine(text, label);
  if (!line) return undefined;
  return line.replace(label, "").trim() || undefined;
}

/**
 * 라벨 **다음 줄**의 값.
 *
 * OKX 포지션 화면의 큰 숫자들은 라벨과 값이 두 줄로 나뉜다:
 *   `Realized PnL (USDT)` / `+30.36`
 *   `Closed (USDT)` / `8,458.84`
 * 같은 줄만 보면 `(USDT)`를 값으로 집어 파싱이 조용히 실패한다.
 */
export function valueBelow(text: string, label: RegExp): string | undefined {
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    if (!label.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j].trim();
      if (next !== "") return next;
    }
  }
  return undefined;
}
