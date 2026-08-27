# -*- coding: utf-8 -*-
import io, json, os
D = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(D)
CSS = io.open(os.path.join(D,'notes_css.txt'), encoding='utf-8').read()
APP = io.open(os.path.join(D,'notes_app.js'), encoding='utf-8').read()
POSTS = io.open(os.path.join(ROOT,'_수집원본','notes-posts.json'), encoding='utf-8').read()
NOTES = json.load(io.open(os.path.join(ROOT,'_수집원본','notes-data.json'), encoding='utf-8'))

FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n'
 '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
 '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@400;700;800'
 '&family=IBM+Plex+Sans+KR:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">')

def shell(cfg):
    return ('<div id="shell">'
      '<header class="top">'
        '<h1 class="brand">선배님의 20년<small>내 생각</small></h1>'
        '<span class="badge" id="mode">연결 확인 중</span>'
        '<div class="topnav">'
          f'<a class="tbtn" href="{cfg["dash"]}" target="_blank" rel="noopener">아카이브 ↗</a>'
          f'<a class="tbtn" href="{cfg["docs"]}" target="_blank" rel="noopener">정리 문서 ↗</a>'
          '<button class="tbtn" id="exportbtn">MD 내보내기</button>'
          '<button class="tbtn" id="themebtn">테마</button>'
          '<button class="tbtn primary" id="newbtn">＋ 새 노트</button>'
        '</div>'
      '</header>'
      '<main>'
        '<nav class="rail">'
          '<div class="railtop">'
            '<input id="nsearch" type="search" placeholder="내 노트 검색" autocomplete="off">'
            '<div class="filters">'
              '<button class="fbtn on" data-st="all">전체</button>'
              '<button class="fbtn" data-st="draft">초안</button>'
              '<button class="fbtn" data-st="done">정리됨</button>'
            '</div>'
          '</div>'
          '<div class="nlist" id="nlist"></div>'
        '</nav>'
        '<section class="pane" id="pane"></section>'
      '</main>'
      '</div>')

def js_safe(s): return s.replace('<','\\u003c')

def build(out, cfg, standalone):
    body = (shell(cfg) + '\n<div id="toast"></div>\n'
      + '<script type="application/json" id="cfg">' + js_safe(json.dumps(cfg, ensure_ascii=False)) + '</script>\n'
      + '<script type="application/json" id="posts">' + js_safe(POSTS) + '</script>\n'
      + '<script type="application/json" id="notes">' + js_safe(json.dumps(NOTES, ensure_ascii=False)) + '</script>\n'
      + '<script type="text/plain" id="appsrc">' + APP + '</script>\n'
      + '<script>' + APP + '</script>')
    head = '<title>선배님의 20년 — 내 생각</title>\n' + FONTS + '\n<style id="css">' + CSS + '</style>'
    page = head + '\n' + body
    if standalone:
        page = ('<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
                + head + '\n</head>\n<body>\n' + body + '\n</body>\n</html>\n')
    io.open(out,'w',encoding='utf-8').write(page)
    return len(page.encode('utf-8'))

if __name__ == '__main__':
    a = build(os.path.join(ROOT,'내생각.html'), {'dash':'대시보드.html','docs':'정리.html'}, True)
    b = build(os.path.join(ROOT,'_수집원본','artifact_notes.html'),
              {'dash':'https://claude.ai/code/artifact/642ad21c-4fae-414b-a10d-f7a3c0d24ebe',
               'docs':'https://claude.ai/code/artifact/b30681e8-c608-489d-9b0d-609993664216'}, False)
    print(f'내생각.html {a/1024:.0f} KB / 아티팩트판 {b/1024:.0f} KB')
