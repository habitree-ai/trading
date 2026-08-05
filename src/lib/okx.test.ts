import { describe, expect, it } from 'vitest';

import { BAR_MS, MAX_CANDLE_PAGES, candleCursors, pickBar, toInstId, windowFor } from '@/lib/okx';

describe('toInstId — 시트의 종목명을 OKX 계약으로 편다', () => {
  it('기초자산만 있으면 USDT 무기한으로 만든다', () => {
    expect(toInstId('BTC')).toBe('BTC-USDT-SWAP');
    expect(toInstId('eth')).toBe('ETH-USDT-SWAP');
  });

  it('이미 완전한 instId는 그대로 둔다', () => {
    expect(toInstId('BTC-USDT-SWAP')).toBe('BTC-USDT-SWAP');
  });
});

describe('pickBar — 거래 길이에 맞는 봉을 고른다', () => {
  it('몇 분짜리 스캘핑은 1분봉', () => {
    expect(pickBar(8 * 60_000)).toBe('1m');
  });

  it('두어 시간짜리 거래는 분봉 단위', () => {
    // 실제 캡쳐: 10:47:53 진입 → 13:20:35 청산 (약 2.5시간)
    expect(['1m', '5m']).toContain(pickBar(2.5 * 60 * 60_000));
  });

  it('봉 개수가 60개 근처가 되게 고른다 — 너무 촘촘하면 읽을 수 없다', () => {
    // 실제 캡쳐(IMG_5086): 06:47 → 10:35, 약 3.8시간
    const duration = 3.8 * 60 * 60_000;
    const bar = pickBar(duration);
    const count = duration / BAR_MS[bar];

    expect(bar).toBe('5m');
    expect(count).toBeGreaterThan(20);
    expect(count).toBeLessThan(120);
  });

  it('며칠짜리 스윙은 시간봉 이상', () => {
    expect(BAR_MS[pickBar(5 * 24 * 60 * 60_000)]).toBeGreaterThanOrEqual(BAR_MS['1H']);
  });

  it('아주 긴 보유는 일봉을 넘지 않는다', () => {
    expect(pickBar(400 * 24 * 60 * 60_000)).toBe('1D');
  });
});

describe('windowFor — 거래 전후로 여유를 둔다', () => {
  const entry = Date.parse('2026-07-27T01:47:53Z');
  const exit = Date.parse('2026-07-27T04:20:35Z');

  it('진입 앞과 청산 뒤로 봉 개수만큼 넓힌다', () => {
    const w = windowFor(entry, exit, '4H', 10);
    expect(w.from).toBe(entry - 10 * BAR_MS['4H']);
    expect(w.to).toBe(exit + 10 * BAR_MS['4H']);
  });

  it('미청산이면 진입 시각을 끝으로 본다', () => {
    const w = windowFor(entry, null, '1H', 5);
    expect(w.to).toBe(entry + 5 * BAR_MS['1H']);
  });
});

describe('candleCursors — 페이지를 미리 계산해 한꺼번에 받는다', () => {
  const to = Date.parse('2026-07-27T00:00:00Z');
  const page = (bar: Parameters<typeof candleCursors>[0]) => BAR_MS[bar] * 100;

  it('구간이 한 페이지에 담기면 커서도 하나', () => {
    expect(candleCursors('1H', to - 50 * BAR_MS['1H'], to)).toEqual([to]);
  });

  it('커서는 100봉씩 과거로 내려간다 — 페이지 사이에 틈이 없다', () => {
    const from = to - 250 * BAR_MS['15m'];
    const cursors = candleCursors('15m', from, to);

    expect(cursors).toEqual([to, to - page('15m'), to - 2 * page('15m')]);
    // 마지막 페이지가 from 보다 앞에서 시작해야 구간 전체가 덮인다.
    expect(cursors[cursors.length - 1] - page('15m')).toBeLessThanOrEqual(from);
  });

  it('15분봉으로 2주짜리 거래도 진입까지 닿는다 — 예전 상한 12는 여기서 잘렸다', () => {
    const from = to - 14 * 24 * 60 * 60_000;
    const cursors = candleCursors('15m', from, to);

    expect(cursors.length).toBeGreaterThan(12);
    expect(cursors.length).toBeLessThanOrEqual(MAX_CANDLE_PAGES);
    expect(cursors[cursors.length - 1] - page('15m')).toBeLessThanOrEqual(from);
  });

  it('아무리 넓어도 상한을 넘지 않는다', () => {
    expect(candleCursors('1m', to - 365 * 24 * 60 * 60_000, to)).toHaveLength(MAX_CANDLE_PAGES);
  });

  it('구간이 0이하로 뒤집혀도 최소 한 장은 받는다', () => {
    expect(candleCursors('1H', to, to)).toEqual([to]);
  });
});
