
/* ============================================================
   [3단계] 본문 이미지 전량 다운로드 (ZIP 묶음)
   블로그: https://blog.naver.com/pillion21
   전제  : 2_전량수집.js 를 실행해 pillion21_partNN.json 을 받아둔 상태
   사용법: 같은 탭(수집 직후)이면 그냥 붙여넣고 Enter → window.__archive 자동 사용
           탭을 닫았다면 파일 선택창이 뜨니 pillion21_part*.json 을 전부 선택
   결과  : pillion21_images_01.zip, 02.zip ... + pillion21_images_manifest.json
           ZIP 안 폴더는 게시판 이름 그대로. 전부 선배님 폴더에 넣어주세요.
   ============================================================ */
(async () => {
  const B = 'pillion21';
  const ZIP_MB = 120;    // ZIP 하나당 목표 용량(MB)
  const DELAY  = 60;     // 이미지 요청 간격(ms)
  const CONC   = 4;      // 동시 다운로드 수

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const dl = (blob, name) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    console.log('%c저장 → ' + name + ' (' + (blob.size / 1048576).toFixed(1) + 'MB)', 'color:#0a7;font-weight:bold');
  };
  const safe = s => String(s || '미분류').replace(/\s*>\s*/g, '__').replace(/[\\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);

  // ---------- 순수 JS ZIP (무압축 store) ----------
  const CRCT = (() => { const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRCT[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const now = new Date();
  const DT = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const DD = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
  class Zip {
    constructor() { this.parts = []; this.cd = []; this.off = 0; this.n = 0; this.bytes = 0; }
    add(name, u8) {
      const enc = new TextEncoder().encode(name), crc = crc32(u8), L = u8.length;
      const lh = new Uint8Array(30 + enc.length), lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true); lv.setUint16(10, DT, true); lv.setUint16(12, DD, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, L, true); lv.setUint32(22, L, true);
      lv.setUint16(26, enc.length, true); lv.setUint16(28, 0, true); lh.set(enc, 30);
      const ch = new Uint8Array(46 + enc.length), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, DT, true); cv.setUint16(14, DD, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, L, true); cv.setUint32(24, L, true);
      cv.setUint16(28, enc.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true);
      cv.setUint32(42, this.off, true); ch.set(enc, 46);
      this.parts.push(lh, u8); this.cd.push(ch);
      this.off += lh.length + L; this.n++; this.bytes += L;
    }
    blob() {
      const cdSize = this.cd.reduce((s, c) => s + c.length, 0);
      const eo = new Uint8Array(22), ev = new DataView(eo.buffer);
      ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
      ev.setUint16(8, this.n, true); ev.setUint16(10, this.n, true);
      ev.setUint32(12, cdSize, true); ev.setUint32(16, this.off, true); ev.setUint16(20, 0, true);
      return new Blob([...this.parts, ...this.cd, eo], { type: 'application/zip' });
    }
  }

  // ---------- 수집본 로드 ----------
  let posts = null;
  if (window.__archive && window.__archive.posts && window.__archive.posts.length) {
    posts = window.__archive.posts;
    console.log('[로드] 메모리의 window.__archive 사용 —', posts.length, '건');
  } else {
    console.log('%c수집본이 메모리에 없습니다. 파일 선택창에서 pillion21_part*.json 을 전부 선택하세요.', 'color:#c60;font-weight:bold');
    posts = await new Promise(res => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.multiple = true; inp.accept = '.json';
      inp.style.cssText = 'position:fixed;z-index:99999;top:10px;left:10px;padding:12px;background:#fff;border:3px solid #03c75a;font-size:16px';
      document.body.appendChild(inp);
      inp.onchange = async () => {
        const all = [];
        for (const f of inp.files) {
          try { const j = JSON.parse(await f.text()); if (j.posts) all.push(...j.posts); } catch (e) { console.warn('파싱 실패', f.name); }
        }
        inp.remove(); res(all);
      };
      inp.click();
    });
    console.log('[로드] 파일에서', posts.length, '건');
  }
  if (!posts || !posts.length) { console.error('수집본을 찾지 못했습니다. 2_전량수집.js 를 먼저 실행하세요.'); return; }

  // ---------- 이미지 목록 만들기 ----------
  const jobs = [], seen = new Map();
  for (const p of posts) {
    const cat = safe(p.categoryPath || p.categoryName || '미분류');
    const dt = (p.date || '').replace(/[.\s]+/g, '-').replace(/-+$/, '');
    (p.images || []).forEach((im, i) => {
      const url = (im.orig || im.src || '').split('?')[0];
      if (!url || !/^https?:/.test(url)) return;
      if (seen.has(url)) return;
      let ext = (url.match(/\.(jpe?g|png|gif|webp|bmp|svg)$/i) || [])[1] || 'jpg';
      const name = `${cat}/${dt}_${p.logNo}_${String(i + 1).padStart(2, '0')}.${ext.toLowerCase()}`;
      seen.set(url, name);
      jobs.push({ url: url + '?type=w966', raw: url, name, logNo: p.logNo, cat });
    });
  }
  const hosts = {};
  jobs.forEach(j => { const h = new URL(j.raw).host; hosts[h] = (hosts[h] || 0) + 1; });
  console.log('%c[이미지] 고유 ' + jobs.length + '개', 'font-size:14px;font-weight:bold;color:#07a');
  console.table(Object.entries(hosts).map(([h, n]) => ({ 호스트: h, 개수: n })));
  if (!jobs.length) { console.warn('이미지가 없습니다.'); return; }

  // ---------- CORS 사전 점검 ----------
  const testable = {};
  for (const h of Object.keys(hosts)) {
    const s = jobs.find(j => new URL(j.raw).host === h);
    try { const r = await fetch(s.url, { credentials: 'omit' }); testable[h] = r.ok; }
    catch (e) { testable[h] = false; }
  }
  console.table(Object.entries(testable).map(([h, ok]) => ({ 호스트: h, 다운로드가능: ok ? 'OK' : '차단(CORS)' })));
  const blocked = Object.entries(testable).filter(([, ok]) => !ok).map(([h]) => h);
  if (blocked.length) {
    console.warn('%c차단된 호스트: ' + blocked.join(', '), 'color:#c00;font-weight:bold');
    console.warn('%c해결: 새 탭에서 https://' + blocked[0] + '/ 를 연 뒤(404여도 됨) 그 탭 콘솔에서 이 스크립트를 다시 실행하세요. 같은 출처가 되어 다운로드됩니다.', 'color:#c00');
  }
  const work = jobs.filter(j => testable[new URL(j.raw).host]);
  if (!work.length) { console.error('현재 출처에서 받을 수 있는 이미지가 없습니다. 위 안내대로 호스트 탭에서 재실행하세요.'); return; }
  console.log('이번 실행에서 받을 이미지:', work.length, '/', jobs.length);

  // ---------- 다운로드 + ZIP ----------
  const manifest = [];
  let zip = new Zip(), zipNo = 0, done = 0, fail = 0;
  const LIMIT = ZIP_MB * 1048576;
  const flush = () => { if (!zip.n) return; zipNo++; dl(zip.blob(), `${B}_images_${String(zipNo).padStart(2, '0')}.zip`); zip = new Zip(); };

  const t0 = Date.now();
  for (let i = 0; i < work.length; i += CONC) {
    const batch = work.slice(i, i + CONC);
    const res = await Promise.all(batch.map(async j => {
      for (const u of [j.url, j.raw]) {
        try {
          const r = await fetch(u, { credentials: 'omit' });
          if (!r.ok) continue;
          const b = new Uint8Array(await r.arrayBuffer());
          if (b.length > 0) return { j, b };
        } catch (e) { }
      }
      return { j, b: null };
    }));
    for (const { j, b } of res) {
      if (b) { zip.add(j.name, b); manifest.push({ url: j.raw, file: j.name, bytes: b.length, logNo: j.logNo, category: j.cat }); done++; }
      else { manifest.push({ url: j.raw, file: null, error: 'FETCH_FAILED', logNo: j.logNo, category: j.cat }); fail++; }
    }
    if (zip.bytes >= LIMIT) flush();
    if (i % 40 === 0) {
      const el = (Date.now() - t0) / 1000;
      console.log(`[이미지] ${done + fail}/${work.length}  실패 ${fail}  ${(zip.bytes / 1048576).toFixed(0)}MB 대기  남은시간 약 ${Math.round(el / (done + fail || 1) * (work.length - done - fail))}s`);
    }
    await sleep(DELAY);
  }
  flush();
  dl(new Blob([JSON.stringify({ blogId: B, origin: location.origin, total: jobs.length, downloaded: done, failed: fail, hosts, blockedHosts: blocked, items: manifest }, null, 1)], { type: 'application/json' }), `${B}_images_manifest.json`);

  console.log('%c=== 이미지 수집 완료 ===', 'font-size:15px;font-weight:bold;color:#0a7');
  console.log('성공', done, '/ 실패', fail, '/ ZIP', zipNo, '개');
  if (blocked.length) console.warn('아직 못 받은 호스트가 있습니다: ' + blocked.join(', ') + ' → 해당 호스트 탭에서 재실행');
  window.__imgManifest = manifest;
})();
