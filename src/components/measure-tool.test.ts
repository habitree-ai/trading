import { describe, expect, it } from 'vitest';

import { formatDuration, measure } from '@/components/measure-tool';

const HOUR = 3600;

describe('measure — 트레이딩뷰 자 도구의 계산', () => {
  it('가격 변화와 비율을 낸다', () => {
    const r = measure(
      { time: 0, price: 64_800 },
      { time: 4 * HOUR, price: 65_380 },
      300,
    );

    expect(r.priceDelta).toBe(580);
    expect(r.pctDelta).toBeCloseTo(580 / 64800, 8);
    expect(r.up).toBe(true);
  });

  it('오른쪽에서 왼쪽으로 끌어도 같은 결과가 나온다', () => {
    const a = { time: 0, price: 64_800 };
    const b = { time: 4 * HOUR, price: 65_380 };

    expect(measure(b, a, 300)).toEqual(measure(a, b, 300));
  });

  it('내려간 구간은 음수로 표시한다', () => {
    const r = measure({ time: 0, price: 65_380 }, { time: HOUR, price: 64_933.3 }, 300);

    expect(r.priceDelta).toBeCloseTo(-446.7, 4);
    expect(r.pctDelta).toBeLessThan(0);
    expect(r.up).toBe(false);
  });

  it('기간과 봉 개수를 센다 — 양 끝을 포함한다', () => {
    // 5분봉으로 1시간이면 12칸 = 13개 봉
    const r = measure({ time: 0, price: 100 }, { time: HOUR, price: 100 }, 300);

    expect(r.durationMs).toBe(3_600_000);
    expect(r.bars).toBe(13);
  });

  it('같은 지점을 찍으면 변화 0, 봉 1개', () => {
    const r = measure({ time: 1000, price: 100 }, { time: 1000, price: 100 }, 300);

    expect(r.priceDelta).toBe(0);
    expect(r.pctDelta).toBe(0);
    expect(r.durationMs).toBe(0);
    expect(r.bars).toBe(1);
  });

  it('시작가가 0이면 비율은 정의되지 않는다', () => {
    expect(measure({ time: 0, price: 0 }, { time: HOUR, price: 10 }, 300).pctDelta).toBeNull();
  });

  it('실제 거래 구간(진입 1 → 청산 1)을 잰다', () => {
    // 06:47:23 64,800.4 → 07:32:50 65,380
    const r = measure(
      { time: Date.parse('2026-07-26T21:47:23Z') / 1000, price: 64_800.4 },
      { time: Date.parse('2026-07-26T22:32:50Z') / 1000, price: 65_380 },
      300,
    );

    expect(r.priceDelta).toBeCloseTo(579.6, 2);
    expect(r.pctDelta).toBeCloseTo(0.008944, 5);
    expect(formatDuration(r.durationMs)).toBe('45분 27초');
  });
});

describe('formatDuration — 큰 단위부터 두 자리만', () => {
  it.each([
    [0, '0초'],
    [45_000, '45초'],
    [90_000, '1분 30초'],
    [3_600_000, '1시간'],
    [3_930_000, '1시간 5분'],
    [90_000_000, '1일 1시간'],
  ])('%i ms → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('음수도 길이로 다룬다', () => {
    expect(formatDuration(-90_000)).toBe('1분 30초');
  });
});
