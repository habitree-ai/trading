import { describe, expect, it } from 'vitest';

import { parseGlobal, parseMarkets } from '@/lib/research/coingecko';
import { buildSnapshotRow, type SettledSources } from '@/lib/research/collect';
import { parseFng } from '@/lib/research/fng';
import { parseFundingRate, parseOpenInterest } from '@/lib/research/okx-derivs';

function ok<T>(value: T): PromiseFulfilledResult<T> {
  return { status: 'fulfilled', value };
}

function fail(message: string): PromiseRejectedResult {
  return { status: 'rejected', reason: new Error(message) };
}

/** 전부 성공한 기본 조합 — 각 케이스가 필요한 소스만 덮어쓴다. */
function allOk(): SettledSources {
  return {
    market: ok({ price_usd: 118_000, market_cap_usd: 2.3e12, volume_24h_usd: 4.1e10 }),
    dominance: ok(58.2),
    fng: ok({ value: 71, label: 'Greed' }),
    derivs: ok({ funding_rate: 0.0001, open_interest: 2_400_000, open_interest_usd: 2.9e9 }),
    news: ok([
      { title: 't', link: 'https://example.com', source: 'X', published_at: null },
    ]),
  };
}

describe('buildSnapshotRow — allSettled 결과를 스냅샷 행으로 조립한다', () => {
  it('전부 성공하면 모든 값이 실리고 sources는 전부 ok다', () => {
    const { row, failed } = buildSnapshotRow('BTC', allOk());

    expect(failed).toEqual([]);
    expect(row.symbol).toBe('BTC');
    expect(row.price_usd).toBe(118_000);
    expect(row.dominance_pct).toBe(58.2);
    expect(row.fear_greed).toBe(71);
    expect(row.funding_rate).toBe(0.0001);
    expect(row.headlines).toHaveLength(1);
    expect(row.sources).toEqual({ coingecko: 'ok', fng: 'ok', okx: 'ok', news: 'ok' });
  });

  it('한 소스가 죽으면 그 컬럼만 null이고 sources에 사유가 남는다', () => {
    const { row, failed } = buildSnapshotRow('BTC', {
      ...allOk(),
      derivs: fail('OKX 응답 오류 429'),
    });

    expect(failed).toEqual(['okx']);
    expect(row.funding_rate).toBeNull();
    expect(row.open_interest).toBeNull();
    expect(row.open_interest_usd).toBeNull();
    expect(row.sources.okx).toBe('error: OKX 응답 오류 429');
    // 나머지는 그대로다.
    expect(row.price_usd).toBe(118_000);
    expect(row.fear_greed).toBe(71);
  });

  it('CoinGecko는 두 호출 중 하나만 죽어도 실패로 적되 살아남은 값은 싣는다', () => {
    const { row, failed } = buildSnapshotRow('BTC', {
      ...allOk(),
      dominance: fail('CoinGecko 응답 오류 429'),
    });

    expect(failed).toEqual(['coingecko']);
    expect(row.price_usd).toBe(118_000);
    expect(row.dominance_pct).toBeNull();
    expect(row.sources.coingecko).toBe('error: CoinGecko 응답 오류 429');
  });

  it('뉴스가 죽으면 헤드라인은 빈 배열이다', () => {
    const { row } = buildSnapshotRow('BTC', { ...allOk(), news: fail('타임아웃') });
    expect(row.headlines).toEqual([]);
    expect(row.sources.news).toBe('error: 타임아웃');
  });

  it('전부 죽으면 failed가 소스 전체다 — 호출부가 이걸 보고 저장을 포기한다', () => {
    const dead: SettledSources = {
      market: fail('a'),
      dominance: fail('b'),
      fng: fail('c'),
      derivs: fail('d'),
      news: fail('e'),
    };

    const { failed } = buildSnapshotRow('BTC', dead);
    expect(failed).toEqual(['coingecko', 'fng', 'okx', 'news']);
  });
});

describe('소스별 순수 파서 — 외부 응답의 형태를 믿지 않는다', () => {
  it('parseMarkets: 정상 응답과 빈 배열', () => {
    expect(
      parseMarkets([{ current_price: 118000, market_cap: 2.3e12, total_volume: 4.1e10 }]),
    ).toEqual({ price_usd: 118000, market_cap_usd: 2.3e12, volume_24h_usd: 4.1e10 });
    expect(parseMarkets([])).toEqual({
      price_usd: null,
      market_cap_usd: null,
      volume_24h_usd: null,
    });
    expect(parseMarkets({ error: 'rate limited' }).price_usd).toBeNull();
  });

  it('parseGlobal: 심볼 소문자 키로 점유율을 찾는다', () => {
    const json = { data: { market_cap_percentage: { btc: 58.21, eth: 11.3 } } };
    expect(parseGlobal(json, 'BTC')).toBe(58.21);
    expect(parseGlobal(json, 'SOL')).toBeNull();
    expect(parseGlobal({}, 'BTC')).toBeNull();
  });

  it('parseFng: 문자열 값을 숫자로 편다', () => {
    expect(parseFng({ data: [{ value: '71', value_classification: 'Greed' }] })).toEqual({
      value: 71,
      label: 'Greed',
    });
    expect(parseFng({ data: [] })).toBeNull();
    expect(parseFng(null)).toBeNull();
  });

  it('OKX 파서: 문자열 숫자를 편다', () => {
    expect(parseFundingRate({ data: [{ fundingRate: '0.0000397' }] })).toBe(0.0000397);
    expect(parseFundingRate({ data: [] })).toBeNull();
    expect(parseOpenInterest({ data: [{ oi: '2400000', oiUsd: '2900000000' }] })).toEqual({
      open_interest: 2_400_000,
      open_interest_usd: 2_900_000_000,
    });
  });
});
