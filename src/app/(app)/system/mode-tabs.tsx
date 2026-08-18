"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { SystemMode, SystemModeMeta } from "@/lib/system-trading";

export interface ModeTabItem {
  mode: SystemMode;
  meta: SystemModeMeta;
  /** 이 모드에 쌓인 완결 거래 수 — 비어 있는 모드를 눌러 보고 실망하지 않게. */
  closed: number;
  /** 지금 열려 있는 포지션 수 */
  open: number;
}

/**
 * 모드 전환 — 시스템 영역의 "북 선택"에 해당한다.
 *
 * 수동 일지가 북으로 나뉘듯 봇의 기록은 모드로 나뉜다. 다른 점은 모드가 계좌가 아니라
 * 검증 단계라는 것이다 — 그래서 실계좌(live)만 색을 달리해 한눈에 갈라 둔다.
 * 선택은 URL 쿼리에 남는다: 새로고침·뒤로가기가 보던 모드를 잃지 않는다.
 */
export function ModeTabs({ items, current }: { items: ModeTabItem[]; current: SystemMode }) {
  const pathname = usePathname();

  if (items.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(({ mode, meta, closed, open }) => {
        const active = mode === current;
        return (
          <Link
            key={mode}
            href={`${pathname}?mode=${mode}`}
            aria-current={active ? "page" : undefined}
            title={meta.desc}
            className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
              active
                ? meta.real
                  ? "border-loss bg-loss/10 font-semibold text-loss"
                  : "border-alpha bg-alpha/10 font-semibold text-alpha"
                : "border-border text-dim hover:text-text"
            }`}
          >
            {meta.real ? "● " : ""}
            {meta.label}
            <span className="tnum ml-1.5 text-[10px] opacity-70">
              {closed}
              {open > 0 ? `+${open}` : ""}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
