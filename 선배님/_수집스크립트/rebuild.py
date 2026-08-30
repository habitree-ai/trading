# -*- coding: utf-8 -*-
"""신규 글 수집 후 파생물 일괄 재생성.
   실행: python _수집스크립트/rebuild.py   (device_bash 또는 PC 어느 쪽이든)"""
import io, os, re, csv, json, collections, subprocess, sys
D = os.path.dirname(os.path.abspath(__file__))
R = os.path.dirname(D)

def load(p, sig=True):
    return json.load(io.open(os.path.join(R, p), encoding='utf-8-sig' if sig else 'utf-8'))

def safe(s, mx=60):
    s = re.sub(r'\s*>\s*', '__', s or '미분류')
    s = re.sub(r'[\\/:*?"<>|]', '_', s)
    s = re.sub(r'\s+', ' ', s).strip()[:mx].rstrip('. ')
    return s or '무제'

def body(rel):
    t = io.open(os.path.join(R, '아카이브', rel), encoding='utf-8').read()
    if t.startswith('---'):
        e = t.find('\n---', 3)
        if e > 0: t = t[e+4:]
    t = re.sub(r'^\s*#\s+.*\n+', '', t.lstrip('\n'), count=1)
    return re.split(r'\n## (?:이미지|본문 내 링크)\n', t)[0].strip()

# 1) 이미지 실제 파일 → 글별 재매핑
have = collections.defaultdict(list)
for root, _, fs in os.walk(os.path.join(R, '이미지')):
    cat = os.path.relpath(root, os.path.join(R, '이미지')).replace('\\', '/')
    if cat == '.': continue
    for f in sorted(fs):
        if f.startswith('0000-00-00_'): continue   # 날짜 파싱 실패 잔재는 제외
        m = re.match(r'.+?_(\d+)_v?\d+\.', f)
        if m: have[m.group(1)].append(cat + '/' + f)

idx = load('_수집원본/인덱스.json')
for r in idx:
    r['imageFiles'] = sorted(have.get(r['logNo'], []))
    r['images'] = len(r['imageFiles'])
json.dump(idx, io.open(os.path.join(R, '_수집원본/인덱스.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)

cats = load('_수집원본/게시판.json')
miss = []
mp = os.path.join(R, '_수집원본/결손목록.json')
if os.path.exists(mp): miss = json.load(io.open(mp, encoding='utf-8'))
byurl = {r['url']: r['logNo'] for r in idx}
missby = collections.Counter()
for m in miss: missby[byurl.get(m['url'], '')] += 1

# 2) 인덱스.csv
order = {c['path']: i for i, c in enumerate(cats)}
rows = sorted(idx, key=lambda r: (order.get(r['categoryPath'], 99), r['date']))
with io.open(os.path.join(R, '인덱스.csv'), 'w', encoding='utf-8-sig', newline='') as f:
    w = csv.writer(f)
    w.writerow(['번호','게시판','날짜','제목','글자수','이미지수','결손이미지','태그','원문URL','MD파일'])
    for i, r in enumerate(rows, 1):
        w.writerow([i, r['categoryPath'], r['date'], r['title'], r['chars'], r['images'],
                    missby.get(r['logNo'], 0), ' '.join(r.get('tags') or []),
                    r['url'], '아카이브/' + r['mdFile']])

# 3) 대시보드 데이터 + 노트 글 색인
posts = []
for r in sorted(idx, key=lambda r: (r['date'], r['logNo'])):
    posts.append({"id": r['logNo'], "c": r['categoryPath'], "d": r['date'], "t": r['title'],
                  "u": r['url'], "n": r['chars'], "g": r.get('tags') or [],
                  "m": r.get('imageFiles') or [], "x": missby.get(r['logNo'], 0),
                  "b": body(r['mdFile'])})
tree = [{"no": c['no'], "name": c['name'], "path": c['path'], "parent": c['parent'],
         "n": sum(1 for p in posts if p['c'] == c['path'])} for c in cats]
tree = [c for c in tree if c['n'] > 0]
ys = collections.Counter(p['d'][:4] for p in posts)
meta = {"blog": "pillion21", "url": "https://blog.naver.com/pillion21",
        "collected": __import__('datetime').date.today().isoformat(),
        "total": len(posts), "chars": sum(p['n'] for p in posts),
        "images": sum(len(p['m']) for p in posts), "missing": len(miss),
        "from": posts[0]['d'], "to": posts[-1]['d'],
        "years": [[y, ys[y]] for y in sorted(ys)]}
io.open(os.path.join(R, '_수집원본/dashboard-data.js'), 'w', encoding='utf-8').write(
    "window.BLOG_DATA=" + json.dumps({"meta": meta, "cats": tree, "posts": posts},
                                     ensure_ascii=False, separators=(',', ':')) + ";")
json.dump([{"i": p['id'], "d": p['d'], "t": p['t'], "c": p['c'], "u": p['u']} for p in posts],
          io.open(os.path.join(R, '_수집원본/notes-posts.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, separators=(',', ':'))

# 4) 세 페이지 일괄 생성 (아카이브 · 투자철학 · 내 생각)
subprocess.run([sys.executable, os.path.join(D, 'build_all.py')], check=False)

print(f"글 {len(posts)}편 · 이미지 {meta['images']}장 · 결손 {meta['missing']}장 · "
      f"{meta['from']} ~ {meta['to']}")
print("재생성: 인덱스.csv / dashboard-data.js / notes-posts.json / 아카이브.html / 투자철학.html / 내생각.html / artifact_*.html")
