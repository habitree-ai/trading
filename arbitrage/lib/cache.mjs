/**
 * 캐시·산출물 경로. 봉은 [t,o,h,l,c,v] 배열 규약(oneway-fetch 와 동일 — 객체로 들면 세 배).
 * .cache/ 는 gitignore, out/ 은 산출물.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CACHE_DIR = join(ROOT, ".cache");
export const OUT_DIR = join(ROOT, "out");

export function cachePath(name) {
  return join(CACHE_DIR, name);
}

export function hasCache(name) {
  return existsSync(cachePath(name));
}

export function saveCache(name, obj) {
  mkdirSync(dirname(cachePath(name)), { recursive: true });
  writeFileSync(cachePath(name), JSON.stringify(obj));
}

export function loadCache(name, fallback = null) {
  const p = cachePath(name);
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, "utf8"));
}

/** fetch-report.json 에 시리즈 검증 결과를 누적한다(같은 이름은 덮어쓴다). */
export function mergeReport(entries) {
  const prev = loadCache("fetch-report.json", []);
  const names = new Set(entries.map((e) => e.name));
  const merged = [...prev.filter((p) => !names.has(p.name)), ...entries];
  saveCache("fetch-report.json", merged);
  return merged;
}
