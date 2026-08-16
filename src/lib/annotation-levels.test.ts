import { describe, expect, it } from 'vitest';

import { formatLevel, levelFields, parseLevel } from '@/lib/annotation-levels';
import { ANNOTATION_KINDS } from '@/lib/domain';
import { pointCount } from '@/lib/annotations';

describe('levelFields', () => {
  it('종류마다 그 종류의 점 수만큼 칸을 낸다', () => {
    for (const kind of ANNOTATION_KINDS) {
      expect(levelFields(kind)).toHaveLength(pointCount(kind));
    }
  });

  /* 입력칸이 없는 자리를 가리키면 저장할 때 좌표가 통째로 어긋난다. */
  it('가리키는 자리가 좌표 범위를 벗어나지 않는다', () => {
    for (const kind of ANNOTATION_KINDS) {
      for (const field of levelFields(kind)) {
        expect(field.index).toBeGreaterThanOrEqual(0);
        expect(field.index).toBeLessThan(pointCount(kind));
      }
    }
  });

  it('손익 툴은 진입·손절·목표 순서 그대로다', () => {
    expect(levelFields('long').map((f) => f.label)).toEqual(['진입가', '손절가', '목표가']);
    expect(levelFields('short').map((f) => f.index)).toEqual([0, 1, 2]);
  });
});

describe('formatLevel', () => {
  it('픽셀에서 되돌린 값의 지저분한 꼬리를 자른다 — 가격축과 같은 소수 2자리', () => {
    expect(formatLevel(64193.50079339903)).toBe('64193.5');
    expect(formatLevel(62961.438491)).toBe('62961.44');
  });

  it('1 미만 가격은 2자리로 뭉개지 않는다', () => {
    expect(formatLevel(0.00001234567)).toBe('0.0000123457');
    expect(formatLevel(0.0823)).toBe('0.0823');
  });

  it('값이 아니면 빈 칸', () => {
    expect(formatLevel(undefined)).toBe('');
    expect(formatLevel(Number.NaN)).toBe('');
  });

  /* 한 번 적용한 값을 다시 열었을 때 또 반올림되면 도형이 조금씩 미끄러진다. */
  it('적용한 값을 다시 열어도 같은 글이다', () => {
    for (const price of [64193.50079339903, 0.0823, 12345.678]) {
      const text = formatLevel(price);
      expect(formatLevel(parseLevel(text) ?? Number.NaN)).toBe(text);
    }
  });
});

describe('parseLevel', () => {
  it('자릿수 쉼표를 그대로 받는다 — 화면에 찍힌 값을 고쳐 넣게 된다', () => {
    expect(parseLevel('63,500.25')).toBe(63500.25);
  });

  it('앞뒤 공백은 무시한다', () => {
    expect(parseLevel('  100 ')).toBe(100);
  });

  it('비었거나 숫자가 아니면 null', () => {
    expect(parseLevel('')).toBeNull();
    expect(parseLevel('   ')).toBeNull();
    expect(parseLevel('육만삼천')).toBeNull();
  });

  it('0과 음수도 값이다 — 비어 있음과 구분한다', () => {
    expect(parseLevel('0')).toBe(0);
    expect(parseLevel('-1.5')).toBe(-1.5);
  });
});
