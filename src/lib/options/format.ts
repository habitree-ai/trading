/**
 * 옵션 화면의 금액 축약 — 총 OI 의 USD 환산과 GEX 는 자릿수가 곧 정보라 `$36.44B` · `$359M`
 * 처럼 줄여야 읽힌다. 화면·차트·해석 문구 세 곳이 같은 규칙을 써야 하므로 한곳에 둔다.
 *
 * `/research` 화면에도 비슷한 축약(T/B/M)이 그 파일 안에 따로 있다 — 자릿수 규칙이 달라
 * 합치지 않았다.
 */

import { DASH, num } from "@/lib/format";

/** `$1.23B` · `$359M` · `$12K`. 음수는 `−` 를 앞에 붙이고, null 은 `—`. */
export function usdCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs >= 1e9) return `${sign}$${num(abs / 1e9, 2)}B`;
  if (abs >= 1e6) return `${sign}$${num(abs / 1e6, 0)}M`;
  if (abs >= 1e3) return `${sign}$${num(abs / 1e3, 0)}K`;
  return `${sign}$${num(abs, 0)}`;
}
