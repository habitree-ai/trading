/**
 * AI 분석 회차의 내용 형식 (REQ-0088).
 *
 * `ai_reviews.content` jsonb 의 정본이 이 파일이다. 화면(`/ai-review`)과 저장 CLI
 * (`scripts/ai-review.mjs`)가 같은 파서를 쓴다 — CLI 는 Node 의 타입 제거로 이 파일을 직접
 * import 하므로, 여기에는 `import type` 외의 import 를 두지 않는다.
 *
 * 생성 절차·관점은 `docs/ai-review/README.md`.
 */

export const AI_SECTION_KEYS = [
  "status",
  "problems",
  "fixes",
  "blindspots",
  "technical",
  "fundamental",
  "psychology",
  "rules",
] as const;

export type AiSectionKey = (typeof AI_SECTION_KEYS)[number];

export const AI_SECTION_LABEL: Record<AiSectionKey, string> = {
  status: "현재 나의 상태",
  problems: "나의 문제",
  fixes: "교정할 것 · 개선점",
  blindspots: "생각하지 못한 것",
  technical: "기술적 분석",
  fundamental: "기본적 분석",
  psychology: "심리",
  rules: "기준 대조 — Repeatable · 근거 5층",
};

/** 항목의 무게. `good` 은 지켜야 할 강점이다 — 문제만 늘어놓으면 무엇을 유지할지 사라진다. */
export const AI_SEVERITIES = ["high", "mid", "low", "info", "good"] as const;
export type AiSeverity = (typeof AI_SEVERITIES)[number];

export const AI_SEVERITY_LABEL: Record<AiSeverity, string> = {
  high: "심각",
  mid: "주의",
  low: "경미",
  info: "참고",
  good: "강점",
};

export interface AiEvidence {
  tradeId: string;
  label: string;
}

export interface AiItem {
  title: string;
  body: string;
  severity: AiSeverity;
  evidence: AiEvidence[];
  action?: string;
}

export interface AiSection {
  key: AiSectionKey;
  items: AiItem[];
}

export interface AiScore {
  label: string;
  value: string;
  note?: string;
}

export interface AiReviewContent {
  headline: string;
  state: string[];
  scores: AiScore[];
  sections: AiSection[];
  nextChecks: string[];
  limits: string[];
}

/** `ai_reviews` 한 행. `content` 는 파서를 거치기 전이라 `unknown` 이다. */
export interface AiReviewRow {
  id: string;
  book_id: string;
  user_id: string;
  round: number;
  title: string;
  period_from: string | null;
  period_to: string | null;
  trade_count: number;
  content: unknown;
  generated_at: string;
  created_at: string;
}

export type ParseResult = { ok: true; value: AiReviewContent } | { ok: false; errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isText(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function includes<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

function textList(v: unknown, path: string, errors: string[]): string[] {
  if (!Array.isArray(v)) {
    errors.push(`${path}: 문자열 배열이어야 합니다`);
    return [];
  }
  v.forEach((s, i) => {
    if (!isText(s)) errors.push(`${path}[${i}]: 빈 문자열이거나 문자열이 아닙니다`);
  });
  return v.filter(isText);
}

function parseItem(v: unknown, path: string, errors: string[]): AiItem | null {
  if (!isRecord(v)) {
    errors.push(`${path}: 객체여야 합니다`);
    return null;
  }
  const before = errors.length;
  if (!isText(v.title)) errors.push(`${path}.title: 필수`);
  if (!isText(v.body)) errors.push(`${path}.body: 필수`);
  if (!includes(AI_SEVERITIES, v.severity)) errors.push(`${path}.severity: ${AI_SEVERITIES.join("|")}`);
  if (v.action !== undefined && !isText(v.action)) errors.push(`${path}.action: 문자열`);

  const evidence: AiEvidence[] = [];
  if (v.evidence !== undefined) {
    if (!Array.isArray(v.evidence)) errors.push(`${path}.evidence: 배열이어야 합니다`);
    else
      v.evidence.forEach((e, i) => {
        if (isRecord(e) && isText(e.tradeId) && isText(e.label)) evidence.push({ tradeId: e.tradeId, label: e.label });
        else errors.push(`${path}.evidence[${i}]: { tradeId, label } 필요`);
      });
  }

  if (errors.length > before) return null;
  return {
    title: v.title as string,
    body: v.body as string,
    severity: v.severity as AiSeverity,
    evidence,
    ...(isText(v.action) ? { action: v.action } : {}),
  };
}

/** jsonb → 화면이 믿고 쓸 수 있는 형식. 틀린 곳을 전부 모아 돌려준다(저장 전 검사용). */
export function parseAiReviewContent(raw: unknown): ParseResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["content: 객체여야 합니다"] };

  if (!isText(raw.headline)) errors.push("headline: 필수");
  const state = textList(raw.state, "state", errors);
  const nextChecks = textList(raw.nextChecks, "nextChecks", errors);
  const limits = textList(raw.limits, "limits", errors);

  const scores: AiScore[] = [];
  if (!Array.isArray(raw.scores)) errors.push("scores: 배열이어야 합니다");
  else
    raw.scores.forEach((s, i) => {
      if (isRecord(s) && isText(s.label) && isText(s.value) && (s.note === undefined || isText(s.note)))
        scores.push({ label: s.label, value: s.value, ...(isText(s.note) ? { note: s.note } : {}) });
      else errors.push(`scores[${i}]: { label, value, note? } 필요`);
    });

  const sections: AiSection[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw.sections)) errors.push("sections: 배열이어야 합니다");
  else
    raw.sections.forEach((s, i) => {
      const path = `sections[${i}]`;
      if (!isRecord(s) || !includes(AI_SECTION_KEYS, s.key)) {
        errors.push(`${path}.key: ${AI_SECTION_KEYS.join("|")}`);
        return;
      }
      if (seen.has(s.key)) {
        errors.push(`${path}.key: ${s.key} 중복`);
        return;
      }
      seen.add(s.key);
      if (!Array.isArray(s.items)) {
        errors.push(`${path}.items: 배열이어야 합니다`);
        return;
      }
      const items = s.items
        .map((it, j) => parseItem(it, `${path}.items[${j}]`, errors))
        .filter((it): it is AiItem => it !== null);
      sections.push({ key: s.key, items });
    });

  if (errors.length > 0) return { ok: false, errors };
  // 화면 순서는 저장 순서가 아니라 정해진 순서다.
  sections.sort((a, b) => AI_SECTION_KEYS.indexOf(a.key) - AI_SECTION_KEYS.indexOf(b.key));
  return {
    ok: true,
    value: { headline: raw.headline as string, state, scores, sections, nextChecks, limits },
  };
}
