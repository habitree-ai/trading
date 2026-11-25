import { describe, expect, it } from 'vitest';

import { AREAS, areaOf, isLinkActive } from '@/lib/nav';

/** 링크 주소에서 쿼리를 뗀 경로 — `usePathname()` 이 돌려주는 값과 같은 모양. */
const pathOf = (href: string) => new URL(href, 'http://localhost').pathname;

describe('영역 안의 링크는 눌러도 그 영역에 머문다', () => {
  for (const area of AREAS) {
    for (const link of area.links) {
      it(`${area.label} › ${link.label}`, () => {
        expect(areaOf(pathOf(link.href))).toBe(area.key);
      });
    }
  }
});

describe('현재 포지션 화면 (REQ-0107)', () => {
  const manual = AREAS.find((a) => a.key === 'manual')!;
  const link = manual.links.find((l) => l.label === '현재 포지션')!;

  it('수동매매 사이드바에서 그 화면을 열면 「현재 포지션」 줄이 켜진다', () => {
    expect(isLinkActive(pathOf(link.href), link.href, manual)).toBe(true);
  });

  it('과거데이터 분석은 그대로 차트·자료 영역이다', () => {
    expect(areaOf('/kelly')).toBe('lab');
  });
});
