/**
 * 숫자로 고칠 수 있는 값들 — 더블클릭했을 때 뜨는 입력칸의 목록.
 *
 * 끌어서 맞추는 건 눈으로 대충 놓는 일이다. "63,500 정확히"가 필요한 순간 —
 * 전고점, 라운드 넘버, 주문을 넣어 둔 가격 — 에는 손이 아니라 숫자여야 한다.
 *
 * 좌표의 어느 자리가 어떤 이름인지는 종류마다 다르다. 그 대응을 화면 코드에 흩어 두면
 * 종류를 하나 더할 때마다 두 군데를 고치게 된다.
 */

import type { AnnotationKind } from '@/lib/domain';

export interface LevelField {
  /** `points` 배열의 몇 번째인지 */
  index: number;
  label: string;
}

export function levelFields(kind: AnnotationKind): LevelField[] {
  switch (kind) {
    case 'text':
    case 'hline':
      return [{ index: 0, label: '가격' }];
    case 'line':
      return [
        { index: 0, label: '시작 가격' },
        { index: 1, label: '끝 가격' },
      ];
    // 박스는 두 점의 위아래가 정해져 있지 않다 — 그린 순서 그대로 부른다.
    case 'rect':
      return [
        { index: 0, label: '가격 1' },
        { index: 1, label: '가격 2' },
      ];
    case 'long':
    case 'short':
      return [
        { index: 0, label: '진입가' },
        { index: 1, label: '손절가' },
        { index: 2, label: '목표가' },
      ];
  }
}

/**
 * 입력칸을 처음 채울 값 — 차트에 보이는 만큼만 적는다.
 *
 * 좌표는 누른 픽셀을 가격으로 되돌린 값이라 `64193.50079339903`처럼 끝이 지저분하다.
 * 가격축이 `64,193.50`으로 보여 주는 값을 고치라고 여는 칸인데 다른 숫자가 적혀 있으면
 * 고쳐 넣기 전에 지우는 일부터 하게 된다.
 *
 * 1 미만 가격(저가 종목)은 소수 둘째 자리에서 뭉개지므로 유효숫자를 남긴다.
 */
export function formatLevel(price: number | undefined): string {
  if (price === undefined || !Number.isFinite(price)) return '';
  const text = Math.abs(price) >= 1 ? price.toFixed(2) : price.toPrecision(6);
  // 뒤에 남는 0은 지운다 — `63500.00`보다 `63500`이 고쳐 넣기 쉽다.
  return String(Number(text));
}

/**
 * 입력칸에 적힌 글을 가격으로 읽는다.
 *
 * 자릿수 쉼표는 그대로 받는다 — 화면에 `63,500.00`으로 찍어 두고 고쳐 넣으라고 하면서
 * 쉼표를 지우게 만들 이유가 없다.
 */
export function parseLevel(raw: string): number | null {
  const text = raw.replace(/,/g, '').trim();
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
