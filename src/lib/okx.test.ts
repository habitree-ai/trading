import { describe, expect, it } from 'vitest';

import {
  BAR_MS,
  MAX_CANDLE_PAGES,
  candleCursors,
  floorToBar,
  pickBar,
  toInstId,
  windowFor,
} from '@/lib/okx';

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

  it('아직 들고 있으면 지금까지 열어 준다 — 진입 뒤 시세가 화면에 남아야 한다', () => {
    const now = Date.parse('2026-07-27T09:00:00Z');
    const w = windowFor(entry, now, '1H', 5);
    expect(w.to).toBe(now + 5 * BAR_MS['1H']);
  });

  it('끝이 진입보다 앞서도 구간이 뒤집히지 않는다', () => {
    const w = windowFor(entry, entry - 60_000, '1H', 5);
    expect(w.to).toBe(entry + 5 * BAR_MS['1H']);
    expect(w.to).toBeGreaterThan(w.from);
  });
});

describe('floorToBar — 진행 중인 봉의 시작으로 뭉뚱그린다', () => {
  it('같은 봉 안에서는 같은 값이 나온다 — 캐시가 빗나가지 않게', () => {
    const at = Date.parse('2026-07-27T04:37:41Z');
    expect(floorToBar(at, '15m')).toBe(Date.parse('2026-07-27T04:30:00Z'));
    expect(floorToBar(at + 60_000, '15m')).toBe(floorToBar(at, '15m'));
  });

  it('봉이 넘어가면 값도 넘어간다', () => {
    const at = Date.parse('2026-07-27T04:59:59Z');
    expect(floorToBar(at + 1_000, '1H')).toBe(Date.parse('2026-07-27T05:00:00Z'));
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

describe('candleCursors — 닫힌 봉 경계를 주면 from 기준 안정 커서로 캐시를 맞춘다', () => {
  const to = Date.parse('2026-07-27T00:00:00Z');
  const page = (bar: Parameters<typeof candleCursors>[0]) => BAR_MS[bar] * 100;

  /** 각 커서 a 가 (a−span, a] 를 덮는다고 보고, from~to 전체가 빈틈 없이 덮이는지. */
  const covers = (cursors: number[], span: number, from: number, until: number) => {
    let reached = from;
    for (const a of [...cursors].sort((x, y) => x - y)) {
      if (a - span > reached) return false;
      reached = Math.max(reached, a);
    }
    return reached >= until;
  };

  it('경계가 없으면 예전 그대로 to 기준이다', () => {
    const from = to - 250 * BAR_MS['15m'];
    expect(candleCursors('15m', from, to, MAX_CANDLE_PAGES, undefined)).toEqual(
      candleCursors('15m', from, to),
    );
  });

  it('전부 닫혔으면 안정 커서는 from 에서 올라오고, to 가 한 봉 밀려도 그대로다', () => {
    const from = to - 250 * BAR_MS['15m'];
    const first = candleCursors('15m', from, to, MAX_CANDLE_PAGES, to);
    expect(first).toEqual([to, from + 2 * page('15m'), from + page('15m')]);

    const shifted = to + BAR_MS['15m'];
    const second = candleCursors('15m', from, shifted, MAX_CANDLE_PAGES, shifted);
    // 끝 페이지 하나만 바뀌고 앞쪽(안정) 커서는 같다 — 하루 캐시가 그대로 맞는다.
    expect(second[0]).toBe(shifted);
    expect(second.slice(1)).toEqual(first.slice(1));
  });

  it('페이지 수는 예전과 같다 — 안정 n + 최근 1', () => {
    const from = to - 250 * BAR_MS['15m'];
    expect(candleCursors('15m', from, to, MAX_CANDLE_PAGES, to)).toHaveLength(
      candleCursors('15m', from, to).length,
    );
    // 구간이 페이지의 정수배여도 마찬가지.
    const exact = to - 300 * BAR_MS['15m'];
    expect(candleCursors('15m', exact, to, MAX_CANDLE_PAGES, to)).toHaveLength(3);
  });

  it('닫힌 경계가 중간에 있으면 안정 커서와 최근 커서를 이어 붙인다', () => {
    const from = to - 350 * BAR_MS['1H'];
    const closed = to - 120 * BAR_MS['1H'];
    const cursors = candleCursors('1H', from, to, MAX_CANDLE_PAGES, closed);

    // 안정: from+100h, from+200h(=to−150h). from+300h 는 경계를 넘어 빠진다.
    // 최근: to, to−100h — to−100h 페이지가 to−200h 까지 내려와 안정 커서에 닿는다.
    expect(cursors).toEqual([to, to - page('1H'), from + 2 * page('1H'), from + page('1H')]);
    // 경계 아래는 전부 안정 커서(from 기준), 위는 전부 최근 커서(to 기준).
    expect(cursors.filter((a) => a <= closed)).toEqual([from + 2 * page('1H'), from + page('1H')]);
    expect(cursors.filter((a) => a > closed)).toEqual([to, to - page('1H')]);
  });

  it('경계와 같은 커서는 안정으로 두지 않는다 — 1D·1W 는 OKX 봉이 16:00 UTC 에 시작해 그 페이지에 진행 중 봉이 든다', () => {
    // 진입 2026-01-15 03:00Z, 지금은 100일 뒤 05:00Z. floorToBar(지금) = 04-25 00:00Z 인데 진행 중 일봉은 04-24 16:00Z 시작.
    const from = floorToBar(Date.parse('2026-01-15T03:00:00Z'), '1D');
    const closed = from + 100 * BAR_MS['1D'];
    const until = closed + BAR_MS['1D'];
    const cursors = candleCursors('1D', from, until, MAX_CANDLE_PAGES, closed);

    // after=04-25 00:00Z 페이지의 최신 봉은 04-24 16:00Z(진행 중) — 하루 캐시하면 안 된다.
    // 안정 커서 없이 전부 to 기준으로 내려온다(to 격자).
    expect(cursors).not.toContain(closed);
    expect(cursors.every((a) => (until - a) % page('1D') === 0)).toBe(true);
    expect(covers(cursors, page('1D'), from, until)).toBe(true);
  });

  it('커버 구간에 빈틈도 중복 커서도 없다', () => {
    const cases: Array<[Parameters<typeof candleCursors>[0], number, number | undefined]> = [
      ['15m', 250, to],
      ['15m', 300, to],
      ['1H', 350, to - 120 * BAR_MS['1H']],
      ['1H', 350, to - 1],
      ['5m', 1_001, to - 7 * BAR_MS['5m']],
      ['1H', 50, to],
      ['1H', 250, undefined],
    ];
    for (const [bar, bars, closed] of cases) {
      const from = to - bars * BAR_MS[bar];
      const cursors = candleCursors(bar, from, to, MAX_CANDLE_PAGES, closed);
      expect(covers(cursors, page(bar), from, to), `${bar} ${bars}봉`).toBe(true);
      expect(new Set(cursors).size, `${bar} ${bars}봉 중복`).toBe(cursors.length);
    }
  });

  it('상한을 넘으면 오래된 쪽을 자른다', () => {
    const from = to - 1_000 * BAR_MS['1H'];
    const full = candleCursors('1H', from, to, Infinity, to);
    const limited = candleCursors('1H', from, to, 4, to);

    expect(full).toHaveLength(10);
    expect(limited).toEqual(full.slice(0, 4));
    expect(Math.min(...limited)).toBeGreaterThan(Math.min(...full));
  });
});
