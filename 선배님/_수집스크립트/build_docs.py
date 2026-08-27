# -*- coding: utf-8 -*-
import io, os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from md2html import convert

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = [
    ('philosophy', '투자철학 정리', '투자철학정리.md', '방법론 5층 구조와, 그대로 쓸 때 생길 문제'),
    ('boards',     '게시판별 정리', '게시판별정리.md', '게시판 19개를 원 순서·원 이름 그대로'),
    ('themes',     '종목·테마 정리', '종목테마별정리.md', '종목 타임라인과 개념어의 등장 시점'),
    ('missing',    '결손 목록',     '결손목록.md',     '회수하지 못한 이미지 59장의 내역'),
]

CSS = r"""
:root{
  --bg:#FCFCFA; --surface:#FFFFFF; --surface-2:#F4F3EF; --line:#E2E0D9; --line-soft:#EDEBE5;
  --ink:#1A1A18; --ink-2:#4A4842; --ink-3:#7C7A72;
  --accent:#B3352C; --accent-soft:#F0DCD9; --accent-ink:#8E2822; --link:#2F5C8F;
  --shadow:0 1px 2px rgba(26,26,24,.06),0 8px 24px rgba(26,26,24,.06);
  --mono:'IBM Plex Mono','SFMono-Regular',Consolas,monospace;
  --sans:'IBM Plex Sans KR','Malgun Gothic','Apple SD Gothic Neo',system-ui,sans-serif;
  --serif:'Nanum Myeongjo','Batang','Apple SD Gothic Neo',serif;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#14161A; --surface:#1B1E23; --surface-2:#22262C; --line:#2E333A; --line-soft:#262A30;
  --ink:#E8E6E1; --ink-2:#B2AFA8; --ink-3:#807D76;
  --accent:#E06A5E; --accent-soft:#3A2523; --accent-ink:#F0968C; --link:#7FAADC;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);
}}
:root[data-theme="dark"]{
  --bg:#14161A; --surface:#1B1E23; --surface-2:#22262C; --line:#2E333A; --line-soft:#262A30;
  --ink:#E8E6E1; --ink-2:#B2AFA8; --ink-3:#807D76;
  --accent:#E06A5E; --accent-soft:#3A2523; --accent-ink:#F0968C; --link:#7FAADC;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.6;
  -webkit-font-smoothing:antialiased;display:flex;flex-direction:column;height:100vh;overflow:hidden}
a{color:var(--link);text-decoration:none} a:hover{text-decoration:underline}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}

header.top{flex:0 0 auto;display:flex;align-items:baseline;gap:16px;padding:13px 22px;
  border-bottom:1px solid var(--line);background:var(--bg);flex-wrap:wrap}
.brand{font-family:var(--serif);font-weight:800;font-size:19px;margin:0;letter-spacing:-.01em}
.brand small{font-family:var(--sans);font-weight:400;font-size:12px;color:var(--ink-3);margin-left:9px}
.topnav{margin-left:auto;display:flex;gap:8px;align-items:center}
.topnav a,.themebtn{border:1px solid var(--line);border-radius:999px;padding:4px 12px;font-size:12px;color:var(--ink-2)}
.topnav a:hover,.themebtn:hover{border-color:var(--ink-3);text-decoration:none;color:var(--ink)}

main{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:274px minmax(0,1fr)}
nav.rail,article{min-width:0}
nav.rail{border-right:1px solid var(--line);overflow-y:auto;padding:14px 0 60px;min-height:0}
.railhead{font-size:10px;letter-spacing:.12em;color:var(--ink-3);padding:10px 18px 6px;text-transform:uppercase}
.dbtn{display:block;width:100%;text-align:left;padding:9px 18px;border-left:3px solid transparent}
.dbtn:hover{background:var(--surface-2)}
.dbtn.on{background:var(--accent-soft);border-left-color:var(--accent)}
.dbtn b{display:block;font-family:var(--serif);font-weight:700;font-size:14.5px;color:var(--ink)}
.dbtn.on b{color:var(--accent-ink)}
.dbtn span{display:block;font-size:11.5px;color:var(--ink-3);margin-top:2px;line-height:1.45}
.toc{padding:2px 0 10px}
.toc a{display:block;padding:3px 18px 3px 22px;font-size:12.5px;color:var(--ink-2);line-height:1.4;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toc a.l1{font-weight:600;color:var(--ink);margin-top:5px}
.toc a.l3{padding-left:34px;font-size:12px;color:var(--ink-3)}
.toc a:hover{background:var(--surface-2);color:var(--ink);text-decoration:none}
.toc a.here{color:var(--accent-ink);font-weight:500}

article{overflow-y:auto;min-height:0}
.doc{display:none;max-width:760px;margin:0 auto;padding:44px 34px 120px}
.doc.on{display:block}
.doc h1{font-family:var(--serif);font-weight:800;font-size:30px;line-height:1.3;letter-spacing:-.015em;
  margin:0 0 26px;text-wrap:balance;padding-bottom:18px;border-bottom:1px solid var(--line)}
.doc h2{font-family:var(--serif);font-weight:800;font-size:22px;line-height:1.35;margin:52px 0 16px;
  text-wrap:balance;scroll-margin-top:20px}
.doc h3{font-family:var(--sans);font-weight:600;font-size:16.5px;margin:34px 0 12px;color:var(--ink);
  scroll-margin-top:20px}
.doc h4{font-size:14.5px;font-weight:600;margin:22px 0 8px;color:var(--ink-2)}
.doc p{margin:0 0 15px}
.doc strong{font-weight:600}
.doc ul,.doc ol{margin:0 0 16px;padding-left:22px}
.doc li{margin-bottom:6px}
.doc li::marker{color:var(--ink-3)}
.doc hr{border:0;border-top:1px solid var(--line);margin:40px 0}
.doc blockquote{margin:0 0 20px;padding:13px 17px;background:var(--surface-2);border-left:3px solid var(--accent);
  border-radius:0 6px 6px 0;font-size:14px;color:var(--ink-2);line-height:1.75}
.doc code{font-family:var(--mono);font-size:.87em;background:var(--surface-2);padding:1px 5px;border-radius:4px;
  overflow-wrap:anywhere}
.doc p,.doc li,.doc td{overflow-wrap:anywhere}
.doc pre{background:var(--surface-2);border:1px solid var(--line-soft);border-radius:7px;padding:14px 16px;
  overflow-x:auto;margin:0 0 20px}
.doc pre code{background:none;padding:0;font-size:12.5px;line-height:1.65;white-space:pre}
.tw{overflow-x:auto;margin:0 0 22px;border:1px solid var(--line);border-radius:8px}
.doc table{border-collapse:collapse;width:100%;font-size:13.5px}
.doc th{background:var(--surface-2);font-weight:600;font-size:12px;letter-spacing:.02em;color:var(--ink-2);
  padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
.doc td{padding:9px 12px;border-bottom:1px solid var(--line-soft);vertical-align:top;
  font-variant-numeric:tabular-nums}
.doc tbody tr:last-child td{border-bottom:0}
.doc tbody tr:hover td{background:var(--surface-2)}
.doc em{font-style:normal;color:var(--ink-3)}

@media (max-width:900px){
  main{grid-template-columns:minmax(0,1fr)}
  .dbtn b,.dbtn span{overflow-wrap:anywhere}
  body{height:auto;overflow:visible}
  nav.rail{border-right:0;border-bottom:1px solid var(--line);padding-bottom:10px}
  .toc{display:none}
  article{overflow:visible}
  .doc{padding:28px 20px 80px}
  .doc h1{font-size:25px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
"""

JS = r"""
(function(){
var docs=Array.prototype.slice.call(document.querySelectorAll('.doc'));
var btns=Array.prototype.slice.call(document.querySelectorAll('.dbtn'));
var art=document.querySelector('article');
function show(id,anchor){
  docs.forEach(function(d){d.classList.toggle('on', d.id==='doc-'+id)});
  btns.forEach(function(b){b.classList.toggle('on', b.dataset.doc===id)});
  document.querySelectorAll('.toc').forEach(function(t){t.hidden = t.dataset.doc!==id});
  try{localStorage.setItem('nb_doc',id)}catch(e){}
  if(anchor){var el=document.getElementById(anchor); if(el){el.scrollIntoView(); return;}}
  art.scrollTop=0;
}
btns.forEach(function(b){b.onclick=function(){show(b.dataset.doc); history.replaceState(null,'','#'+b.dataset.doc)}});
document.querySelectorAll('.toc a').forEach(function(a){
  a.onclick=function(e){e.preventDefault();var id=a.dataset.doc,h=a.getAttribute('href').slice(1);
    show(id,h); history.replaceState(null,'','#'+h)}});
document.getElementById('themebtn').onclick=function(){
  var cur=document.documentElement.getAttribute('data-theme');
  var dark=window.matchMedia('(prefers-color-scheme:dark)').matches;
  var next=cur?(cur==='dark'?'light':'dark'):(dark?'light':'dark');
  document.documentElement.setAttribute('data-theme',next);
  try{localStorage.setItem('nb_theme',next)}catch(e){}};
try{var st=localStorage.getItem('nb_theme'); if(st) document.documentElement.setAttribute('data-theme',st);}catch(e){}
// 스크롤 위치에 따라 TOC 강조
var heads=[];
function idxHeads(){var a=Array.prototype.slice.call(document.querySelectorAll('.doc.on h1,.doc.on h2,.doc.on h3'));heads=a.slice(1)}
art.addEventListener('scroll',function(){
  if(!heads.length) idxHeads();
  var top=art.scrollTop+90, cur=null;
  heads.forEach(function(h){ if(h.offsetTop<=top) cur=h.id; });
  document.querySelectorAll('.toc a').forEach(function(a){
    a.classList.toggle('here', a.getAttribute('href')==='#'+cur)});
},{passive:true});
// 진입
var h=location.hash.slice(1), start=null;
if(h){ var b=btns.filter(function(x){return x.dataset.doc===h})[0];
  if(b) start=[h,null];
  else { var a=document.querySelector('.toc a[href="#'+CSS.escape(h)+'"]'); if(a) start=[a.dataset.doc,h]; } }
if(!start){ var s=null; try{s=localStorage.getItem('nb_doc')}catch(e){}
  start=[(s&&docs.some(function(d){return d.id==='doc-'+s}))?s:btns[0].dataset.doc,null]; }
show(start[0],start[1]); idxHeads();
})();
"""

def build(out_path, dash_href, standalone, note_href='내생각.html'):
    parts_nav, parts_doc = [], []
    for key, title, fn, desc in DOCS:
        html, toc = convert(io.open(os.path.join(ROOT, fn), encoding='utf-8').read())
        parts_nav.append(
            f'<button class="dbtn" data-doc="{key}"><b>{title}</b><span>{desc}</span></button>'
            + f'<div class="toc" data-doc="{key}" hidden>'
            + ''.join(f'<a class="l{lv}" data-doc="{key}" href="#{sid}">{t}</a>'
                      for j, (lv, t, sid) in enumerate(toc) if j > 0)
            + '</div>')
        parts_doc.append(f'<section class="doc" id="doc-{key}">{html}</section>')
    head = ('<title>선배님의 20년 — 정리</title>\n'
            '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
            '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
            '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@400;700;800'
            '&family=IBM+Plex+Sans+KR:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">\n'
            f'<style>{CSS}</style>')
    body = (f'<header class="top"><h1 class="brand">선배님의 20년<small>정리 문서</small></h1>'
            f'<div class="topnav"><a href="{note_href}">✍ 내 생각 노트</a>'
            f'<a href="{dash_href}">← 아카이브 대시보드</a>'
            f'<button class="themebtn" id="themebtn">테마</button></div></header>'
            f'<main><nav class="rail"><div class="railhead">문서</div>{"".join(parts_nav)}</nav>'
            f'<article>{"".join(parts_doc)}</article></main>'
            f'<script>{JS}</script>')
    page = head + '\n' + body
    if standalone:
        page = ('<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
                + head + '\n</head>\n<body>\n' + body + '\n</body>\n</html>\n')
    io.open(out_path, 'w', encoding='utf-8').write(page)
    return len(page.encode('utf-8'))

if __name__ == '__main__':
    a = build(os.path.join(ROOT, '정리.html'), '대시보드.html', True)
    b = build(os.path.join(ROOT, '_수집원본', 'artifact_docs.html'),
              'https://claude.ai/code/artifact/642ad21c-4fae-414b-a10d-f7a3c0d24ebe', False,
              'https://claude.ai/code/artifact/ceced558-7a8d-4fc2-aa9c-b3aa25882b56')
    print(f'정리.html {a/1024:.0f} KB / 아티팩트판 {b/1024:.0f} KB')
