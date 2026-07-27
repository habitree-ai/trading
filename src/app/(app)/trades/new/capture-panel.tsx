"use client";

import { useRef, useState } from "react";

import { TradeForm } from "@/app/(app)/trades/trade-form";
import { CAPTURE_KIND_LABEL, type CaptureKind } from "@/lib/domain";
import { AI_FALLBACK_THRESHOLD, extractFromText } from "@/lib/extract";
import { runOcr } from "@/lib/extract/ocr";
import { fromAi, toPrefill, type AiExtraction, type Prefill } from "@/lib/extract/to-prefill";
import type { ExtractedFields, ExtractedFill } from "@/lib/extract/types";
import { createClient } from "@/lib/supabase/client";
import type { Json } from "@/lib/supabase/database.types";

type Stage = "idle" | "uploading" | "ocr" | "ai" | "done" | "error";

interface Attached {
  id: string;
  kind: CaptureKind;
  name: string;
  previewUrl: string;
}

const STAGE_LABEL: Record<Stage, string> = {
  idle: "",
  uploading: "캡쳐 올리는 중…",
  ocr: "글자 읽는 중… (첫 실행은 언어 데이터를 받느라 조금 걸립니다)",
  ai: "OCR 신뢰도가 낮아 AI로 다시 읽는 중…",
  done: "",
  error: "",
};

export function CapturePanel({ bookId, userId }: { bookId: string; userId: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<CaptureKind>("position");
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [suspect, setSuspect] = useState<string[]>([]);
  const [prefill, setPrefill] = useState<Prefill>({});
  const [fills, setFills] = useState<ExtractedFill[]>([]);
  const [attached, setAttached] = useState<Attached[]>([]);
  // 프리필이 바뀌면 폼을 새로 마운트해야 defaultValue가 다시 반영된다.
  const [formKey, setFormKey] = useState(0);

  async function handleFile(file: File) {
    setError(null);
    setNotes([]);
    const supabase = createClient();

    // 1) 원본을 먼저 올린다 — 추출이 실패해도 캡쳐는 남는다.
    setStage("uploading");
    const ext = file.name.split(".").pop()?.toLowerCase() || "png";
    const path = `${userId}/${bookId}/${crypto.randomUUID()}.${ext}`;

    const upload = await supabase.storage.from("captures").upload(path, file, {
      contentType: file.type || "image/png",
    });
    if (upload.error) {
      setStage("error");
      setError(`캡쳐 업로드 실패: ${upload.error.message}`);
      return;
    }

    const row = await supabase
      .from("trade_images")
      .insert({ user_id: userId, kind, storage_path: path, engine: "manual" })
      .select("id")
      .single();
    if (row.error) {
      setStage("error");
      setError(`캡쳐 기록 실패: ${row.error.message}`);
      return;
    }

    setAttached((prev) => [
      ...prev,
      { id: row.data.id, kind, name: file.name, previewUrl: URL.createObjectURL(file) },
    ]);

    // 차트 캡쳐는 근거 이미지일 뿐이라 글자를 읽지 않는다.
    if (kind === "chart") {
      setStage("done");
      setNotes(["차트 캡쳐는 진입 근거로 첨부만 됩니다."]);
      return;
    }

    // 2) 브라우저 OCR → 거래소 어댑터
    setStage("ocr");
    let ocrText = "";
    let parsed: { fields: ExtractedFields; notes: string[]; suspect: string[] } | null = null;
    let engine: "ocr" | "ai" = "ocr";

    try {
      const ocr = await runOcr(file);
      ocrText = ocr.text;
      const result = extractFromText(ocrText);
      if (result && result.confidence >= AI_FALLBACK_THRESHOLD) {
        parsed = { fields: result.fields, notes: result.notes, suspect: result.suspect };
      }
    } catch (e) {
      // OCR 자체가 실패해도 AI 폴백이 남아 있으므로 여기서 멈추지 않는다.
      ocrText = "";
      console.warn("OCR 실패", e);
    }

    // 3) 신뢰도가 낮으면 AI 비전으로 다시 읽는다.
    if (!parsed) {
      setStage("ai");
      const form = new FormData();
      form.set("image", file);
      form.set("ocrText", ocrText);

      const res = await fetch("/api/extract", { method: "POST", body: form });
      const json: unknown = await res.json();

      if (!res.ok) {
        const message =
          typeof json === "object" && json !== null && "error" in json
            ? String((json as { error: unknown }).error)
            : "AI 추출 실패";
        setStage("error");
        setError(`${message} 값은 직접 입력해 주세요.`);
        return;
      }

      const ai = (json as { fields: AiExtraction }).fields;
      const converted = fromAi(ai);
      parsed = { fields: converted.fields, notes: converted.notes, suspect: [] };
      engine = "ai";
    }

    // 4) 추출 결과를 캡쳐 기록에 남기고 폼에 꽂는다.
    await supabase
      .from("trade_images")
      .update({
        ocr_raw: ocrText || null,
        // 구조체를 그대로 넘기면 Json 타입과 안 맞아 한 번 직렬화한다.
        extracted: JSON.parse(JSON.stringify(parsed.fields)) as Json,
        engine,
      })
      .eq("id", row.data.id);

    setPrefill((prev) => ({ ...prev, ...toPrefill(parsed.fields) }));
    if (parsed.fields.fills?.length) setFills(parsed.fields.fills);
    setSuspect(parsed.suspect);
    setNotes(parsed.notes);
    setFormKey((k) => k + 1);
    setStage("done");
  }

  const busy = stage === "uploading" || stage === "ocr" || stage === "ai";

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium">캡쳐로 채우기</h2>
        <p className="mt-1 text-xs text-dim">
          OKX 주문 상세 캡쳐를 올리면 값을 읽어 아래 폼을 채웁니다. 캡쳐 없이 직접 입력해도 됩니다.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {(Object.keys(CAPTURE_KIND_LABEL) as CaptureKind[]).map((k) => (
            <label
              key={k}
              className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs ${
                kind === k ? "border-accent text-accent" : "border-border text-dim"
              }`}
            >
              <input
                type="radio"
                name="capture_kind"
                value={k}
                checked={kind === k}
                onChange={() => setKind(k)}
                className="sr-only"
              />
              {CAPTURE_KIND_LABEL[k]}
            </label>
          ))}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleFile(file);
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="mt-3 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-dim hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {busy ? "처리 중…" : `${CAPTURE_KIND_LABEL[kind]} 캡쳐 선택`}
        </button>

        {busy ? <p className="mt-2 text-xs text-accent">{STAGE_LABEL[stage]}</p> : null}
        {error ? <p className="mt-2 text-xs text-loss">{error}</p> : null}

        {notes.length > 0 ? (
          <ul className="mt-3 space-y-1">
            {notes.map((n) => (
              <li key={n} className="text-xs text-beta">
                ⚠ {n}
              </li>
            ))}
          </ul>
        ) : null}

        {attached.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2">
            {attached.map((a) => (
              <li key={a.id} className="w-20">
                {/* Storage 서명 URL 대신 방금 고른 파일의 로컬 미리보기를 쓴다. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={a.previewUrl}
                  alt={a.name}
                  className="h-20 w-20 rounded border border-border object-cover"
                />
                <span className="mt-1 block truncate text-[10px] text-dim">
                  {CAPTURE_KIND_LABEL[a.kind]}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <TradeForm
        key={formKey}
        bookId={bookId}
        prefill={prefill}
        suspectFields={suspect}
        imageIds={attached.map((a) => a.id)}
        fills={fills}
      />
    </div>
  );
}
