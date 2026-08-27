/**
 * 화면 구조의 정본 — 이 앱은 성격이 다른 세 가지 일을 한 곳에서 한다.
 *
 * 1. 수동매매 — 내가 직접 낸 주문의 기록·복기. 데이터 단위는 "북"이다.
 * 2. 시스템매매 — 봇이 낸 주문. 데이터 단위는 모드(paper·live·…)이고 북이 아니다.
 * 3. 차트·자료 — 매매하지 않고 보기만 하는 것. 계좌 데이터가 아니다.
 *
 * 셋을 한 목록에 늘어놓으면 "지금 보는 숫자가 누가 낸 주문인지"가 흐려진다.
 * 그래서 영역을 먼저 고르고 그 안에서 화면을 고르는 2단 구조로 나눈다.
 *
 * 영역마다 색을 하나씩 준다 — 사이드바·헤더·배지가 같은 색을 쓰면 화면을 읽기 전에
 * 어느 영역에 있는지 눈이 먼저 안다.
 */

export type AreaKey = "manual" | "system" | "lab";

export interface NavLink {
  href: string;
  label: string;
  icon: string;
  /** 목록에서 한 줄로 무엇을 보는 자리인지 — 처음 보는 사람이 헤매지 않게. */
  hint?: string;
}

export interface Area {
  key: AreaKey;
  label: string;
  /** 영역 자체가 무엇인지 — 상단 전환 탭의 부제로 쓴다. */
  tagline: string;
  icon: string;
  /** 이 영역의 색 토큰 이름 — `text-{tone}` / `border-{tone}` 로 쓴다. */
  tone: "accent" | "alpha" | "beta";
  /** 영역을 눌렀을 때 처음 열리는 화면. */
  home: string;
  /** 이 영역이 북(수동 일지)에 매여 있는가 — 헤더의 북 선택 노출을 가른다. */
  usesBook: boolean;
  links: NavLink[];
}

export const AREAS: Area[] = [
  {
    key: "manual",
    label: "수동매매",
    tagline: "내가 낸 주문 — 기록과 복기",
    icon: "✋",
    tone: "accent",
    home: "/dashboard",
    usesBook: true,
    links: [
      { href: "/dashboard", label: "대시보드", icon: "📊", hint: "자금·성과·리스크 한 장" },
      { href: "/trades", label: "거래 목록", icon: "📒", hint: "전 거래와 차트" },
      { href: "/trades/new", label: "기록 추가", icon: "➕", hint: "캡쳐에서 자동 추출" },
      { href: "/review", label: "복기 분석", icon: "🔍", hint: "감정·셋업별 성과" },
      { href: "/principles", label: "원칙", icon: "📐", hint: "지킴/어김과 그 대가" },
      { href: "/goals", label: "목표", icon: "🎯", hint: "계획 β · 목표 α" },
      { href: "/books", label: "북 관리", icon: "📚", hint: "계좌·기간별 일지" },
    ],
  },
  {
    key: "system",
    label: "시스템매매",
    tagline: "봇이 낸 주문 — 쿼드 공격형",
    icon: "🤖",
    tone: "alpha",
    home: "/system",
    usesBook: false,
    links: [
      { href: "/system", label: "운용 현황", icon: "🛰️", hint: "잔고·포지션·성적" },
      { href: "/system/trades", label: "자동 거래", icon: "🧾", hint: "봇의 진입·청산 전량" },
      { href: "/system/decisions", label: "판정 로그", icon: "🪵", hint: "안 들어간 이유까지" },
      { href: "/system/criteria", label: "매매 기준", icon: "📏", hint: "4개 기준과 운영 규칙" },
      { href: "/system/test", label: "배선 검증", icon: "🔌", hint: "최소 수량 실주문" },
    ],
  },
  {
    key: "lab",
    label: "차트·자료",
    tagline: "보기만 하는 것 — 시세와 연구",
    icon: "📈",
    tone: "beta",
    home: "/chart",
    usesBook: false,
    links: [
      { href: "/chart", label: "실시간 차트", icon: "📈", hint: "TradingView" },
      { href: "/quad", label: "4분할 차트", icon: "🔲", hint: "멀티 타임프레임" },
      { href: "/research", label: "종목 리서치", icon: "🔎", hint: "지표·뉴스·노트" },
      { href: "/kelly", label: "과거데이터 분석", icon: "🎲", hint: "OKX 전 이력 켈리 기준" },
      { href: "/diagnosis", label: "매매 진단", icon: "🩺", hint: "문제·강점·사각지대" },
      { href: "/lab", label: "자료실", icon: "🗄️", hint: "복기·백테스트 리포트" },
      // 앱 레이아웃 밖의 공개 페이지 — 여기서는 드나드는 문일 뿐이다.
      { href: "/blog", label: "선배님 아카이브", icon: "📖", hint: "정리 문서 · 내 생각 노트 (공개)" },
    ],
  },
];

/** 영역 밖 — 어느 영역에도 속하지 않는 화면. 사이드바 맨 아래에 따로 둔다. */
export const UTILITY_LINKS: NavLink[] = [
  { href: "/settings", label: "설정", icon: "⚙️" },
];

/**
 * 경로가 어느 영역인가.
 *
 * 긴 경로부터 본다 — `/system/trades` 는 시스템이고 `/trades` 는 수동이라,
 * 짧은 쪽을 먼저 맞추면 시스템 거래 화면이 수동 영역으로 잡힌다.
 */
export function areaOf(pathname: string): AreaKey {
  let best: { key: AreaKey; len: number } | null = null;
  for (const area of AREAS) {
    for (const link of area.links) {
      if (pathname === link.href || pathname.startsWith(`${link.href}/`)) {
        if (!best || link.href.length > best.len) best = { key: area.key, len: link.href.length };
      }
    }
  }
  // 설정처럼 영역 밖 화면은 수동을 기본으로 둔다 — 북 선택이 살아 있는 편이 쓸모 있다.
  return best?.key ?? "manual";
}

/** 이 링크가 지금 열려 있는가 — 하위 경로도 그 링크로 친다. */
export function isLinkActive(pathname: string, href: string, area: Area): boolean {
  if (pathname === href) return true;
  if (!pathname.startsWith(`${href}/`)) return false;
  // 같은 영역 안에 더 깊은 링크가 있으면 그쪽이 주인이다 — `/system/trades` 를
  // `/system` 이 가져가면 두 줄이 동시에 켜진다.
  return !area.links.some((l) => l.href !== href && l.href.startsWith(`${href}/`) &&
    (pathname === l.href || pathname.startsWith(`${l.href}/`)));
}
