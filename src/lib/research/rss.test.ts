import { describe, expect, it } from 'vitest';

import { parseRssItems } from '@/lib/research/rss';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <item>
      <title><![CDATA[Bitcoin Tops $100K — What&#39;s Next]]></title>
      <link>https://example.com/a</link>
      <pubDate>Fri, 14 Aug 2026 09:30:00 GMT</pubDate>
    </item>
    <item>
      <title>SEC &amp; CFTC Reach Deal on Crypto &lt;Rules&gt;</title>
      <link>https://example.com/b</link>
      <pubDate>Thu, 13 Aug 2026 22:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`;

describe('parseRssItems — RSS 2.0에서 헤드라인만 뽑는다', () => {
  it('CDATA와 엔티티를 풀어 제목·링크·시각을 뽑는다', () => {
    const items = parseRssItems(FEED, 'Example');

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: "Bitcoin Tops $100K — What's Next",
      link: 'https://example.com/a',
      source: 'Example',
      published_at: '2026-08-14T09:30:00.000Z',
    });
    expect(items[1].title).toBe('SEC & CFTC Reach Deal on Crypto <Rules>');
  });

  it('제목이나 링크가 빠진 item은 그 건만 버린다', () => {
    const xml = `<rss><channel>
      <item><title>링크 없음</title></item>
      <item><title>정상</title><link>https://example.com/ok</link></item>
    </channel></rss>`;

    const items = parseRssItems(xml, 'X');
    expect(items).toHaveLength(1);
    expect(items[0].link).toBe('https://example.com/ok');
  });

  it('http(s)가 아닌 링크는 버린다 — 화면의 <a href>로 나가는 값이다', () => {
    const xml = `<rss><channel>
      <item><title>수상한 링크</title><link>javascript:alert(1)</link></item>
    </channel></rss>`;

    expect(parseRssItems(xml, 'X')).toEqual([]);
  });

  it('pubDate가 깨져 있으면 시각만 null로 둔다', () => {
    const xml = `<rss><channel>
      <item><title>t</title><link>https://example.com</link><pubDate>어제쯤</pubDate></item>
    </channel></rss>`;

    expect(parseRssItems(xml, 'X')[0].published_at).toBeNull();
  });

  it('깨진 XML·빈 문자열·item 없는 문서는 빈 배열이다 — throw하지 않는다', () => {
    expect(parseRssItems('', 'X')).toEqual([]);
    expect(parseRssItems('<rss><channel><item><title>잘림', 'X')).toEqual([]);
    expect(parseRssItems('<feed><entry><title>Atom</title></entry></feed>', 'X')).toEqual([]);
  });

  it('limit을 넘는 item은 자른다', () => {
    const items = Array.from(
      { length: 5 },
      (_, i) => `<item><title>t${i}</title><link>https://example.com/${i}</link></item>`,
    ).join('');

    expect(parseRssItems(`<rss><channel>${items}</channel></rss>`, 'X', 3)).toHaveLength(3);
  });
});
