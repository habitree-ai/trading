"use client";

import { createWorker, type Worker } from "tesseract.js";

/**
 * 브라우저 OCR — 워커는 한 번만 만들어 재사용한다(언어 데이터가 수 MB라 매번 받으면 느리다).
 *
 * 언어를 `eng`만 쓰는 이유: OKX 앱 UI가 영문이고, `kor`을 얹으면 숫자를 한글 자모로
 * 오인하는 일이 늘어 오히려 정확도가 떨어진다.
 */
let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  workerPromise ??= createWorker("eng");
  return workerPromise;
}

export interface OcrOutcome {
  text: string;
  /** Tesseract가 매긴 평균 신뢰도 0~1. */
  confidence: number;
}

export async function runOcr(file: Blob): Promise<OcrOutcome> {
  const worker = await getWorker();
  const { data } = await worker.recognize(file);
  return { text: data.text, confidence: (data.confidence ?? 0) / 100 };
}
