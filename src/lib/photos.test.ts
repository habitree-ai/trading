import { describe, expect, it } from 'vitest';

import { MAX_PHOTOS, parseImagePaths, pastedImages } from '@/lib/photos';

function form(...paths: string[]): FormData {
  const data = new FormData();
  for (const p of paths) data.append('image_paths', p);
  return data;
}

describe('parseImagePaths — 폼이 보낸 사진 경로', () => {
  it('내 폴더의 경로만 통과시킨다', () => {
    expect(parseImagePaths(form('u1/b1/a.jpg', 'u1/b1/b.jpg'), 'u1')).toEqual([
      'u1/b1/a.jpg',
      'u1/b1/b.jpg',
    ]);
  });

  it('남의 폴더를 가리키는 경로는 버린다 — 적혀도 열리지 않는 죽은 참조다', () => {
    expect(parseImagePaths(form('u2/b1/a.jpg', 'u1/b1/ok.jpg'), 'u1')).toEqual(['u1/b1/ok.jpg']);
  });

  it('앞부분만 같은 다른 사용자도 걸러진다', () => {
    expect(parseImagePaths(form('u10/b1/a.jpg'), 'u1')).toEqual([]);
  });

  it('상위 폴더로 빠져나가는 경로는 버린다', () => {
    expect(parseImagePaths(form('u1/../u2/a.jpg'), 'u1')).toEqual([]);
  });

  it('상한을 넘으면 앞에서부터 자른다', () => {
    const many = Array.from({ length: MAX_PHOTOS + 3 }, (_, i) => `u1/${i}.jpg`);
    expect(parseImagePaths(form(...many), 'u1')).toHaveLength(MAX_PHOTOS);
  });

  it('칸이 비어 있으면 빈 배열이다', () => {
    expect(parseImagePaths(new FormData(), 'u1')).toEqual([]);
  });
});

function clip(types: string[], ...files: File[]) {
  return { files, types };
}

const png = () => new File(['x'], 'image.png', { type: 'image/png' });

describe('pastedImages — 붙여넣기에서 사진으로 받을 이미지', () => {
  it('캡쳐처럼 그림만 오면 글칸에서도 그 그림을 받는다', () => {
    const shot = png();
    expect(pastedImages(clip(['Files'], shot), true)).toEqual([shot]);
  });

  it('글만 오면 받을 게 없다 — 글 붙여넣기가 그대로 흐른다', () => {
    expect(pastedImages(clip(['text/plain']), true)).toEqual([]);
  });

  it('글칸에 글과 그림이 함께 오면(엑셀 셀) 글이 먼저다', () => {
    expect(pastedImages(clip(['text/plain', 'text/html', 'Files'], png()), true)).toEqual([]);
  });

  it('글칸 밖이면 글이 함께 와도 그림을 받는다', () => {
    const cells = png();
    expect(pastedImages(clip(['text/plain', 'Files'], cells), false)).toEqual([cells]);
  });

  it('글 없이 html 과 그림이 오면 글칸에서도 그림을 받는다', () => {
    const img = png();
    expect(pastedImages(clip(['text/html', 'Files'], img), true)).toEqual([img]);
  });

  it('이미지가 아닌 파일은 거른다', () => {
    const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    expect(pastedImages(clip(['Files'], pdf), false)).toEqual([]);
  });
});
