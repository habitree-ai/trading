import { describe, expect, it } from 'vitest';

import { okxPositionAdapter } from '@/lib/extract/okx-position';
import { extractFromText } from '@/lib/extract';

/** 롱 · 주문 2건 · `Closed --`(부분청산으로 포지션 잔존). */
const LONG_PARTIAL = `15:45
BTCUSDT Perpetual Long
Realized PnL (USDT)
+30.36
Closed (USDT)
8,458.84
Closed PnL +35.31 USDT
Trading fee -4.95225492 USDT
Funding fee --
Time opened 07/27/2026, 10:47:53
Closed --

Order history

Close long 07/27, 13:20:35 +35.31 USDT
Filled 8,494.16 USDT
Fill price ₮65,390
Fee -1.27412415 USDT
Order number 0000000000000000000

Open long 07/27, 10:47:53
Filled 10,217.03 USDT
Fill price ₮65,118.1
Fee -3.67813076 USDT
Order number 0000000000000000000`;

/** 숏 · 손실 · 완전청산. 배지 색이 롱과 뒤집혀 나오는 화면. */
const SHORT_LOSS = `15:45
BTCUSDT Perpetual Short
Realized PnL (USDT)
-26.51
Closed (USDT)
9,674.71
Closed PnL -19.54 USDT
Trading fee -6.97282438 USDT
Funding fee --
Time opened 07/27/2026, 05:37:45
Closed 07/27/2026, 06:24:56

Order history

Close short 07/27, 06:24:56 -19.54 USDT
Filled 9,694.25 USDT
Fill price ₮64,757.84762859
Fee -3.48992992 USDT
Order number 0000000000000000000

Open short 07/27, 05:37:45
Filled 9,674.71 USDT
Fill price ₮64,627.3
Fee -3.48289445 USDT
Order number 0000000000000000000`;

/** 분할 진입 2건 + 분할 청산 2건 · 펀딩피 있음. */
const SPLIT_FILLS = `15:45
BTCUSDT Perpetual Long
Realized PnL (USDT)
+52.13
Closed (USDT)
10,685.02
Closed PnL +57.62 USDT
Trading fee -5.28103906 USDT
Funding fee -0.20918 USDT
Time opened 07/27/2026, 06:47:23
Closed 07/27/2026, 10:35:07

Order history

Close long 07/27, 10:35:07 +0.77 USDT
Filled 2,746.68 USDT
Fill price ₮64,933.3
Fee -0.98880429 USDT
Order number 0000000000000000000

Close long 07/27, 07:32:50 +56.85 USDT
Filled 7,995.97 USDT
Fill price ₮65,380
Fee -1.1993961 USDT
Order number 0000000000000000000

Open long 07/27, 07:05:12
Filled 3,589.38 USDT
Fill price ₮65,143
Fee -0.53840689 USDT
Order number 0000000000000000000

Open long 07/27, 06:47:23
Filled 7,095.64 USDT
Fill price ₮64,800.4
Fee -2.55443176 USDT
Order number 0000000000000000000`;

describe('OKX 포지션 상세 — 진입·청산이 한 장에 있다', () => {
  const r = okxPositionAdapter.parse(LONG_PARTIAL);

  it('주문 상세 화면이 아니라 포지션 상세 화면으로 인식한다', () => {
    expect(okxPositionAdapter.detect(LONG_PARTIAL)).toBeGreaterThan(0.9);
    expect(extractFromText(LONG_PARTIAL)?.adapter).toBe('okx-position');
  });

  it('진입가와 청산가를 모두 채운다 — 캡쳐 한 장으로 거래가 완성된다', () => {
    expect(r.fields.entry_price).toBeCloseTo(65118.1, 1);
    expect(r.fields.exit_price).toBeCloseTo(65390, 1);
    expect(r.fields.side).toBe('long');
  });

  it('진입 시각은 연도가 붙은 `Time opened`를 쓴다', () => {
    // 2026-07-27 10:47:53 KST == 01:47:53Z
    expect(r.fields.entry_at).toBe('2026-07-27T01:47:53.000Z');
    expect(r.fields.exit_at).toBe('2026-07-27T04:20:35.000Z');
  });

  it('손익은 총액, 수수료는 거래+펀딩 합계로 나눠 담는다', () => {
    expect(r.fields.pnl).toBe(35.31);
    expect(r.fields.fee).toBeCloseTo(-4.95225492, 6);
    // 손익 + 수수료 == 화면의 실현손익 +30.36
    expect(r.fields.pnl! + r.fields.fee!).toBeCloseTo(30.36, 2);
  });

  it('`Closed --` 는 포지션이 아직 열려 있다는 뜻이라 알린다', () => {
    expect(r.notes.join(' ')).toContain('포지션이 아직 열려 있습니다');
    expect(r.suspect).toContain('exit_at');
  });
});

describe('OKX 포지션 상세 — 숏 손실 (배지 색이 뒤집힌 화면)', () => {
  const r = okxPositionAdapter.parse(SHORT_LOSS);

  it('`Close short`가 초록이어도 방향을 숏으로 읽는다', () => {
    expect(r.fields.side).toBe('short');
  });

  it('숏은 가격이 오르면 손실이다', () => {
    expect(r.fields.entry_price).toBeCloseTo(64627.3, 1);
    expect(r.fields.exit_price).toBeCloseTo(64757.85, 1);
    expect(r.fields.pnl).toBe(-19.54);
  });

  it('완전청산이면 `Closed` 시각을 청산 시각으로 쓴다', () => {
    // 2026-07-27 06:24:56 KST == 2026-07-26T21:24:56Z
    expect(r.fields.exit_at).toBe('2026-07-26T21:24:56.000Z');
    expect(r.notes.join(' ')).not.toContain('아직 열려');
  });

  it('실현손익 대조가 맞는다', () => {
    expect(r.fields.pnl! + r.fields.fee!).toBeCloseTo(-26.51, 2);
  });
});

describe('OKX 포지션 상세 — 분할 진입·분할 청산', () => {
  const r = okxPositionAdapter.parse(SPLIT_FILLS);

  it('진입 명목가는 체결 합계다 — 화면의 Closed(USDT)와 일치', () => {
    expect(r.fields.notional).toBeCloseTo(10685.02, 2);
  });

  it('평균가는 단순평균이 아니라 수량가중이다', () => {
    // 단순평균이면 (65143 + 64800.4)/2 = 64971.7 — 그 값이면 안 된다.
    expect(r.fields.entry_price).toBeCloseTo(64915.09, 1);
    expect(r.fields.entry_price).not.toBeCloseTo(64971.7, 0);
    expect(r.fields.exit_price).toBeCloseTo(65265.2, 1);
    // 체결가 자리수(소수 1자리)로 잘려 폼에 부동소수 꼬리가 남지 않는다.
    expect(r.fields.entry_price).toBe(64915.1);
    expect(r.fields.exit_price).toBe(65265.2);
  });

  it('가중평균가로 되짚은 손익이 화면의 Closed PnL과 맞는다', () => {
    const qty = r.fields.notional! / r.fields.entry_price!;
    const implied = qty * (r.fields.exit_price! - r.fields.entry_price!);
    expect(implied).toBeCloseTo(57.62, 0);
  });

  it('펀딩피를 수수료에 합산한다', () => {
    expect(r.fields.fee).toBeCloseTo(-5.28103906 - 0.20918, 6);
    expect(r.fields.pnl! + r.fields.fee!).toBeCloseTo(52.13, 2);
  });

  it('합쳤다는 사실을 알린다', () => {
    expect(r.notes.join(' ')).toContain('분할 체결(진입 2건 · 청산 2건)');
  });

  it('필수 항목이 다 차 신뢰도가 1이다', () => {
    expect(r.confidence).toBe(1);
  });
});

describe('어댑터 선택 — 주문 상세와 포지션 상세를 헷갈리지 않는다', () => {
  it('`Order history`가 없는 주문 상세는 okx 어댑터로 간다', () => {
    const orderDetails = `Order details
BTCUSDT Perp
Close long Cross 100x
Fill price ₮65,390
Closed PnL 35.31 USDT
Closed PnL% 41.75%
Fee -1.27412415 USDT
Creation time 07/27, 10:48:15`;
    expect(extractFromText(orderDetails)?.adapter).toBe('okx');
  });
});
