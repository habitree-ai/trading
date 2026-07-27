"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "대시보드", icon: "📊" },
  { href: "/trades/new", label: "기록 추가", icon: "➕" },
  { href: "/trades", label: "거래 목록", icon: "📒" },
  { href: "/review", label: "복기 분석", icon: "🔍" },
  { href: "/goals", label: "목표", icon: "🎯" },
  { href: "/books", label: "북 관리", icon: "📚" },
] as const;

export function AppNav() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-border px-4 py-2 md:w-44 md:shrink-0 md:flex-col md:overflow-visible md:border-r md:border-b-0 md:py-4">
      {LINKS.map((link) => {
        // `/trades/new`가 `/trades`보다 먼저 오므로 정확 일치를 우선 판정한다.
        const active =
          pathname === link.href ||
          (link.href !== "/trades" && pathname.startsWith(`${link.href}/`)) ||
          (link.href === "/trades" && pathname.startsWith("/trades/") && pathname !== "/trades/new");

        return (
          <Link
            key={link.href}
            href={link.href}
            className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors ${
              active ? "bg-surface-2 font-medium text-text" : "text-dim hover:text-text"
            }`}
          >
            <span aria-hidden>{link.icon}</span>
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
