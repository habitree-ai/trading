import { describe, expect, it } from 'vitest';

import { parseNotesUpdate } from './fields';

const UID = 'user-1';

function form(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

describe('parseNotesUpdate — 근거 카드', () => {
  it('분류·셋업·근거 글만 싣고 복기 칸은 건드리지 않는다', () => {
    const r = parseNotesUpdate(
      'basis',
      form([
        ['trend', 'up'],
        ['timeframe_bias', '4H'],
        ['timeframe_entry', '15m'],
        ['openness', 'top_closed'],
        ['setup', ' 돌파 리테스트 '],
        ['rationale', '1H 저항 돌파 후 되돌림'],
        ['review', '이 값은 무시돼야 한다'],
      ]),
      UID,
    );
    expect(r).toEqual({
      update: {
        trend: 'up',
        timeframe_bias: '4H',
        timeframe_entry: '15m',
        openness: 'top_closed',
        setup: '돌파 리테스트',
        rationale: '1H 저항 돌파 후 되돌림',
      },
    });
  });

  it('빈 칸은 null — 지우겠다는 뜻이다', () => {
    const r = parseNotesUpdate(
      'basis',
      form([
        ['trend', ''],
        ['timeframe_bias', ''],
        ['timeframe_entry', ''],
        ['openness', ''],
        ['setup', '  '],
        ['rationale', ''],
      ]),
      UID,
    );
    expect(r).toEqual({
      update: {
        trend: null,
        timeframe_bias: null,
        timeframe_entry: null,
        openness: null,
        setup: null,
        rationale: null,
      },
    });
  });

  it('목록 밖 값은 거부한다 — DB CHECK 에 막히기 전에', () => {
    expect(parseNotesUpdate('basis', form([['trend', 'sideways']]), UID)).toHaveProperty('error');
    // 진입 시계열에 일봉은 없다.
    expect(parseNotesUpdate('basis', form([['timeframe_entry', '1D']]), UID)).toHaveProperty('error');
    expect(parseNotesUpdate('basis', form([['timeframe_bias', '1m']]), UID)).toHaveProperty('error');
    expect(parseNotesUpdate('basis', form([['openness', 'open']]), UID)).toHaveProperty('error');
  });
});

describe('parseNotesUpdate — 복기 카드', () => {
  it('복기·감정·비고·사진만 싣는다', () => {
    const r = parseNotesUpdate(
      'review',
      form([
        ['review', '손절이 너무 좁았다'],
        ['emotion', '조급'],
        ['note', ''],
        ['image_paths', `${UID}/a.png`],
        ['image_paths', 'other/b.png'],
        ['rationale', '무시'],
      ]),
      UID,
    );
    expect(r).toEqual({
      update: {
        review: '손절이 너무 좁았다',
        emotion: '조급',
        note: null,
        image_paths: [`${UID}/a.png`],
      },
    });
  });
});

it('알 수 없는 구역은 거부한다', () => {
  expect(parseNotesUpdate('numbers', form([]), UID)).toHaveProperty('error');
});
