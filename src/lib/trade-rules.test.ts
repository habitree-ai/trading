import { describe, expect, it } from 'vitest';

import type { Trade } from '@/lib/domain';
import { judgeTradeRules, summarizeTradeRules } from '@/lib/trade-rules';

let seq = 0;

/** 기본은 손절·목표가 있는 청산 거래 — 어김은 테스트가 명시적으로 만든다. */
function trade(partial: Partial<Trade> = {}): Trade {
  seq += 1;
  return {
    id: `t${seq}`,
    book_id: 'b1',
    user_id: 'u1',
    seq,
    side: 'long',
    symbol: 'BTC',
    entry_at: '2026-08-27T10:00:00+09:00',
    exit_at: '2026-08-27T11:00:00+09:00',
    result: 'win',
    equity_before: null,
    equity_after: null,
    withdrawal: null,
    notional: null,
    leverage: null,
    pnl: 1,
    entry_price: 100,
    exit_price: 101,
    okx_pos_id: null,
    fee: null,
    funding_fee: null,
    realized_pnl: null,
    unrealized_pnl: null,
    margin_mode: null,
    stop_price: 99,
    okx_stop_price: null,
    okx_tp_price: null,
    okx_sl_source: null,
    tp1_price: 102,
    tp2_price: null,
    tp3_price: null,
    tp1_pct: null,
    tp2_pct: null,
    tp3_pct: null,
    setup: null,
    rationale: null,
    review: null,
    emotion: null,
    note: null,
    created_at: '2026-08-27T00:00:00Z',
    updated_at: '2026-08-27T00:00:00Z',
    ...partial,
  };
}

function verdict(trades: Trade[], id: string, rule: 'stop' | 'target' | 'daily') {
  return judgeTradeRules(trades).get(id)!.find((v) => v.rule === rule)!;
}

describe('손절·목표가 유무', () => {
  it('앱 계획값이든 거래소 값이든 하나만 있으면 지킴', () => {
    const a = trade({ stop_price: null, okx_stop_price: 98 });
    const b = trade({ stop_price: 99, okx_stop_price: null });
    expect(verdict([a, b], a.id, 'stop').kept).toBe(true);
    expect(verdict([a, b], b.id, 'stop').kept).toBe(true);
  });

  it('둘 다 없으면 어김 — 보유중이어도 판정한다', () => {
    const t = trade({ stop_price: null, okx_stop_price: null, exit_at: null, result: 'open', pnl: null });
    const v = verdict([t], t.id, 'stop');
    expect(v.kept).toBe(false);
    expect(v.reason).toContain('손절가 없음');
  });

  it('목표가는 TP1~3 · 거래소 TP 중 하나면 된다', () => {
    const a = trade({ tp1_price: null, tp3_price: 105 });
    const b = trade({ tp1_price: null, okx_tp_price: 104 });
    const c = trade({ tp1_price: null });
    const all = [a, b, c];
    expect(verdict(all, a.id, 'target').kept).toBe(true);
    expect(verdict(all, b.id, 'target').kept).toBe(true);
    expect(verdict(all, c.id, 'target').kept).toBe(false);
  });
});

describe('하루 3건 상한 · 손실 2건이면 종료 (한국 시간 하루)', () => {
  it('4번째 진입부터 어김 — 앞의 셋은 지킴', () => {
    const ts = ['09:00', '10:00', '11:00', '12:00'].map((h) =>
      trade({ entry_at: `2026-08-27T${h}:00+09:00`, exit_at: `2026-08-27T${h}:30+09:00` }),
    );
    expect(ts.slice(0, 3).every((t) => verdict(ts, t.id, 'daily').kept)).toBe(true);
    const fourth = verdict(ts, ts[3].id, 'daily');
    expect(fourth.kept).toBe(false);
    expect(fourth.reason).toContain('4번째');
  });

  it('그날 손실 2건이 확정된 뒤의 진입은 어김. 청산이 진입보다 늦은 손실은 세지 않는다', () => {
    const l1 = trade({ entry_at: '2026-08-27T09:00:00+09:00', exit_at: '2026-08-27T09:30:00+09:00', pnl: -1, result: 'loss' });
    const l2 = trade({ entry_at: '2026-08-27T10:00:00+09:00', exit_at: '2026-08-27T10:30:00+09:00', pnl: -1, result: 'loss' });
    const after = trade({ entry_at: '2026-08-27T11:00:00+09:00', exit_at: '2026-08-27T11:30:00+09:00' });
    // 두 번째 손실이 아직 안 닫혔을 때 들어간 거래 — 손실 1건만 확정된 상태였다.
    const during = trade({ entry_at: '2026-08-27T10:15:00+09:00', exit_at: '2026-08-27T10:20:00+09:00' });
    const all = [l1, l2, after, during];
    expect(verdict(all, after.id, 'daily').kept).toBe(false);
    expect(verdict(all, after.id, 'daily').reason).toContain('손실 2건');
    // during 은 그날 3번째 진입이고 앞선 손실은 1건 — 지킴.
    expect(verdict(all, during.id, 'daily').kept).toBe(true);
  });

  it('하루는 한국 시간으로 자른다 — UTC 로 같은 날이어도 KST 자정을 넘기면 다른 날', () => {
    // 08-27 23:30 KST 세 건 + 08-28 00:30 KST 한 건 → 넷째는 새 날의 첫 진입이라 지킴.
    const late = ['21:00', '22:00', '23:00'].map((h) =>
      trade({ entry_at: `2026-08-27T${h}:00+09:00`, exit_at: `2026-08-27T${h}:30+09:00` }),
    );
    const next = trade({ entry_at: '2026-08-28T00:30:00+09:00', exit_at: '2026-08-28T01:00:00+09:00' });
    const all = [...late, next];
    expect(verdict(all, next.id, 'daily').kept).toBe(true);
    expect(verdict(all, next.id, 'daily').reason).toContain('1번째');
  });

  it('전날 들어가 오늘 아침 잃은 것도 오늘의 손실이다', () => {
    const l1 = trade({ entry_at: '2026-08-26T22:00:00+09:00', exit_at: '2026-08-27T08:00:00+09:00', pnl: -1, result: 'loss' });
    const l2 = trade({ entry_at: '2026-08-27T09:00:00+09:00', exit_at: '2026-08-27T09:30:00+09:00', pnl: -1, result: 'loss' });
    const after = trade({ entry_at: '2026-08-27T10:00:00+09:00', exit_at: '2026-08-27T10:30:00+09:00' });
    expect(verdict([l1, l2, after], after.id, 'daily').kept).toBe(false);
  });
});

describe('summarizeTradeRules — 원칙별 집계', () => {
  it('어긴 거래 순번과 손익 합을 모은다. 보유중은 손익에서 뺀다', () => {
    const ok = trade();
    const brokenClosed = trade({ stop_price: null, pnl: -5, result: 'loss' });
    const brokenOpen = trade({ stop_price: null, exit_at: null, result: 'open', pnl: null });
    const all = [ok, brokenClosed, brokenOpen];
    const stop = summarizeTradeRules(all, judgeTradeRules(all)).get('stop')!;
    expect(stop.judged).toBe(3);
    expect(stop.broken).toBe(2);
    expect(stop.brokenPnl).toBe(-5);
    expect(stop.brokenTrades.map((t) => t.seq)).toEqual([brokenClosed.seq, brokenOpen.seq]);
    expect(stop.brokenTrades[1].open).toBe(true);
  });

  it('어긴 거래가 없으면 손익 합은 null', () => {
    const all = [trade(), trade()];
    expect(summarizeTradeRules(all, judgeTradeRules(all)).get('target')!.brokenPnl).toBeNull();
  });
});
