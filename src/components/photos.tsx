"use client";

import { useEffect, useRef, useState } from "react";

import { compressImage } from "@/lib/image-compress";
import { MAX_PHOTOS } from "@/lib/photos";
import { createClient } from "@/lib/supabase/client";

/**
 * 기록에 붙는 사진 — 손으로 적은 메모를 찍거나, 다른 화면의 캡쳐를 고른다(REQ-0057).
 *
 * readingtree 의 `RecordPhotoStrip` 을 줄여 가져왔다. 핵심은 파일 입력을 둘로 나눈 것이다 —
 * `capture="environment"` 를 단 쪽은 폰에서 카메라가 바로 열리고, `multiple` 을 단 쪽은
 * 앨범·탐색기가 열린다. 하나로 합치면 둘 중 하나는 반드시 불편해진다.
 *
 * 버킷 `captures` 는 비공개다(0001 RLS 가 첫 폴더를 uid 로 잠근다) — 그래서 행에는 경로만
 * 담고, 화면에 띄울 때마다 서명 URL 을 새로 받는다. URL 을 저장하면 만료돼 죽는다.
 */

const BUCKET = "captures";
/** 서명 URL 유효 시간 — 한 화면을 보는 동안이면 충분하다 */
const SIGNED_TTL = 60 * 60;

/**
 * 경로들의 서명 URL — 목록이 바뀔 때마다 한 번에 받는다.
 *
 * 낱개로 받으면 사진 다섯 장에 왕복이 다섯 번이다. 실패한 것은 지도에 안 들어가고,
 * 화면은 그 자리를 빈 칸으로 남긴다 — 사진이 안 열리는 것을 조용히 숨기지 않는다.
 */
function useSignedUrls(paths: string[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  // 배열은 매 렌더 새 참조라 그대로 의존성에 넣으면 계속 다시 받는다 — 내용으로 견준다.
  const key = paths.join("\n");

  useEffect(() => {
    if (key === "") return;
    let cancelled = false;
    createClient()
      .storage.from(BUCKET)
      .createSignedUrls(key.split("\n"), SIGNED_TTL)
      .then(({ data }) => {
        if (cancelled || !data) return;
        // 지운 사진의 URL 이 남아도 조회는 경로로 하니 화면에는 안 뜬다.
        setUrls((prev) => {
          const next = { ...prev };
          for (const row of data) {
            if (row.path && row.signedUrl) next[row.path] = row.signedUrl;
          }
          return next;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return urls;
}

function Thumb({ url, alt }: { url: string | undefined; alt: string }) {
  if (!url) {
    return <div className="h-20 w-20 rounded-lg border border-border bg-bg" aria-label={`${alt} (여는 중)`} />;
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" title="원본 보기">
      {/* 서명 URL 은 만료되는 값이라 next/image 로 최적화할 대상이 아니다. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt} className="h-20 w-20 rounded-lg border border-border object-cover" />
    </a>
  );
}

/** 저장된 기록에 붙은 사진 — 목록·상세에서 보기만 한다. 누르면 원본이 새 탭에서 열린다. */
export function PhotoRow({ paths }: { paths: string[] }) {
  const urls = useSignedUrls(paths);
  if (paths.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label="사진">
      {paths.map((path, i) => (
        <li key={path}>
          <Thumb url={urls[path]} alt={`사진 ${i + 1}`} />
        </li>
      ))}
    </ul>
  );
}

const BUTTON = "rounded-lg border px-3 py-1.5 text-xs disabled:opacity-40";
const BUTTON_OFF = `${BUTTON} border-border text-accent hover:border-accent`;

/**
 * 사진 입력 — 고르는 즉시 올리고, 경로를 숨은 칸으로 폼에 실어 보낸다.
 *
 * 폼이 저장될 때가 아니라 고를 때 올린다 — 저장이 실패해도 사진은 버킷에 남고, 다시 저장하면
 * 그대로 붙는다. 대신 지운 사진의 객체는 버킷에 남는다(비목표). 부모가 `key` 로 다시 그리면
 * 칸이 비워진다 — 저장 후 폼이 비는 흐름과 같다.
 */
export function PhotoStrip({
  name,
  userId,
  bookId,
  initial = [],
  max = MAX_PHOTOS,
  disabled = false,
}: {
  /** 폼에 실릴 칸 이름 — 서버는 `formData.getAll(name)` 으로 경로들을 받는다 */
  name: string;
  userId: string;
  /** 올릴 자리 — 북별로 나눠 둔다. 북이 없는 화면이면 생략 */
  bookId?: string;
  /** 이미 붙어 있는 사진의 경로 */
  initial?: string[];
  max?: number;
  disabled?: boolean;
}) {
  const [paths, setPaths] = useState<string[]>(initial);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const albumRef = useRef<HTMLInputElement>(null);
  const urls = useSignedUrls(paths);

  const busy = disabled || uploading > 0;

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);

    const room = max - paths.length;
    if (room <= 0) {
      setError(`사진은 ${max}장까지 붙일 수 있습니다.`);
      return;
    }
    const picked = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .slice(0, room);
    if (picked.length === 0) {
      setError("이미지 파일만 붙일 수 있습니다.");
      return;
    }

    setUploading(picked.length);
    const supabase = createClient();
    const done: string[] = [];
    for (const file of picked) {
      const small = await compressImage(file);
      const ext = small.name.split(".").pop()?.toLowerCase() || "jpg";
      const folder = bookId ? `${userId}/${bookId}` : userId;
      const path = `${folder}/${crypto.randomUUID()}.${ext}`;
      const { error: upError } = await supabase.storage
        .from(BUCKET)
        .upload(path, small, { contentType: small.type || "image/jpeg" });
      if (upError) {
        setError(`사진을 올리지 못했습니다: ${upError.message}`);
        break;
      }
      done.push(path);
    }
    setUploading(0);
    if (done.length > 0) setPaths((prev) => [...prev, ...done].slice(0, max));
    if (cameraRef.current) cameraRef.current.value = "";
    if (albumRef.current) albumRef.current.value = "";
  }

  return (
    <div className="space-y-2">
      {paths.map((path) => (
        <input key={path} type="hidden" name={name} value={path} />
      ))}

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />
      <input
        ref={albumRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {paths.length > 0 || uploading > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="붙인 사진">
          {paths.map((path, i) => (
            <li key={path} className="relative">
              <Thumb url={urls[path]} alt={`사진 ${i + 1}`} />
              <button
                type="button"
                disabled={busy}
                onClick={() => setPaths((prev) => prev.filter((p) => p !== path))}
                aria-label={`사진 ${i + 1} 빼기`}
                className="absolute right-1 top-1 rounded-full bg-black/60 px-1.5 text-xs text-white hover:bg-black/80 disabled:opacity-40"
              >
                ×
              </button>
            </li>
          ))}
          {Array.from({ length: uploading }).map((_, i) => (
            <li
              key={`up-${i}`}
              className="flex h-20 w-20 items-center justify-center rounded-lg border border-dashed border-border text-[11px] text-dim"
            >
              올리는 중
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || paths.length >= max}
          onClick={() => cameraRef.current?.click()}
          className={BUTTON_OFF}
          title="폰에서는 카메라가 바로 열립니다"
        >
          사진 찍기
        </button>
        <button
          type="button"
          disabled={busy || paths.length >= max}
          onClick={() => albumRef.current?.click()}
          className={BUTTON_OFF}
        >
          이미지 고르기 ({paths.length}/{max})
        </button>
        {error ? <span className="text-xs text-loss">{error}</span> : null}
      </div>
    </div>
  );
}
