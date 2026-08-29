import { describe, expect, it } from 'vitest';

import { BAR_MS, floorToBar } from '@/lib/okx';
import {
  MAX_OVERVIEW_CANDLES,
  OVERVIEW_PAD_BARS,
  barFits,
  mostTradedSymbol,
  overviewWindow,
} from '@/lib/trade-overview';

describe('mostTradedSymbol — 패널이 먼저 보여줄 종목', () => {
  it('거래가 가장 많은 종목을 고른다', () => {
    const trades = [{ symbol: 'TRUMP' }, { symbol: 'BTC' }, { symbol: 'BTC' }];
    expect(mostTradedSymbol(trades)).toBe('BTC');
  });

  it('동률이면 먼저 나온 종목이다', () => {
    expect(mostTradedSymbol([{ symbol: 'ETH' }, { symbol: 'BTC' }])).toBe('ETH');
  });

  it('빈 목록은 null', () => {
    expect(mostTradedSymbol([])).toBeNull();
  });
});

describe('overviewWindow — 첫 진입부터 마지막 청산까지', () => {
  const day = 24 * 60 * 60_000;
  const t0 = Date.parse('2026-08-01T00:00:00Z');

  it('빈 목록은 null', () => {
    expect(overviewWindow([], t0)).toBeNull();
  });

  it('닫힌 거래들은 첫 진입 − 여유 ~ 마지막 청산 + 여유', () => {
    const trades = [
      { entry_at: new Date(t0 + 3 * day).toISOString(), exit_at: new Date(t0 + 4 * day).toISOString() },
      { entry_at: new Date(t0).toISOString(), exit_at: new Date(t0 + 1 * day).toISOString() },
    ];
    const w = overviewWindow(trades, t0 + 30 * day);
    expect(w).not.toBeNull();
    const pad = BAR_MS[w!.bar] * OVERVIEW_PAD_BARS;
    expect(w!.from).toBe(t0 - pad);
    expect(w!.to).toBe(t0 + 4 * day + pad);
  });

  it('보유중인 거래가 있으면 끝은 봉 눈금에 맞춘 지금이다', () => {
    const now = t0 + 10 * day + 12_345;
    const trades = [
      { entry_at: new Date(t0).toISOString(), exit_at: new Date(t0 + 1 * day).toISOString() },
      { entry_at: new Date(t0 + 5 * day).toISOString(), exit_at: null },
    ];
    const w = overviewWindow(trades, now)!;
    const pad = BAR_MS[w.bar] * OVERVIEW_PAD_BARS;
    expect(w.to).toBe(floorToBar(now, w.bar) + pad);
    // 청산 시각(t0+1일)이 아니라 지금까지다.
    expect(w.to).toBeGreaterThan(t0 + 5 * day);
  });

  it('봉은 전체 기간이 600봉 안팎에 담기도록 고른다', () => {
    // 4일 ≈ 15분봉 384개 / 5분봉 1,152개 → 15분봉이 600 에 더 가깝다.
    const trades = [
      { entry_at: new Date(t0).toISOString(), exit_at: new Date(t0 + 4 * day).toISOString() },
    ];
    expect(overviewWindow(trades, t0 + 9 * day)!.bar).toBe('15m');
    // 1년 → 1일봉 365개(4시간봉은 2,190개).
    const year = [
      { entry_at: new Date(t0).toISOString(), exit_at: new Date(t0 + 365 * day).toISOString() },
    ];
    expect(overviewWindow(year, t0 + 400 * day)!.bar).toBe('1D');
  });

  it('봉을 손으로 주면 그 봉으로 구간·여유를 잡는다', () => {
    const trades = [
      { entry_at: new Date(t0).toISOString(), exit_at: new Date(t0 + 4 * day).toISOString() },
    ];
    const w = overviewWindow(trades, t0 + 9 * day, '1H')!;
    expect(w.bar).toBe('1H');
    expect(w.from).toBe(t0 - BAR_MS['1H'] * OVERVIEW_PAD_BARS);
    expect(w.spanMs).toBe(4 * day);
  });
});

describe('barFits — 한 구간 4,000봉 상한', () => {
  const day = 24 * 60 * 60_000;

  it('5일을 1분봉으로 보면 7,200봉이라 못 고른다. 5분봉(1,440)은 된다', () => {
    expect(barFits(5 * day, '1m')).toBe(false);
    expect(barFits(5 * day, '5m')).toBe(true);
  });

  it('상한 딱 맞는 것은 허용한다', () => {
    expect(barFits(MAX_OVERVIEW_CANDLES * BAR_MS['15m'], '15m')).toBe(true);
    expect(barFits(MAX_OVERVIEW_CANDLES * BAR_MS['15m'] + 1, '15m')).toBe(false);
  });
});
