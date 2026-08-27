
/* ============================================================
   [2단계] 게시판(카테고리) 기준 전량 수집 스크립트
   블로그: https://blog.naver.com/pillion21
   사용법: 크롬에서 위 블로그를 연 뒤 F12 → Console 탭 → 전체 붙여넣고 Enter
   결과: pillion21_part01.json, part02... + pillion21_meta.json 자동 다운로드
         (크롬이 "여러 파일 다운로드 허용?" 물으면 반드시 [허용] 클릭)
         전부 C:\Dev\trading\선배님 폴더에 넣어주세요.
   중단 시: 콘솔에 saveArchive() 입력 → 지금까지 수집분 저장
   ============================================================ */
(async () => {
  // ================= 설정 =================
  const B            = 'pillion21';
  const DELAY        = 200;    // 요청 간격(ms). 차단되면 400~600으로 올리세요
  const INCLUDE_HTML = true;   // 본문 원본 HTML 보존(표·서식 유지). 용량 커짐
  const CHUNK        = 150;    // 이 건수마다 파일 하나씩 중간 저장(크래시 방어)
  const PER          = 30;
  // ========================================

  const dec = s => { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return String(s); } };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const loose = t => {
    try { return JSON.parse(t); } catch (e) {}
    try { return JSON.parse(t.replace(/([{,])\s*'?([A-Za-z0-9_]+)'?\s*:/g, '$1"$2":').replace(/'/g, '"')); } catch (e) {}
    return null;
  };
  const getJSON = async (u) => { try { return loose(await (await fetch(u, { credentials: 'include' })).text()); } catch (e) { return null; } };
  const dl = (obj, name) => {
    const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    console.log('%c저장 → ' + name, 'color:#0a7;font-weight:bold');
  };
  const htmlToText = (root) => {
    const c = root.cloneNode(true);
    c.querySelectorAll('script,style,iframe').forEach(n => n.remove());
    let h = c.innerHTML
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|blockquote|td)>/gi, '\n')
      .replace(/<img[^>]*>/gi, '');
    const tmp = document.createElement('div');
    tmp.innerHTML = h;
    return (tmp.textContent || '').replace(/\u200b/g, '').replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  const archive = { blogId: B, collectedAt: new Date().toISOString(), config: { INCLUDE_HTML, DELAY }, categories: [], posts: [] };
  window.__archive = archive;
  window.saveArchive = () => dl(archive, `${B}_archive_full.json`);

  // ---------- 1) 게시판 트리 ----------
  const cats = [];
  const pushCat = (no, name, parent, cnt) => {
    if (no == null || !name) return;
    const k = String(no);
    if (cats.some(c => c.categoryNo === k)) return;
    cats.push({ categoryNo: k, categoryName: String(name).trim(), parentCategoryNo: parent != null ? String(parent) : null, postCnt: cnt != null ? cnt : null });
  };
  const walk = (arr, parent) => (arr || []).forEach(c => {
    const no = c.categoryNo != null ? c.categoryNo : c.categoryId;
    pushCat(no, c.categoryName || c.name, parent != null ? parent : c.parentCategoryNo, c.postCnt != null ? c.postCnt : c.postCount);
    const kids = c.categoryList || c.childCategoryList || c.children || c.subCategoryList;
    if (kids && kids.length) walk(kids, no);
  });
  for (const u of [`https://blog.naver.com/api/blogs/${B}/category-list`, `https://m.blog.naver.com/api/blogs/${B}/category-list`]) {
    if (cats.length) break;
    const j = await getJSON(u); const res = j && (j.result || j);
    const arr = res && (res.mylogCategoryList || res.categoryList || res.categories);
    if (arr && arr.length) walk(arr, null);
  }
  if (!cats.length) {   // 폴백: 현재 페이지 카테고리 메뉴
    const docs = [document];
    const fr = document.getElementById('mainFrame');
    if (fr && fr.contentDocument) docs.push(fr.contentDocument);
    docs.forEach(d => d.querySelectorAll('a[href*="categoryNo="]').forEach(a => {
      const m = a.getAttribute('href').match(/categoryNo=(\d+)/);
      const raw = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const cm = raw.match(/\((\d+)\)\s*$/);
      const nm = raw.replace(/\(\d+\)\s*$/, '').trim();
      if (m && nm) pushCat(m[1], nm, null, cm ? +cm[1] : null);
    }));
  }
  // 전체 경로(상위 > 하위) 계산
  const byNo = {}; cats.forEach(c => byNo[c.categoryNo] = c);
  cats.forEach(c => {
    const parts = [c.categoryName]; let p = c.parentCategoryNo, guard = 0;
    while (p && byNo[p] && guard++ < 10) { parts.unshift(byNo[p].categoryName); p = byNo[p].parentCategoryNo; }
    c.path = parts.join(' > ');
  });
  archive.categories = cats;
  console.log('%c[게시판] ' + cats.length + '개', 'color:#07a;font-weight:bold');
  console.table(cats.map(c => ({ no: c.categoryNo, 경로: c.path, 신고글수: c.postCnt })));

  // ---------- 2) 목록 수집 (게시판별 → 정확한 분류 확보) ----------
  const meta = {};   // logNo -> {title,date,categoryNo,categoryName,path}
  const order = [];
  const listPages = async (categoryNo, label) => {
    let got = 0, total = null;
    for (let page = 1; page <= 400; page++) {
      const u = `https://blog.naver.com/PostTitleListAsync.naver?blogId=${B}&viewdate=&currentPage=${page}`
              + `&categoryNo=${categoryNo}&parentCategoryNo=&countPerPage=${PER}`;
      let j = null;
      for (let a = 0; a < 3 && !j; a++) { j = await getJSON(u); if (!j) await sleep(700); }
      const items = (j && j.postList) || [];
      if (total == null && j) total = parseInt(j.totalCount, 10);
      if (!items.length) break;
      let fresh = 0;
      for (const it of items) {
        const k = String(it.logNo);
        if (!meta[k]) { meta[k] = { logNo: k, url: `https://blog.naver.com/${B}/${k}` }; order.push(k); fresh++; }
        const m = meta[k];
        m.title = dec(it.title);
        m.date = it.addDate;
        if (it.commentCount != null) m.commentCount = +it.commentCount;
        if (categoryNo !== '') {
          m.categoryNo = String(categoryNo);
          m.categoryName = byNo[String(categoryNo)] ? byNo[String(categoryNo)].categoryName : null;
          m.categoryPath = byNo[String(categoryNo)] ? byNo[String(categoryNo)].path : null;
        } else if (m.categoryNo == null && it.categoryNo != null) {
          m.categoryNo = String(it.categoryNo);
          m.categoryName = byNo[String(it.categoryNo)] ? byNo[String(it.categoryNo)].categoryName : null;
          m.categoryPath = byNo[String(it.categoryNo)] ? byNo[String(it.categoryNo)].path : null;
        }
        got++;
      }
      console.log(`[목록] ${label} p${page} → 이 게시판 ${got}/${total}, 전체 누적 ${order.length}`);
      if (total && got >= total) break;
      if (!fresh && categoryNo === '') break;
      await sleep(DELAY);
    }
    return total;
  };

  for (const c of cats) { await listPages(c.categoryNo, `[${c.path}]`); }
  const totalAll = await listPages('', '[전체]');   // 카테고리에 안 잡힌 글 보강
  archive.totalReported = totalAll;
  console.log(`%c[목록 완료] 고유 글 ${order.length}건 / 블로그 신고 총계 ${totalAll}`, 'color:#07a;font-weight:bold');

  // ---------- 3) 본문 수집 ----------
  const rx = (h, re) => { const m = h.match(re); return m ? dec(m[1]) : null; };
  const fetchPost = async (k) => {
    const urls = [
      `https://blog.naver.com/PostView.naver?blogId=${B}&logNo=${k}&redirect=Dlog&widgetTypeCall=true&directAccess=false`,
      `https://m.blog.naver.com/PostView.naver?blogId=${B}&logNo=${k}`
    ];
    for (const u of urls) {
      let html = null;
      try { html = await (await fetch(u, { credentials: 'include' })).text(); } catch (e) { continue; }
      if (!html) continue;
      const d = new DOMParser().parseFromString(html, 'text/html');
      const el = d.querySelector('.se-main-container') || d.querySelector('#postViewArea')
              || d.querySelector('.post-view') || d.querySelector('#viewTypeSelector');
      if (!el) continue;
      const text = htmlToText(el);
      if (!text.length && !el.querySelector('img')) continue;

      const images = [...el.querySelectorAll('img')].map(im => {
        const src = im.getAttribute('data-lazy-src') || im.getAttribute('src') || '';
        return src ? { src, orig: src.split('?')[0], alt: im.getAttribute('alt') || '' } : null;
      }).filter(Boolean).filter(o => !/blogpfthumb|static\.naver|ssl\.pstatic\.net\/static/.test(o.src));

      const links = [...el.querySelectorAll('a[href]')].map(a => ({
        href: a.getAttribute('href'), text: (a.textContent || '').replace(/\s+/g, ' ').trim()
      })).filter(o => /^https?:/.test(o.href));

      let tags = [];
      d.querySelectorAll('#tagList a, .wrap_tag a, .post_tag a, .tag_area a').forEach(a => {
        const t = (a.textContent || '').replace(/^#/, '').trim(); if (t) tags.push(t);
      });
      if (!tags.length) { const m = html.match(/"tagName"\s*:\s*"([^"]+)"/g); if (m) tags = m.map(s => dec(s.split('"')[3])); }
      tags = [...new Set(tags)];

      const videos = [...el.querySelectorAll('.se-video, iframe[src*="naver"], iframe[src*="youtube"]')]
        .map(v => v.getAttribute('src') || v.getAttribute('data-module') || '').filter(Boolean);

      return {
        text, chars: text.length,
        html: INCLUDE_HTML ? el.innerHTML : undefined,
        htmlBytes: el.innerHTML.length,
        images, imageCount: images.length, links, tags, videos,
        publishedAt: rx(html, /"addDate"\s*:\s*"?(\d{10,13})/) || (d.querySelector('.se_publishDate, .blog_date, .date') || {}).textContent?.trim() || null,
        categoryNameFromPost: rx(html, /["']categoryName["']\s*:\s*["']([^"']+)["']/),
        categoryNoFromPost: rx(html, /["']categoryNo["']\s*:\s*["']?(\d+)/),
        sympathyCount: (html.match(/"sympathyCount"\s*:\s*(\d+)/) || [])[1] || null,
        commentCountFromPost: (html.match(/"commentCount"\s*:\s*(\d+)/) || [])[1] || null,
        via: u.includes('m.blog') ? 'mobile' : 'pc'
      };
    }
    return null;
  };

  let fail = 0, part = 0, buf = [];
  const t0 = Date.now();
  const flush = (final) => {
    if (!buf.length) return;
    part++;
    dl({ blogId: B, part, count: buf.length, posts: buf }, `${B}_part${String(part).padStart(2, '0')}.json`);
    buf = [];
  };

  for (let i = 0; i < order.length; i++) {
    const k = order[i];
    const m = meta[k];
    const body = await fetchPost(k);
    let rec;
    if (body) {
      rec = Object.assign({}, m, body);
      if (!rec.categoryName && rec.categoryNameFromPost) rec.categoryName = rec.categoryNameFromPost;
      if (!rec.categoryNo && rec.categoryNoFromPost) rec.categoryNo = rec.categoryNoFromPost;
      if (!rec.categoryPath) rec.categoryPath = rec.categoryName || '미분류';
    } else { rec = Object.assign({}, m, { text: '', chars: 0, error: 'BODY_FETCH_FAILED' }); fail++; }
    if (!rec.categoryName) { rec.categoryName = '미분류'; rec.categoryPath = '미분류'; }
    archive.posts.push(rec); buf.push(rec);
    if (buf.length >= CHUNK) flush(false);
    if (i % 10 === 0 || i === order.length - 1) {
      const el = (Date.now() - t0) / 1000;
      console.log(`[본문] ${i + 1}/${order.length}  실패 ${fail}  경과 ${Math.round(el)}s  남은시간 약 ${Math.round(el / (i + 1) * (order.length - i - 1))}s`);
    }
    await sleep(DELAY);
  }
  flush(true);

  // ---------- 4) 메타 저장 ----------
  const byCat = {};
  archive.posts.forEach(p => { const k = p.categoryPath || '미분류'; byCat[k] = (byCat[k] || 0) + 1; });
  archive.summary = {
    collected: archive.posts.length, failed: fail,
    totalChars: archive.posts.reduce((s, p) => s + (p.chars || 0), 0),
    totalImages: archive.posts.reduce((s, p) => s + (p.imageCount || 0), 0),
    byCategory: byCat, parts: part
  };
  dl({ blogId: B, collectedAt: archive.collectedAt, categories: cats, summary: archive.summary,
       index: archive.posts.map(p => ({ logNo: p.logNo, date: p.date, title: p.title, categoryPath: p.categoryPath, url: p.url, chars: p.chars })) },
     `${B}_meta.json`);

  console.log('%c=== 수집 완료 ===', 'font-size:15px;font-weight:bold;color:#0a7');
  console.table(Object.entries(byCat).map(([k, v]) => ({ 게시판: k, 글수: v })));
  console.log('수집', archive.posts.length, '/ 실패', fail, '/ 총 글자수', archive.summary.totalChars.toLocaleString(), '/ 파일', part + 1, '개');
  return archive.summary;
})();
