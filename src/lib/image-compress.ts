/**
 * 올리기 전에 사진을 줄인다 — readingtree `lib/utils/image.ts` 의 `smartCompressImage` 축약(REQ-0057).
 *
 * 폰으로 찍은 원본은 4~8MB 가 예사인데, 손으로 적은 메모나 다른 화면의 캡쳐는 긴 변 1600px
 * JPEG 로도 읽는 데 지장이 없다. 원본을 그대로 올리면 비공개 버킷이 몇 달 만에 부풀고,
 * 목록에서 썸네일 열 장을 여는 것만으로도 수십 MB 를 내려받게 된다.
 *
 * 브라우저 캔버스만 쓴다 — 의존성을 더하지 않고, 서버는 이미 줄어든 것을 받는다.
 * 실패하면 원본을 그대로 돌려준다. 사진이 안 붙는 것보다 큰 사진이 붙는 편이 낫다.
 */

/** 이 크기 아래면 손대지 않는다 — 캡쳐 대부분이 여기 걸린다 */
const SKIP_BYTES = 1024 * 1024;
/** 긴 변 상한 */
const MAX_EDGE = 1600;
const QUALITY = 0.8;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 읽지 못했습니다."));
    };
    img.src = url;
  });
}

/**
 * 1MB 를 넘는 이미지만 긴 변 1600px · JPEG 0.8 로 줄인다.
 *
 * 줄인 결과가 원본보다 크면(작은 PNG 를 JPEG 로 바꿀 때 생긴다) 원본을 쓴다.
 */
export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.size <= SKIP_BYTES) return file;

  try {
    const img = await loadImage(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    const width = Math.round(img.width * scale);
    const height = Math.round(img.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", QUALITY),
    );
    if (!blob || blob.size >= file.size) return file;

    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
  } catch {
    return file;
  }
}
