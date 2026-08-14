/**
 * 뉴스 RSS — 헤드라인만 걷는다. 본문을 긁지 않으므로 약관 문제가 없다.
 *
 * RSS 2.0의 `<item><title><link><pubDate>`만 필요해서 XML 파서 의존성을 넣지
 * 않았다. 피드 형식이 바뀌면 여기 한 파일만 고치면 된다. 파서는 어떤 입력에도
 * throw하지 않는다 — 형태가 어긋난 item은 그 건만 버린다.
 */

import type { ResearchHeadline } from "@/lib/domain";

/** 피드 목록 — 소스를 바꾸려면 여기만 고친다. */
const FEEDS = [
  { source: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { source: "Cointelegraph", url: "https://cointelegraph.com/rss" },
] as const;

function stripCdata(value: string): string {
  const match = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return match ? match[1] : value;
}

/** 최소 엔티티만 되돌린다. `&amp;`는 맨 뒤 — 먼저 풀면 이중 인코딩이 새 엔티티를 만든다. */
function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tagText(block: string, name: string): string | null {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (!match) return null;
  const text = decodeEntities(stripCdata(match[1].trim())).trim();
  return text === "" ? null : text;
}

/** RSS 2.0 문서에서 헤드라인을 뽑는다. 어떤 입력에도 throw 없이 `[]`로 강하한다. */
export function parseRssItems(xml: string, source: string, limit = 8): ResearchHeadline[] {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const out: ResearchHeadline[] = [];

  for (const block of items) {
    if (out.length >= limit) break;

    const title = tagText(block, "title");
    const link = tagText(block, "link");
    // 링크는 화면에서 <a href>로 나가는 값이다 — http(s)만 통과시킨다.
    if (!title || !link || !/^https?:\/\//i.test(link)) continue;

    const pubDate = tagText(block, "pubDate");
    const parsed = pubDate ? new Date(pubDate) : null;

    out.push({
      title,
      link,
      source,
      published_at: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
    });
  }

  return out;
}

/** 피드별로 걷어 최신순으로 합친다. 한 피드가 죽어도 나머지는 오고, 전부 죽으면 throw. */
export async function fetchHeadlines(limitPerFeed = 8): Promise<ResearchHeadline[]> {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const res = await fetch(feed.url, {
        cache: "no-store",
        headers: { accept: "application/rss+xml, application/xml, text/xml" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`${feed.source} 응답 오류 ${res.status}`);
      return parseRssItems(await res.text(), feed.source, limitPerFeed);
    }),
  );

  const ok = results.filter(
    (r): r is PromiseFulfilledResult<ResearchHeadline[]> => r.status === "fulfilled",
  );
  if (ok.length === 0) {
    const first = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    const cause = first?.reason;
    throw new Error(cause instanceof Error ? cause.message : "모든 피드가 실패했습니다");
  }

  return ok
    .flatMap((r) => r.value)
    .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
}
