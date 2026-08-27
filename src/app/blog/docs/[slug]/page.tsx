import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { findSeniorDoc, readSeniorDoc } from "@/lib/senior/docs";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const doc = findSeniorDoc(slug);
  return { title: doc ? `${doc.title} — 선배님의 20년` : "선배님의 20년" };
}

/**
 * 정리 문서 한 장 — 왼쪽 목차, 오른쪽 본문.
 *
 * 본문 HTML 은 저장소에 커밋된 내 마크다운을 `renderMarkdown` 이 만든 것이다. 외부 입력이
 * 섞일 자리가 없어 그대로 꽂는다.
 */
export default async function SeniorDocPage({ params }: Props) {
  const { slug } = await params;
  const doc = findSeniorDoc(slug);
  if (!doc) notFound();

  const rendered = readSeniorDoc(doc);
  if (!rendered) {
    return (
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">{doc.title}</h1>
        <p className="rounded-xl border border-border bg-surface p-4 text-sm text-dim">
          이 배포에 문서 파일이 없습니다 —{" "}
          <code className="rounded bg-surface-2 px-1">선배님/{doc.file}</code> 이 번들에서
          빠졌습니다. 빌드 트레이싱 설정을 확인해 주세요.
        </p>
      </div>
    );
  }

  // 첫 항목은 문서 제목(h1)이라 목차에서 뺀다 — 정리.html 과 같은 규칙.
  const toc = rendered.toc.slice(1);

  return (
    <div className="md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:gap-8">
      <aside className="mb-6 md:mb-0">
        <details className="md:hidden">
          <summary className="cursor-pointer text-sm text-dim">목차</summary>
          <TocList toc={toc} />
        </details>
        <div className="hidden md:sticky md:top-20 md:block md:max-h-[calc(100dvh-6rem)] md:overflow-y-auto">
          <p className="text-[10px] font-semibold tracking-widest text-dim uppercase">{doc.title}</p>
          <TocList toc={toc} />
        </div>
      </aside>

      <article className="blog-doc min-w-0" dangerouslySetInnerHTML={{ __html: rendered.html }} />
    </div>
  );
}

function TocList({ toc }: { toc: { level: number; text: string; id: string }[] }) {
  return (
    <nav aria-label="목차" className="mt-2 flex flex-col">
      {toc.map((t) => (
        <a
          key={t.id}
          href={`#${t.id}`}
          className={`truncate py-1 text-[12.5px] leading-snug hover:text-text ${
            t.level <= 2 ? "mt-1 font-medium text-text" : "pl-3 text-dim"
          }`}
        >
          {t.text}
        </a>
      ))}
    </nav>
  );
}
