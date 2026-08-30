# -*- coding: utf-8 -*-
"""세 페이지(아카이브·내 생각·투자철학)를 공통 네비로 묶어 로컬판/아티팩트판을 생성."""
import io, os, sys, json, re
D = os.path.dirname(os.path.abspath(__file__)); R = os.path.dirname(D)
sys.path.insert(0, D)
from md2html import convert

ART = {
 'board': 'https://claude.ai/code/artifact/642ad21c-4fae-414b-a10d-f7a3c0d24ebe',
 'notes': 'https://claude.ai/code/artifact/ceced558-7a8d-4fc2-aa9c-b3aa25882b56',
 'docs':  'https://claude.ai/code/artifact/b30681e8-c608-489d-9b0d-609993664216',
}
LOCAL = {'board': '아카이브.html', 'notes': '내생각.html', 'docs': '투자철학.html'}
TABS = [('board', '아카이브'), ('notes', '내 생각'), ('docs', '투자철학')]

FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n'
 '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
 '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@400;700;800'
 '&family=IBM+Plex+Sans+KR:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">')

def rd(p): return io.open(os.path.join(D, p), encoding='utf-8').read()
SHARED = rd('shared_css.txt')

def nav(active, local, extra=''):
    href = (lambda k: LOCAL[k] if local else ART[k])
    tabs = ''
    for k, label in TABS:
        if k == active:
            tabs += f'<span class="tab on">{label}</span>'
        else:
            t = '' if local else ' target="_blank" rel="noopener"'
            tabs += f'<a class="tab" href="{href(k)}"{t}>{label}</a>'
    return ('<nav class="nav"><span class="site">선배님의 20년</span>' + tabs +
            '<span class="right">' + extra + '<button id="themebtn">테마</button></span></nav>')

def page(out, title, css, body, standalone, extra_head=''):
    head = f'<title>{title}</title>\n{FONTS}\n{extra_head}<style id="css">{css}</style>'
    h = head + '\n' + body
    if standalone:
        h = ('<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
             '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
             + head + '\n</head>\n<body class="' + ('board' if 'board' in css[:0] else '') + '">\n'
             + body + '\n</body>\n</html>\n')
    io.open(out, 'w', encoding='utf-8').write(h)
    return len(h.encode('utf-8'))

def js_safe(s): return s.replace('<', '\\u003c')

# ---------------- 1) 아카이브 (게시판 뷰) ----------------
def build_board(local):
    css = SHARED + rd('board_css.txt')
    app = rd('board_app.js')
    data = io.open(os.path.join(R, '_수집원본/dashboard-data.js'), encoding='utf-8').read()
    if local:
        ds = '<script src="_수집원본/dashboard-data.js"></script>'
    else:
        d = json.loads(data[len('window.BLOG_DATA='):-1])
        for p in d['posts']:
            if len(p['b']) > 700:
                c = p['b'][:700]; sp = c.rfind('\n'); p['b'] = (c[:sp] if sp > 420 else c).rstrip()
        ds = '<script>window.BLOG_DATA=' + json.dumps(d, ensure_ascii=False, separators=(',', ':')) + ';</script>'
    cfg = json.dumps({'hasImg': local, 'excerpt': not local}, ensure_ascii=False)
    body = ('<div id="shell">' + nav('board', local) +
            '<div class="blogbar"><h1>선배님의 20년</h1>'
            '<span class="addr">blog.naver.com/pillion21</span>'
            '<div class="nums" id="nums"></div></div>'
            '<main class="board"><aside class="cats" id="cats"></aside>'
            '<section class="body" id="body"></section></main></div>\n'
            + ds + '\n<script>window.NBCFG=' + cfg + ';</script>\n<script>' + app + '</script>')
    out = os.path.join(R, LOCAL['board']) if local else os.path.join(R, '_수집원본/artifact_board.html')
    head = f'<title>선배님의 20년 — 아카이브</title>\n{FONTS}\n<style id="css">{css}</style>'
    h = head + '\n' + body
    if local:
        h = ('<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
             '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
             + head + '\n</head>\n<body class="board">\n' + body + '\n</body>\n</html>\n')
    else:
        h = ('<script>document.body.classList.add("board")</script>\n' + h)
    io.open(out, 'w', encoding='utf-8').write(h)
    return len(h.encode('utf-8'))

# ---------------- 2) 투자철학 (정리 문서) ----------------
DOCS = [('philosophy', '투자철학 정리', '투자철학정리.md', '방법론 5층 구조와, 그대로 쓸 때 생길 문제'),
        ('boards',     '게시판별 정리', '게시판별정리.md', '게시판 19개를 원 순서·원 이름 그대로'),
        ('themes',     '종목·테마 정리', '종목테마별정리.md', '종목 타임라인과 개념어의 등장 시점'),
        ('missing',    '결손 목록',     '결손목록.md',     '회수하지 못한 이미지 59장의 내역')]

def build_docs(local):
    css = SHARED + rd('docs_css.txt')
    app = rd('docs_app.js')
    navp, docp = [], []
    for key, title, fn, desc in DOCS:
        html, toc = convert(io.open(os.path.join(R, fn), encoding='utf-8').read())
        navp.append(f'<button class="dbtn" data-doc="{key}"><b>{title}</b><span>{desc}</span></button>'
                    + f'<div class="toc" data-doc="{key}" hidden>'
                    + ''.join(f'<a class="l{lv}" data-doc="{key}" href="#{sid}">{t}</a>'
                              for j, (lv, t, sid) in enumerate(toc) if j > 0) + '</div>')
        docp.append(f'<section class="doc" id="doc-{key}">{html}</section>')
    body = ('<div id="shell">' + nav('docs', local) +
            '<main class="docs"><nav class="rail"><div class="railhead">문서</div>' + ''.join(navp) +
            '</nav><article id="art">' + ''.join(docp) + '</article></main></div>\n<script>' + app + '</script>')
    out = os.path.join(R, LOCAL['docs']) if local else os.path.join(R, '_수집원본/artifact_docs.html')
    head = f'<title>선배님의 20년 — 투자철학</title>\n{FONTS}\n<style id="css">{css}</style>'
    h = head + '\n' + body
    if local:
        h = ('<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
             '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
             + head + '\n</head>\n<body class="docs">\n' + body + '\n</body>\n</html>\n')
    else:
        h = ('<script>document.body.classList.add("docs")</script>\n' + h)
    io.open(out, 'w', encoding='utf-8').write(h)
    return len(h.encode('utf-8'))


# ---------------- 3) 내 생각 ----------------
def build_notes(local):
    css = SHARED + rd('notes_css2.txt')
    app = rd('notes_app.js')
    posts = io.open(os.path.join(R, '_수집원본/notes-posts.json'), encoding='utf-8').read()
    notes = json.load(io.open(os.path.join(R, '_수집원본/notes-data.json'), encoding='utf-8'))
    cfg = {'dash': LOCAL['board'] if local else ART['board'],
           'docs': LOCAL['docs'] if local else ART['docs']}
    extra = ('<span class="badge" id="mode">연결 확인 중</span>'
             '<button id="exportbtn">MD 내보내기</button>'
             '<button class="primary" id="newbtn">＋ 새 노트</button>')
    shell = ('<div id="shell">' + nav('notes', local, extra) +
      '<main class="notes"><nav class="rail"><div class="railtop">'
      '<input id="nsearch" type="search" placeholder="내 노트 검색" autocomplete="off">'
      '<div class="filters"><button class="fbtn on" data-st="all">전체</button>'
      '<button class="fbtn" data-st="draft">초안</button>'
      '<button class="fbtn" data-st="done">정리됨</button></div></div>'
      '<div class="nlist" id="nlist"></div></nav>'
      '<section class="pane" id="pane"></section></main></div>')
    body = (shell + '\n<div id="toast"></div>\n'
      + '<script type="application/json" id="cfg">' + js_safe(json.dumps(cfg, ensure_ascii=False)) + '</script>\n'
      + '<script type="application/json" id="posts">' + js_safe(posts) + '</script>\n'
      + '<script type="application/json" id="notes">' + js_safe(json.dumps(notes, ensure_ascii=False)) + '</script>\n'
      + '<script type="text/plain" id="appsrc">' + app + '</script>\n'
      + '<script>' + app + '</script>')
    head = f'<title>선배님의 20년 — 내 생각</title>\n{FONTS}\n<style id="css">{css}</style>'
    h = head + '\n' + body
    out = os.path.join(R, LOCAL['notes']) if local else os.path.join(R, '_수집원본/artifact_notes.html')
    if local:
        h = ('<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
             '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
             + head + '\n</head>\n<body class="notes">\n' + body + '\n</body>\n</html>\n')
    else:
        h = ('<script>document.body.classList.add("notes")</script>\n' + h)
    io.open(out, 'w', encoding='utf-8').write(h)
    return len(h.encode('utf-8'))

if __name__ == '__main__':
    a = build_board(True); b = build_board(False)
    c = build_docs(True);  d = build_docs(False)
    e = build_notes(True); f = build_notes(False)
    print(f'아카이브.html {a//1024}KB / artifact {b//1024}KB')
    print(f'투자철학.html {c//1024}KB / artifact {d//1024}KB')
    print(f'내생각.html   {e//1024}KB / artifact {f//1024}KB')
