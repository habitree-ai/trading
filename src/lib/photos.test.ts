import { describe, expect, it } from 'vitest';

import { MAX_PHOTOS, parseImagePaths } from '@/lib/photos';

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
