
/* ============================================================
   [1단계] 게시판(카테고리) 구조 + 수집 가능성 점검
   블로그: https://blog.naver.com/pillion21
   사용법: 크롬에서 위 블로그를 연 뒤 F12 → Console 탭 →
           (붙여넣기 경고 시 콘솔에 allow pasting 입력 후 재시도)
           아래 전체를 붙여넣고 Enter
   결과: 게시판 트리 + 게시판별 글 수 + 본문 추출 테스트 리포트가 출력되고,
         pillion21_probe.json 파일이 자동 다운로드됩니다.
   ============================================================ */
(async () => {
  const B = 'pillion21';
  const dec = s => { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return String(s); } };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const loose = t => {
    try { return JSON.parse(t); } catch (e) {}
    try { return JSON.parse(t.replace(/([{,])\s*'?([A-Za-z0-9_]+)'?\s*:/g, '$1"$2":').replace(/'/g, '"')); } catch (e) {}
    return null;
  };
  const R = { blogId: B, checkedAt: new Date().toISOString(), categories: [], categorySource: null, endpoints: {} };

  // ---------- 1) 게시판 트리: API 우선 ----------
  const flat = [];
  const pushCat = (no, name, parent, cnt) => {
    if (no == null || name == null) return;
    const k = String(no);
    if (flat.some(c => c.categoryNo === k)) return;
    flat.push({ categoryNo: k, categoryName: String(name).trim(), parentCategoryNo: parent != null ? String(parent) : null, postCnt: cnt != null ? cnt : null });
  };
  const walk = (arr, parent) => {
    (arr || []).forEach(c => {
      const no = c.categoryNo != null ? c.categoryNo : c.categoryId;
      const nm = c.categoryName || c.name;
      pushCat(no, nm, parent != null ? parent : c.parentCategoryNo, c.postCnt != null ? c.postCnt : c.postCount);
      const kids = c.categoryList || c.childCategoryList || c.children || c.subCategoryList;
      if (kids && kids.length) walk(kids, no);
    });
  };

  for (const u of [`https://blog.naver.com/api/blogs/${B}/category-list`,
                   `https://m.blog.naver.com/api/blogs/${B}/category-list`]) {
    if (flat.length) break;
    try {
      const r = await fetch(u, { credentials: 'include' });
      const j = loose(await r.text());
      const res = j && (j.result || j);
      const arr = res && (res.mylogCategoryList || res.categoryList || res.categories);
      if (arr && arr.length) { walk(arr, null); R.categorySource = u; }
      R.endpoints[u] = { http: r.status, found: flat.length };
    } catch (e) { R.endpoints[u] = { error: String(e) }; }
  }

  // ---------- 2) 폴백: 현재 페이지 DOM의 카테고리 메뉴 ----------
  if (!flat.length) {
    try {
      const docs = [document];
      const fr = document.getElementById('mainFrame');
      if (fr && fr.contentDocument) docs.push(fr.contentDocument);
      for (const d of docs) {
        d.querySelectorAll('a[href*="categoryNo="]').forEach(a => {
          const m = a.getAttribute('href').match(/categoryNo=(\d+)/);
          const nm = (a.textContent || '').replace(/\s+/g, ' ').replace(/\(\d+\)\s*$/, '').trim();
          const cm = (a.textContent || '').match(/\((\d+)\)\s*$/);
          if (m && nm) pushCat(m[1], nm, null, cm ? +cm[1] : null);
        });
      }
      if (flat.length) R.categorySource = 'DOM(현재 페이지 카테고리 메뉴)';
    } catch (e) { R.endpoints.dom = { error: String(e) }; }
  }
  R.categories = flat;

  // ---------- 3) 전체 글 수 ----------
  let firstLogNo = null;
  try {
    const u = `https://blog.naver.com/PostTitleListAsync.naver?blogId=${B}&viewdate=&currentPage=1&categoryNo=&parentCategoryNo=&countPerPage=30`;
    const r = await fetch(u, { credentials: 'include' });
    const j = loose(await r.text());
    const list = (j && j.postList) || [];
    firstLogNo = list.length ? String(list[0].logNo) : null;
    R.totalCount = j ? parseInt(j.totalCount, 10) : null;
    R.recent5 = list.slice(0, 5).map(p => `${p.addDate} | cat:${p.categoryNo} | ${dec(p.title)}`);
    R.endpoints.PostTitleListAsync = { http: r.status, ok: !!list.length };
  } catch (e) { R.endpoints.PostTitleListAsync = { error: String(e) }; }

  // ---------- 4) 게시판별 실제 글 수 대조 ----------
  R.categoryCounts = [];
  for (const c of flat.slice(0, 40)) {
    try {
      const u = `https://blog.naver.com/PostTitleListAsync.naver?blogId=${B}&viewdate=&currentPage=1&categoryNo=${c.categoryNo}&parentCategoryNo=&countPerPage=1`;
      const j = loose(await (await fetch(u, { credentials: 'include' })).text());
      const n = j ? parseInt(j.totalCount, 10) : null;
      c.actualCount = n;
      R.categoryCounts.push({ no: c.categoryNo, name: c.categoryName, count: n });
    } catch (e) { c.actualCount = null; }
    await sleep(120);
  }

  // ---------- 5) 본문 추출 테스트 ----------
  if (firstLogNo) {
    for (const [k, u] of [
      ['PostView_PC', `https://blog.naver.com/PostView.naver?blogId=${B}&logNo=${firstLogNo}&redirect=Dlog&widgetTypeCall=true&directAccess=false`],
      ['PostView_Mobile', `https://m.blog.naver.com/PostView.naver?blogId=${B}&logNo=${firstLogNo}`]
    ]) {
      try {
        const html = await (await fetch(u, { credentials: 'include' })).text();
        const d = new DOMParser().parseFromString(html, 'text/html');
        const el = d.querySelector('.se-main-container') || d.querySelector('#postViewArea') || d.querySelector('#viewTypeSelector');
        const txt = el ? (el.textContent || '').replace(/\s+\n/g, '\n').trim() : '';
        const cm = html.match(/["']categoryName["']\s*:\s*["']([^"']+)["']/);
        R.endpoints[k] = { ok: txt.length > 0, container: el ? (el.className || el.id) : null, chars: txt.length,
          imgs: el ? el.querySelectorAll('img').length : 0, htmlBytes: html.length,
          categoryInHtml: cm ? dec(cm[1]) : null, preview: txt.slice(0, 180) };
      } catch (e) { R.endpoints[k] = { ok: false, error: String(e) }; }
    }
  }

  // ---------- 출력 ----------
  console.log('%c=== 게시판 구조 ===', 'font-size:15px;font-weight:bold;color:#0a7');
  console.log('카테고리 출처:', R.categorySource, '/ 개수:', flat.length);
  console.table(flat.map(c => ({ no: c.categoryNo, 게시판: c.categoryName, 상위: c.parentCategoryNo, 신고글수: c.postCnt, 실제글수: c.actualCount })));
  console.log('전체 글 수:', R.totalCount, '| 게시판 합계:', flat.reduce((s, c) => s + (c.actualCount || 0), 0));
  console.log('%c=== 전체 리포트 (아래 JSON을 복사해 Claude에게 전달) ===', 'font-size:13px;font-weight:bold;color:#c60');
  console.log(JSON.stringify(R, null, 2));

  const blob = new Blob([JSON.stringify(R, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${B}_probe.json`;
  document.body.appendChild(a); a.click(); a.remove();
  console.log('%cpillion21_probe.json 다운로드됨 → 선배님 폴더에 넣어주셔도 됩니다.', 'color:#0a7;font-weight:bold');
  window.__probe = R;
  return R;
})();
