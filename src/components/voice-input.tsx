"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { SPEECH_LANG, joinTranscript, mergeSpoken, speechErrorMessage } from "@/lib/speech";

/*
 * 말로 적기 — 브라우저에 들어 있는 음성인식을 그대로 쓴다.
 *
 * 서버로 오디오를 보내지 않으므로 호출 비용이 0이고, 열쇠(API 키)도 필요 없어
 * 로컬 개발 중에도 똑같이 동작한다. 대신 정확도는 전용 전사 모델보다 낮다 —
 * 짧은 전문용어(숏·손절)가 자주 틀리므로 **결과를 손으로 고치는 것을 전제**로 만든다.
 * 그래서 적어 둔 글을 절대 덮지 않고 줄을 바꿔 뒤에 붙인다.
 */

/** `lib.dom` 에 아직 SpeechRecognition 선언이 없다. 쓰는 만큼만 적는다. */
interface RecognitionResultEvent {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface RecognitionErrorEvent {
  error: string;
}

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  /** Chrome 139+ — 켜면 기기 안에서 처리하고 오디오가 밖으로 나가지 않는다. */
  processLocally?: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

interface RecognitionCtor {
  new (): Recognition;
  /** "available" | "downloadable" | "downloading" | "unavailable" */
  available?(o: { langs: string[]; processLocally?: boolean }): Promise<string>;
  install?(o: { langs: string[]; processLocally?: boolean }): Promise<boolean>;
}

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

type Field = HTMLInputElement | HTMLTextAreaElement;

function findField(id: string): Field | null {
  const el = document.getElementById(id);
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el : null;
}

/**
 * 칸에 글자를 넣는다.
 *
 * React 가 값을 쥐고 있는 칸(주문 패널 근거처럼 `value`+`onChange` 로 만든 것)은
 * `el.value = …` 만으로는 상태가 따라오지 않는다. 원래 setter 로 넣고 input 이벤트를
 * 직접 쏴야 React 가 자기 상태를 갱신한다. 값을 안 쥔 칸에서도 똑같이 동작한다.
 */
function writeField(el: Field, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 기기 안 인식 모델의 상태. `downloadable` 이면 내려받기 버튼을 보여준다. */
type LocalState = "unknown" | "ready" | "downloadable" | "off";

/** 지원 여부는 브라우저마다 정해져 있고 도중에 바뀌지 않는다 — 구독할 것이 없다. */
const subscribeNever = () => () => {};
const isSupported = () => recognitionCtor() !== null;
/** 서버에는 마이크가 없다. 버튼은 화면에 붙은 뒤에 나타난다. */
const notOnServer = () => false;

const BUTTON = "rounded-lg border px-2 py-1 text-xs disabled:opacity-40";

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
      <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
      <path d="M18 11a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.9V22h2v-3.1A8 8 0 0 0 20 11h-2Z" />
    </svg>
  );
}

/**
 * 입력칸 옆에 붙는 「말로 적기」 버튼.
 *
 * `targetId` 로 칸을 찾는다 — 칸마다 이미 `id` 가 붙어 있고 `label htmlFor` 가 그걸 쓰므로
 * 새로 배선할 것이 없다. 음성인식을 지원하지 않는 브라우저에서는 아무것도 그리지 않는다.
 */
export function VoiceInput({ targetId }: { targetId: string }) {
  const supported = useSyncExternalStore(subscribeNever, isSupported, notOnServer);
  const [listening, setListening] = useState(false);
  const [local, setLocal] = useState<LocalState>("unknown");
  const [installing, setInstalling] = useState(false);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<Recognition | null>(null);
  /** 말하기 시작한 순간의 칸 내용. 여기에 덧붙일 뿐 지우지 않는다. */
  const baseRef = useRef("");
  /** 이번에 말해서 확정된 문장들. */
  const spokenRef = useRef("");
  /** 사용자가 직접 멈춘 것인지 — 브라우저가 스스로 끊은 것과 구분해야 한다. */
  const stoppedRef = useRef(false);

  // 기기 안 모델이 준비돼 있는지 묻는다. 없는 브라우저면 `unknown` 인 채로 둔다 —
  // 그 경우 인식은 되되 목소리가 브라우저 벤더 서버를 거친다.
  useEffect(() => {
    const Ctor = recognitionCtor();
    if (typeof Ctor?.available !== "function") return;
    let alive = true;
    void Ctor.available({ langs: [SPEECH_LANG], processLocally: true })
      .then((state) => {
        if (!alive) return;
        setLocal(state === "available" ? "ready" : state === "downloadable" ? "downloadable" : "off");
      })
      .catch(() => {
        if (alive) setLocal("off");
      });
    return () => {
      alive = false;
    };
  }, []);

  // 화면을 떠날 때 마이크를 놓는다.
  useEffect(
    () => () => {
      stoppedRef.current = true;
      recRef.current?.abort();
    },
    [],
  );

  const stop = useCallback(() => {
    stoppedRef.current = true;
    recRef.current?.stop();
    setListening(false);
    setPreview("");
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    const field = findField(targetId);
    if (!Ctor || !field) return;

    setError(null);
    baseRef.current = field.value;
    spokenRef.current = "";
    stoppedRef.current = false;

    const rec = new Ctor();
    rec.lang = SPEECH_LANG;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    // 내려받아 둔 모델이 있으면 기기 안에서 처리한다 — 오디오가 밖으로 나가지 않는다.
    if (local === "ready") rec.processLocally = true;

    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const result = e.results[i];
        const text = result?.[0]?.transcript ?? "";
        if (result?.isFinal) spokenRef.current = mergeSpoken(spokenRef.current, text);
        else interim = mergeSpoken(interim, text);
      }
      const el = findField(targetId);
      if (el) writeField(el, joinTranscript(baseRef.current, mergeSpoken(spokenRef.current, interim)));
      setPreview(interim);
    };

    rec.onerror = (e) => {
      // 말이 없어 끊긴 것은 오류가 아니다 — onend 가 곧바로 다시 켠다.
      if (e.error === "no-speech" || e.error === "aborted") return;
      setError(speechErrorMessage(e.error));
      stoppedRef.current = true;
      setListening(false);
      setPreview("");
    };

    rec.onend = () => {
      // 브라우저는 몇 초만 조용해도 스스로 끊는다. 사용자가 멈춘 게 아니면 이어 간다.
      if (stoppedRef.current) {
        setListening(false);
        setPreview("");
        return;
      }
      try {
        rec.start();
      } catch {
        setListening(false);
      }
    };

    try {
      rec.start();
    } catch {
      setError(speechErrorMessage("aborted"));
      return;
    }
    recRef.current = rec;
    setListening(true);
  }, [local, targetId]);

  const installLocal = useCallback(() => {
    const Ctor = recognitionCtor();
    if (typeof Ctor?.install !== "function") return;
    setInstalling(true);
    setError(null);
    void Ctor.install({ langs: [SPEECH_LANG], processLocally: true })
      .then((ok) => {
        setLocal(ok ? "ready" : "downloadable");
        if (!ok) setError("내려받지 못했습니다. 잠시 뒤 다시 눌러 주세요.");
      })
      .catch(() => setError("내려받지 못했습니다. 잠시 뒤 다시 눌러 주세요."))
      .finally(() => setInstalling(false));
  }, []);

  if (!supported) return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {listening && preview ? (
        <span className="max-w-[16rem] truncate text-[11px] text-dim" aria-live="polite">
          {preview}
        </span>
      ) : null}

      {error ? <span className="text-[11px] text-loss">{error}</span> : null}

      {local === "downloadable" ? (
        <button
          type="button"
          onClick={installLocal}
          disabled={installing}
          className={`${BUTTON} border-border text-dim hover:border-accent`}
          title="한국어 인식 모델을 기기에 내려받습니다. 그 뒤로는 인터넷 없이 되고 목소리가 밖으로 나가지 않습니다."
        >
          {installing ? "내려받는 중…" : "오프라인 준비"}
        </button>
      ) : null}

      <button
        type="button"
        onClick={listening ? stop : start}
        aria-pressed={listening}
        className={`${BUTTON} inline-flex items-center gap-1 ${
          listening ? "border-loss text-loss" : "border-border text-accent hover:border-accent"
        }`}
        title={
          local === "ready"
            ? "기기 안에서 인식합니다 — 목소리가 밖으로 나가지 않습니다."
            : "말하면 적힌 글 뒤에 이어 붙습니다."
        }
      >
        {listening ? (
          <span className="h-2 w-2 animate-pulse rounded-full bg-loss" aria-hidden="true" />
        ) : (
          <MicIcon />
        )}
        {listening ? "그만 말하기" : "말로 적기"}
      </button>
    </span>
  );
}
