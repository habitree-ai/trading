"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { AREAS, UTILITY_LINKS, areaOf, isLinkActive, type Area } from "@/lib/nav";

/** 영역 색 — 토큰 이름을 클래스로 조립하면 Tailwind가 못 찾는다. 표로 박아 둔다. */
const TONE: Record<Area["tone"], { text: string; border: string; bg: string; dot: string }> = {
  accent: { text: "text-accent", border: "border-accent", bg: "bg-accent/10", dot: "bg-accent" },
  alpha: { text: "text-alpha", border: "border-alpha", bg: "bg-alpha/10", dot: "bg-alpha" },
  beta: { text: "text-beta", border: "border-beta", bg: "bg-beta/10", dot: "bg-beta" },
};

/**
 * 영역 전환 — 수동매매 / 시스템매매 / 차트·자료.
 *
 * 헤더에 놓는다. 화면 목록보다 위에 있어야 "먼저 영역을 고르고 그 안에서 고른다"는
 * 순서가 눈에 보인다.
 */
export function AreaTabs() {
  const current = areaOf(usePathname());

  return (
    <nav aria-label="영역 전환" className="flex shrink-0 gap-1 rounded-xl bg-surface-2 p-1">
      {AREAS.map((area) => {
        const active = area.key === current;
        const tone = TONE[area.tone];
        return (
          <Link
            key={area.key}
            href={area.home}
            aria-current={active ? "page" : undefined}
            title={area.tagline}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs whitespace-nowrap transition-colors ${
              active
                ? `bg-surface font-semibold ${tone.text} shadow-sm`
                : "text-dim hover:text-text"
            }`}
          >
            <span aria-hidden>{area.icon}</span>
            {area.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * 지금 영역의 화면 목록.
 *
 * 다른 영역의 화면은 아예 내려오지 않는다 — 목록을 접어 두는 것과 다르다.
 * 시스템 성적을 보다가 수동 일지 메뉴가 눈에 걸리는 일이 없어야 분리가 성립한다.
 */
export function AppNav() {
  const pathname = usePathname();
  const area = AREAS.find((a) => a.key === areaOf(pathname)) ?? AREAS[0];
  const tone = TONE[area.tone];

  return (
    <div className="border-b border-border md:w-52 md:shrink-0 md:border-r md:border-b-0">
      <div className="hidden px-4 pt-4 pb-2 md:block">
        <div className={`flex items-center gap-1.5 text-[11px] font-semibold ${tone.text}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
          {area.label}
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-dim">{area.tagline}</p>
      </div>

      <nav
        aria-label={`${area.label} 화면`}
        className="flex gap-1 overflow-x-auto px-3 py-2 md:flex-col md:overflow-visible md:px-3 md:pb-4"
      >
        {area.links.map((link) => {
          const active = isLinkActive(pathname, link.href, area);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors md:items-start ${
                active ? `${tone.bg} font-medium text-text` : "text-dim hover:text-text"
              }`}
            >
              <span aria-hidden className="md:mt-px">
                {link.icon}
              </span>
              <span className="md:min-w-0">
                {link.label}
                {link.hint ? (
                  <span className="hidden text-[11px] leading-snug font-normal text-dim md:block">
                    {link.hint}
                  </span>
                ) : null}
              </span>
            </Link>
          );
        })}

        <div className="hidden md:mt-2 md:block md:border-t md:border-border md:pt-2">
          {UTILITY_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={pathname === link.href ? "page" : undefined}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors ${
                pathname === link.href ? "bg-surface-2 font-medium text-text" : "text-dim hover:text-text"
              }`}
            >
              <span aria-hidden>{link.icon}</span>
              {link.label}
            </Link>
          ))}
        </div>

        {/* 모바일에서는 가로 목록의 끝에 붙는다 — 세로 구분선을 쓸 자리가 없다. */}
        {UTILITY_LINKS.map((link) => (
          <Link
            key={`m-${link.href}`}
            href={link.href}
            className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap md:hidden ${
              pathname === link.href ? "bg-surface-2 font-medium text-text" : "text-dim"
            }`}
          >
            <span aria-hidden>{link.icon}</span>
            {link.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
