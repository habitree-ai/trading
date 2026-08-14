"use server";

import { Output, generateText } from "ai";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ResearchNoteCategory } from "@/lib/domain";
import { RESEARCH_NOTE_CATEGORIES } from "@/lib/domain";
import { getLatestSnapshot, requireUser } from "@/lib/queries";
import { collectSnapshot } from "@/lib/research/collect";

export interface ResearchFormState {
  error?: string;
  message?: string;
}

/** 심볼은 외부 API URL에 그대로 들어간다 — 화이트리스트 검증이 곧 인젝션 방어다. */
function parseSymbol(value: FormDataEntryValue | null): string | null {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase();
  return /^[A-Z0-9]{1,10}$/.test(raw) ? raw : null;
}

function parseCategory(value: FormDataEntryValue | null): ResearchNoteCategory {
  const raw = String(value ?? "");
  return (RESEARCH_NOTE_CATEGORIES as string[]).includes(raw)
    ? (raw as ResearchNoteCategory)
    : "fundamental";
}

function parseBody(value: FormDataEntryValue | null): string | null {
  const raw = String(value ?? "").trim();
  return raw === "" ? null : raw;
}

/** 출처는 화면의 <a href>로 나간다 — http(s)만 받고, 아니면 되묻는다. */
function parseSourceUrl(value: FormDataEntryValue | null): string | null | undefined {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  return /^https?:\/\//i.test(raw) ? raw : undefined;
}

function parseImportance(value: FormDataEntryValue | null): number {
  const parsed = Number(value);
  return parsed === 1 || parsed === 3 ? parsed : 2;
}

/** "지금 수집" — 4개 소스를 걷어 스냅샷 한 장을 적재한다. 일부 실패는 메시지로 알린다. */
export async function runCollect(
  _prev: ResearchFormState,
  formData: FormData,
): Promise<ResearchFormState> {
  const symbol = parseSymbol(formData.get("symbol"));
  if (!symbol) return { error: "심볼은 영문·숫자 1~10자입니다." };

  const { supabase, user } = await requireUser();

  try {
    const { row, failed } = await collectSnapshot(symbol);
    const { error } = await supabase
      .from("research_snapshots")
      .insert({ ...row, user_id: user.id });
    if (error) return { error: error.message };

    revalidatePath("/", "layout");
    return {
      message:
        failed.length === 0 ? "수집 완료." : `수집 완료 (일부 실패: ${failed.join(", ")}).`,
    };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : "수집에 실패했습니다." };
  }
}

export async function createResearchNote(
  _prev: ResearchFormState,
  formData: FormData,
): Promise<ResearchFormState> {
  const symbol = parseSymbol(formData.get("symbol"));
  if (!symbol) return { error: "심볼을 확인할 수 없습니다." };

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { error: "제목을 입력해 주세요." };

  const sourceUrl = parseSourceUrl(formData.get("source_url"));
  if (sourceUrl === undefined) return { error: "출처 링크는 http(s) 주소여야 합니다." };

  const { supabase, user } = await requireUser();
  const { error } = await supabase.from("research_notes").insert({
    user_id: user.id,
    symbol,
    category: parseCategory(formData.get("category")),
    title,
    body: parseBody(formData.get("body")),
    source_url: sourceUrl,
    importance: parseImportance(formData.get("importance")),
  });
  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { message: "노트를 추가했습니다." };
}

export async function updateResearchNote(
  _prev: ResearchFormState,
  formData: FormData,
): Promise<ResearchFormState> {
  const id = String(formData.get("note_id") ?? "");
  if (!id) return { error: "노트를 찾을 수 없습니다." };

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { error: "제목을 입력해 주세요." };

  const sourceUrl = parseSourceUrl(formData.get("source_url"));
  if (sourceUrl === undefined) return { error: "출처 링크는 http(s) 주소여야 합니다." };

  const { supabase } = await requireUser();
  const { error } = await supabase
    .from("research_notes")
    .update({
      category: parseCategory(formData.get("category")),
      title,
      body: parseBody(formData.get("body")),
      source_url: sourceUrl,
      importance: parseImportance(formData.get("importance")),
    })
    .eq("id", id);
  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { message: "고쳤습니다." };
}

export async function deleteResearchNote(id: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("research_notes").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
}

const BriefingSchema = z.object({
  title: z
    .string()
    .describe("한 줄 제목. 예) 8/14 BTC 브리핑 — ETF 순유입 지속, 펀딩 과열 주의"),
  body: z
    .string()
    .describe(
      "markdown 본문. '기본적 분석'과 '정치·사회 맥락' 두 절로 나누고, 제공된 자료 밖의 사실은 쓰지 않는다",
    ),
});

/**
 * AI 브리핑 — 최신 스냅샷과 헤드라인을 정리해 노트(briefing)로 남긴다.
 *
 * 입력을 수집된 자료로 한정한다. 모델이 시장을 새로 조사하는 게 아니라, 이미 걷어 온
 * 것을 사람이 읽을 순서로 접는 일이다 — 그래야 환각이 끼어들 자리가 없다.
 */
export async function generateBriefing(
  _prev: ResearchFormState,
  formData: FormData,
): Promise<ResearchFormState> {
  const symbol = parseSymbol(formData.get("symbol"));
  if (!symbol) return { error: "심볼을 확인할 수 없습니다." };

  if (!process.env.AI_GATEWAY_API_KEY) {
    return { error: "AI 브리핑이 설정되지 않았습니다. AI_GATEWAY_API_KEY를 등록해 주세요." };
  }

  const { supabase, user } = await requireUser();

  const snapshot = await getLatestSnapshot(symbol);
  if (!snapshot) return { error: "먼저 '지금 수집'으로 스냅샷을 만들어 주세요." };

  const lines = [
    `다음은 ${symbol}의 수집 자료다 (수집 시각 ${snapshot.collected_at}).`,
    "이 자료만으로 매매 이전 참고용 브리핑을 한국어로 작성하라.",
    "- 제공된 수치·헤드라인 밖의 사실을 지어내지 마라. 자료에 없으면 없다고 써라.",
    "- 매수/매도 권유가 아니라 상황 정리다.",
    "",
    "[정량 스냅샷]",
    `가격(USD): ${snapshot.price_usd ?? "없음"}`,
    `시가총액(USD): ${snapshot.market_cap_usd ?? "없음"}`,
    `24h 거래량(USD): ${snapshot.volume_24h_usd ?? "없음"}`,
    `시총 도미넌스(%): ${snapshot.dominance_pct ?? "없음"}`,
    `공포탐욕지수(시장 전체): ${snapshot.fear_greed ?? "없음"} (${snapshot.fear_greed_label ?? "-"})`,
    `펀딩비(소수, 8시간): ${snapshot.funding_rate ?? "없음"}`,
    `미결제약정(USD): ${snapshot.open_interest_usd ?? "없음"}`,
    "",
    "[뉴스 헤드라인]",
    ...(snapshot.headlines.length === 0
      ? ["(이번 수집에서 헤드라인이 없다)"]
      : snapshot.headlines.map(
          (h) => `- (${h.source}${h.published_at ? `, ${h.published_at}` : ""}) ${h.title}`,
        )),
  ];

  try {
    const result = await generateText({
      model: "anthropic/claude-sonnet-5",
      output: Output.object({ schema: BriefingSchema }),
      messages: [{ role: "user", content: lines.join("\n") }],
    });

    const { error } = await supabase.from("research_notes").insert({
      user_id: user.id,
      symbol,
      category: "briefing",
      title: result.output.title,
      body: result.output.body,
      importance: 2,
    });
    if (error) return { error: error.message };

    revalidatePath("/", "layout");
    return { message: "브리핑을 추가했습니다." };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "알 수 없는 오류";
    return { error: `브리핑 생성 실패: ${message}` };
  }
}
