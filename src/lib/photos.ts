/**
 * 기록에 붙는 사진의 공통 규칙 — 몇 장까지인지, 폼이 보낸 경로를 어떻게 거를지(REQ-0057),
 * 붙여넣기에서 무엇을 사진으로 받을지(REQ-0064).
 *
 * 화면(`components/photos.tsx`)과 서버 액션(거래·기록 저장) 양쪽이 같은 상한을 봐야
 * "6장째는 화면에서 막히는데 서버는 받는" 어긋남이 안 생긴다.
 */

/** 기록 하나에 붙일 수 있는 사진 수 */
export const MAX_PHOTOS = 5;

/**
 * 폼이 실어 보낸 사진 경로 — 클라이언트가 버킷에 올린 뒤 숨은 칸으로 넘긴 값이다.
 *
 * 값은 브라우저에서 오므로 그대로 믿지 않는다. `captures` 버킷의 RLS 는 경로의 첫 폴더가
 * uid 인 객체만 허용하니 같은 규칙을 여기서도 건다 — 남의 폴더를 가리키는 경로가 행에
 * 적히면 그 줄은 영영 안 열리는 죽은 참조가 된다.
 */
export function parseImagePaths(formData: FormData, userId: string): string[] {
  return formData
    .getAll('image_paths')
    .map(String)
    .filter((path) => path.startsWith(`${userId}/`) && !path.includes('..'))
    .slice(0, MAX_PHOTOS);
}

/**
 * 붙여넣은 클립보드에서 사진으로 받을 이미지 — 빈 배열이면 붙여넣기를 가로채지 않는다(REQ-0064).
 *
 * 글칸에 글과 그림이 함께 오면 글을 우선한다. 엑셀 셀을 복사하면 표를 그린 그림이 같이 실려
 * 오는데, 그걸 사진으로 가로채면 복기 칸에 숫자를 붙여넣을 수 없게 된다. 캡쳐 도구는 글 없이
 * 그림만 싣는다.
 */
export function pastedImages(
  clipboard: { files: ArrayLike<File>; types: readonly string[] },
  intoTextField: boolean,
): File[] {
  if (intoTextField && clipboard.types.includes('text/plain')) return [];
  return Array.from(clipboard.files).filter((f) => f.type.startsWith('image/'));
}
