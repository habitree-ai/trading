#!/usr/bin/env node
/**
 * 2026-08-14 BTC 리서치 리포트(docs/research/2026-08-14-btc.md)의 핵심을
 * research_notes 로 시드한다 — 리서치 탭의 시작점.
 *
 *   node --env-file=.env.local scripts/seed-research-notes.mjs [이메일]
 *   (npm run seed:research-notes)
 *
 * 마이그레이션 0017 을 적용한 뒤에 돌린다. 두 번 돌려도 결과는 같다 —
 * 같은 제목의 노트가 이미 있으면 건너뛴다.
 */

import { createClient } from "@supabase/supabase-js";

const OWNER_EMAIL = process.argv[2] ?? "cdhrich@gmail.com";
const SYMBOL = "BTC";

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`✖ ${name} 가 없습니다. .env.local 을 확인해 주세요.`);
    process.exit(1);
  }
  return value;
}

const url = required("NEXT_PUBLIC_SUPABASE_URL");
const secretKey = required("SUPABASE_SECRET_KEY");

const supabase = createClient(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** 이메일로 사용자를 찾는다 — admin API 는 목록만 주므로 페이지를 넘겨 가며 훑는다. */
async function findUserByEmail(email) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`사용자 목록을 읽지 못했습니다: ${error.message}`);

    const hit = data.users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

// docs/research/2026-08-14-btc.md 의 섹션별 핵심 — 자세한 맥락과 전체 출처는 문서에 있다.
const NOTES = [
  {
    category: "fundamental",
    importance: 3,
    title: "ETF 수급이 사이클의 축 — 7월 최약 유입, 8월 첫 주 +$8.5억 반등",
    body: "7월 순유입 +$2.05억(현물 ETF 출시 후 최약, 5~6월은 순유출). 8월 첫 주 +$8.53억으로 4월 중순 이후 최강 반등했지만 그중 81%가 BlackRock IBIT 단독 — 유입의 저변이 좁다. 전체 ETF 보유 약 122.4만 BTC, AUM 약 $780억. 유입의 지속성과 편중 해소 여부가 관전 포인트.",
    source_url: "https://crypto.news/bitcoin-etfs-draw-853-5m-in-five-day-inflow-streak/",
  },
  {
    category: "fundamental",
    importance: 2,
    title: "첫 미국 현물 BTC ETF 폐쇄 — Hashdex DEFI, 8/17 이후",
    body: "유입이 IBIT 등 대형 상품으로 쏠리며 꼬리 상품이 정리되는 국면. 투자 자금이 AI 섹터로 이동한다는 해석도 있다. ETF 시장의 성숙(옥석 가리기) 신호로 읽는다.",
    source_url:
      "https://www.coindesk.com/business/2026/08/04/first-u-s-spot-bitcoin-etf-to-close-as-inflows-dwindle-investors-chase-ai-returns",
  },
  {
    category: "fundamental",
    importance: 2,
    title: "구조적 공급 흡수 — 기업 126만 + ETF 122만 + 정부 보유",
    body: "기업 트레저리 약 126만 BTC(총공급 3%+), ETF 약 122만, 각국 정부 보유까지 — 유통 물량의 상당분이 장기 보유 주체에 잠겨 있다. 2026년 상반기 기업 매수는 채굴량의 2배 이상.",
    source_url: "https://coinpaper.com/13895/bitcoin-treasury-companies",
  },
  {
    category: "onchain",
    importance: 3,
    title: "LTH 혼조 — 공급량 사상 최고권인데 주간 −21만 BTC 분산",
    body: "장기보유자 공급량은 약 1,664만 BTC(유통량의 ~79%)로 사상 최고권이고 $60~65K에서 매집이 이어졌으나, 최근 한 주 −21만 BTC로 2024년 말 이후 최대 주간 감소. 매집과 이익실현이 동시에 나타난다 — 분산이 지속되는지가 핵심 확인 사항.",
    source_url: "https://crypto-economy.com/long-term-holders-move-210000-btc/",
  },
  {
    category: "onchain",
    importance: 2,
    title: "거래소 보유량 증가 — 총 272만 BTC, Binance 6개월 최고",
    body: "총 거래소 보유량 약 272만 BTC(주간 +17,500). Binance 667,500 BTC로 6개월 최고(4월 이후 +51,500). 매도 가능 물량 증가로 읽히지만 지갑 잔액 기준이라 과해석은 금물 — 추세가 이어지는지를 본다.",
    source_url: "https://coinfomania.com/bitcoin-exchange-reserves-rose-by-17500-btc-last-week/",
  },
  {
    category: "onchain",
    importance: 1,
    title: "해시레이트 사상 최고(~920 EH/s) vs 채굴 수익성 바닥",
    body: "난이도 127.48T, hashprice는 2018년 이후 최저권($24~29/PH/day). 채굴사는 AI/HPC 임대 등으로 다각화 중. 네트워크 보안성(펀더멘털)과 가격의 괴리 국면.",
    source_url: "https://hashrateindex.com/blog/hashrate-index-roundup-august-10-2026/",
  },
  {
    category: "regulation",
    importance: 3,
    title: "CLARITY Act 상원 표결 국면 — 올해 최대 규제 이벤트",
    body: "2025-07 하원 통과(294:134) → 2026-05 상원 은행위 통과(15:9) → 8월 초 본회의 절차. 8/10이 사실상 데드라인으로 거론됐고 스테이블코인 이자 금지·DeFi 프레임워크 등 3개 쟁점 미결. 통과/부결이 규제 내러티브의 방향을 정한다.",
    source_url:
      "https://www.coindesk.com/policy/2026/08/05/here-are-the-possible-outcomes-for-clarity-right-now",
  },
  {
    category: "regulation",
    importance: 2,
    title: "SEC/CFTC 관할 정리 완료(2026-03) — BTC는 상품 축",
    body: "공동 해석 + MOU로 5단계 토큰 분류 도입. 디지털 증권=SEC, 디지털 상품=CFTC. BTC는 상품으로 분류돼 규제 명확성의 수혜를 받는 쪽.",
    source_url:
      "https://www.sec.gov/newsroom/press-releases/2026-30-sec-clarifies-application-federal-securities-laws-crypto-assets",
  },
  {
    category: "regulation",
    importance: 2,
    title: "전략적 비트코인 준비금 입법 추진 — ARMA, 최대 100만 BTC 목표",
    body: "미 정부는 압수 자산 기반 328,372 BTC 보유(세계 최대). 2026-05 발의된 ARMA 법안은 5년 내 최대 100만 BTC 확보가 목표, 연말 NDAA 편입 가능성 거론. 현실화되면 국가 단위 매수 수요라는 새 변수.",
    source_url:
      "https://begich.house.gov/media/press-releases/congressman-nick-begich-leads-legislation-establish-strategic-bitcoin-reserve",
  },
  {
    category: "social",
    importance: 2,
    title: "기업 트레저리 표준화 — 약 200개사 126만 BTC, Strategy 84.4만",
    body: "상장사 약 200곳이 BTC 보유 전략 채택, 합계 약 126만 BTC(~$790억). Strategy(舊 MicroStrategy) 843,775 BTC로 1위, Metaplanet 35,102 BTC 등 아시아로 확산. 초기 실험을 넘어 재무 규율로 체계화되는 단계.",
    source_url: "https://www.kucoin.com/blog/my-top-10-bitcoin-treasury-companies-2026-comparison",
  },
  {
    category: "social",
    importance: 1,
    title: "국가 채택 확산 — 13개국 정부 합계 약 $268억",
    body: "미국 328,372 BTC가 나머지 12개국 합의 ~3배. 엘살바도르 ~7,500 BTC, UAE ~6,800 BTC(국영 채굴). 주권 채무·기축통화 의존 완화 수단으로 검토가 늘어나는 추세.",
    source_url:
      "https://coinpedia.org/news/government-bitcoin-holdings-2026-which-countries-own-the-most-btc/",
  },
  {
    category: "macro",
    importance: 3,
    title: "연준 기대 역전: 인하 → 인상 가능 — 9월 FOMC가 분수령",
    body: "기준금리 3.50~3.75%(7월 동결, 반대 3표). 이란 분쟁발 에너지 충격(유가 8.5개월 고점)과 완고한 근원 인플레이션으로 연내 인상 가능성까지 거론. 인상 시나리오는 레인지 하단($60K) 테스트 리스크.",
    source_url: "https://www.goldmansachs.com/insights/articles/the-outlook-for-fed-rate-cuts-in-2026",
  },
  {
    category: "macro",
    importance: 1,
    title: "달러 인덱스 약 98.3 — 2개월 저점, 3주 연속 약세",
    body: "통상 위험자산에 우호적이나, 에너지발 인플레 기대가 되살아나면 달러 반등 + 위험자산 압박으로 뒤집힐 수 있는 구도. 유가와 함께 본다.",
    source_url:
      "https://www.business-standard.com/amp/markets/capital-market-news/dollar-index-slips-as-fed-minutes-hint-at-possible-rate-cuts-this-year-125071000182_1.html",
  },
];

const owner = await findUserByEmail(OWNER_EMAIL);
if (!owner) {
  console.error(`✖ ${OWNER_EMAIL} 사용자가 없습니다. 먼저 그 계정으로 한 번 로그인해 주세요.`);
  process.exit(1);
}

const { data: existing, error: readError } = await supabase
  .from("research_notes")
  .select("title")
  .eq("user_id", owner.id)
  .eq("symbol", SYMBOL);

if (readError) {
  if (/research_notes/.test(readError.message)) {
    console.error("✖ research_notes 표가 없습니다. supabase/migrations/0017_research.sql 을 먼저 적용해 주세요.");
  } else {
    console.error(`✖ 노트를 읽지 못했습니다: ${readError.message}`);
  }
  process.exit(1);
}

const have = new Set((existing ?? []).map((row) => row.title));
let added = 0;
let skipped = 0;

for (const note of NOTES) {
  if (have.has(note.title)) {
    skipped += 1;
    continue;
  }

  const { error } = await supabase
    .from("research_notes")
    .insert({ user_id: owner.id, symbol: SYMBOL, ...note });

  if (error) {
    console.error(`✖ '${note.title}' 추가 실패: ${error.message}`);
    process.exit(1);
  }
  added += 1;
  console.log(`✓ [${note.category}] ${note.title}`);
}

console.log(`\n완료: ${added}건 추가, ${skipped}건은 이미 있어 건너뜀.`);
console.log("리서치 탭(/research)에서 확인하세요. 원문 문서: docs/research/2026-08-14-btc.md");
