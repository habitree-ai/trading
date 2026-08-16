import { describe, expect, it, vi, afterEach } from 'vitest';

import { loadBenchmark } from '@/lib/benchmark';
import * as okx from '@/lib/okx';

/** 하루 간격 일봉 — 종가만 의미가 있다. */
function candles(...days: [string, number][]) {
  return days.map(([day, close]) => ({
    t: Date.parse(`${day}T00:00:00Z`),
    o: close,
    h: close,
    l: close,
    c: close,
    v: 0,
  }));
}

afterEach(() => vi.restoreAllMocks());

describe('loadBenchmark — 거래 시점의 벤치마크 값을 찾는다', () => {
  const sample = candles(
    ['2026-03-01', 100],
    ['2026-03-02', 110],
    ['2026-03-03', 120],
    ['2026-03-04', 130],
  );

  it('그 시각이 속한 일봉의 종가를 준다', async () => {
    vi.spyOn(okx, 'fetchCandles').mockResolvedValue(sample);
    const b = await loadBenchmark('2026-03-01T00:00:00Z', '2026-03-04T00:00:00Z');

    expect(b?.symbol).toBe('BTC');
    // 일봉은 UTC 자정에 열린다 — 장중 시각은 그날 봉에 붙는다.
    expect(b?.at('2026-03-02T15:00:00Z')).toBe(110);
    expect(b?.at('2026-03-03T00:00:00Z')).toBe(120);
  });

  it('경계에서 다음 봉으로 새지 않는다', async () => {
    vi.spyOn(okx, 'fetchCandles').mockResolvedValue(sample);
    const b = await loadBenchmark('2026-03-01T00:00:00Z', '2026-03-04T00:00:00Z');

    expect(b?.at('2026-03-02T23:59:59Z')).toBe(110);
    expect(b?.at('2026-03-03T00:00:00Z')).toBe(120);
  });

  it('첫 봉보다 앞이면 값이 없다 — 없는 값을 지어내지 않는다', async () => {
    vi.spyOn(okx, 'fetchCandles').mockResolvedValue(sample);
    const b = await loadBenchmark('2026-03-01T00:00:00Z', '2026-03-04T00:00:00Z');

    expect(b?.at('2026-02-28T00:00:00Z')).toBeNull();
  });

  it('마지막 봉 뒤는 그 봉의 종가로 이어 간다', async () => {
    vi.spyOn(okx, 'fetchCandles').mockResolvedValue(sample);
    const b = await loadBenchmark('2026-03-01T00:00:00Z', '2026-03-04T00:00:00Z');

    expect(b?.at('2026-03-09T00:00:00Z')).toBe(130);
  });

  it('거래소가 흔들려도 대시보드를 깨뜨리지 않는다', async () => {
    vi.spyOn(okx, 'fetchCandles').mockRejectedValue(new Error('OKX 응답 오류 502'));

    await expect(loadBenchmark('2026-03-01T00:00:00Z', '2026-03-04T00:00:00Z')).resolves.toBeNull();
  });

  it('캔들이 하나도 없으면 벤치마크를 붙이지 않는다', async () => {
    vi.spyOn(okx, 'fetchCandles').mockResolvedValue([]);

    await expect(loadBenchmark('2026-03-01T00:00:00Z', '2026-03-04T00:00:00Z')).resolves.toBeNull();
  });

  it('구간이 뒤집혀 있으면 부르지 않는다', async () => {
    const spy = vi.spyOn(okx, 'fetchCandles').mockResolvedValue(sample);

    expect(await loadBenchmark('2026-03-04T00:00:00Z', '2026-03-01T00:00:00Z')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
