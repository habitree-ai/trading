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

/** 지금 열려 있는 영역과 그 색. 세 컴포넌트가 같은 답을 봐야 한다. */
function useArea(): { pathname: string; area: Area; tone: (typeof TONE)[Area["tone"]] } {
  const pathname = usePathname();
  const area = AREAS.find((a) => a.key === areaOf(pathname)) ?? AREAS[0];
  return { pathname, area, tone: TONE[area.tone] };
}

/**
 * 영역 전환 — 수동매매 / 시스템매매 / 차트·자료.
 *
 * 헤더에 놓는다. 화면 목록보다 위에 있어야 "먼저 영역을 고르고 그 안에서 고른다"는
 * 순서가 눈에 보인다.
 *
 * 좁은 화면에서는 **지금 영역의 이름만** 남기고 나머지는 아이콘으로 줄인다. 셋을 다
 * 펼치면 북 선택·로그아웃까지 한 줄에 못 들어가 헤더가 두세 줄로 접혔고, 그만큼
 * 차트와 표가 밀려 내려갔다. 이름이 사라진 탭에는 aria-label 로 이름을 남긴다.
 */
export function AreaTabs() {
  const { area: current } = useArea();

  return (
    <nav aria-label="영역 전환" className="flex shrink-0 gap-1 rounded-xl bg-surface-2 p-1">
      {AREAS.map((area) => {
        const active = area.key === current.key;
        const tone = TONE[area.tone];
        return (
          <Link
            key={area.key}
            href={area.home}
            aria-current={active ? "page" : undefined}
            aria-label={area.label}
            title={area.tagline}
            className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs whitespace-nowrap transition-colors sm:px-2.5 ${
              active
                ? `bg-surface font-semibold ${tone.text} shadow-sm`
                : "text-dim hover:text-text"
            }`}
          >
            <span aria-hidden>{area.icon}</span>
            <span className={active ? "" : "hidden sm:inline"}>{area.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * 지금 영역의 화면 목록 — 좁은 화면용 가로 줄.
 *
 * 헤더 안(고정 영역)에 들어간다. 예전에는 본문 맨 위에 있어서 표를 조금만 내려도
 * 사라졌고, 다른 화면으로 가려면 매번 맨 위까지 되감아야 했다.
 */
export function ScreenTabs() {
  const { pathname, area, tone } = useArea();

  return (
    <nav
      aria-label={`${area.label} 화면`}
      className="scroll-x flex gap-1 px-3 pb-2 md:hidden"
    >
      {area.links.map((link) => {
        const active = isLinkActive(pathname, link.href, area);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors ${
              active ? `${tone.bg} font-medium text-text` : "text-dim"
            }`}
          >
            <span aria-hidden>{link.icon}</span>
            {link.label}
          </Link>
        );
      })}

      {/* 영역 밖 화면은 가로 목록의 끝에 붙는다 — 세로 구분선을 쓸 자리가 없다. */}
      {UTILITY_LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          aria-current={pathname === link.href ? "page" : undefined}
          className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm whitespace-nowrap ${
            pathname === link.href ? "bg-surface-2 font-medium text-text" : "text-dim"
          }`}
        >
          <span aria-hidden>{link.icon}</span>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * 지금 영역의 화면 목록 — 넓은 화면용 세로 사이드바.
 *
 * 다른 영역의 화면은 아예 내려오지 않는다 — 목록을 접어 두는 것과 다르다.
 * 시스템 성적을 보다가 수동 일지 메뉴가 눈에 걸리는 일이 없어야 분리가 성립한다.
 */
export function AppNav() {
  const { pathname, area, tone } = useArea();

  return (
    <div className="hidden border-border md:block md:w-52 md:shrink-0 md:border-r">
      <div className="px-4 pt-4 pb-2">
        <div className={`flex items-center gap-1.5 text-[11px] font-semibold ${tone.text}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
          {area.label}
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-dim">{area.tagline}</p>
      </div>

      <nav aria-label={`${area.label} 화면`} className="flex flex-col gap-1 px-3 pb-4">
        {area.links.map((link) => {
          const active = isLinkActive(pathname, link.href, area);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors ${
                active ? `${tone.bg} font-medium text-text` : "text-dim hover:text-text"
              }`}
            >
              <span aria-hidden className="mt-px">
                {link.icon}
              </span>
              <span className="min-w-0">
                {link.label}
                {link.hint ? (
                  <span className="block text-[11px] leading-snug font-normal text-dim">
                    {link.hint}
                  </span>
                ) : null}
              </span>
            </Link>
          );
        })}

        <div className="mt-2 border-t border-border pt-2">
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
      </nav>
    </div>
  );
}
