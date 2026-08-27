(function(){
"use strict";
var $=function(s,r){return (r||document).querySelector(s)};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
  return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]})};
var POSTS=JSON.parse($('#posts').textContent);
var NOTES=JSON.parse($('#notes').textContent);
var CFG=JSON.parse($('#cfg').textContent);
var PMAP={}; POSTS.forEach(function(p){PMAP[p.i]=p});
var LS='nb_thoughts_v1', SS='nb_draft_v1';
var artifactNS=null, dlNS=null, resolved=false, localMode=false;
var cur=null, dirty=false, filter={q:'',st:'all'}, SHELL='';

var FIELDS=[
 {k:'quote',cls:'quote',label:'인용 — 걸린 대목',rows:6,
  hint:'원문에서 마음에 걸린 문장을 그대로 옮겨 둡니다. 나중에 다시 열었을 때 여기서 다시 출발하게 됩니다.',
  ph:'원문에서 옮겨 붙이세요.'},
 {k:'think',label:'내 생각',rows:11,
  hint:'동의하든 아니든 내 언어로. 요약이 아니라 반응을 적습니다.',
  ph:'이 대목이 왜 걸렸는가.\n내 경험 중 어디에 닿는가.\n저자가 말하지 않은 것은 무엇인가.'},
 {k:'apply',label:'나에게 적용하면',rows:6,
  hint:'내 계좌·내 상황에서 무엇을 바꿀 것인가. 숫자로 적을 수 있으면 숫자로.',
  ph:'바꿀 것 하나.\n그 판단의 기준선(숫자).\n언제 점검할 것인가.'},
 {k:'differ',label:'다른 점 · 동의하지 않는 부분',rows:6,
  hint:'그대로 따라 하면 안 되는 이유를 먼저 적어둡니다. 이 칸이 비어 있으면 대개 아직 소화가 안 된 것입니다.',
  ph:'내 조건이 저자와 다른 지점.\n저자의 전제 중 나에게 성립하지 않는 것.'},
 {k:'ask',label:'남는 질문',rows:5,
  hint:'답을 못 찾은 것. 다음에 확인할 것.',
  ph:'아직 모르겠는 것.'}
];

function uid(){return 'n'+Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36)}
function today(){var d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function toast(m){var t=$('#toast');t.textContent=m;t.classList.add('on');clearTimeout(t._t);t._t=setTimeout(function(){t.classList.remove('on')},2600)}
function saveLocal(){try{localStorage.setItem(LS,JSON.stringify(NOTES))}catch(e){}}
function stash(){try{sessionStorage.setItem(SS,JSON.stringify({cur:cur}))}catch(e){}}
function noteById(id){for(var i=0;i<NOTES.length;i++) if(NOTES[i].id===id) return NOTES[i]; return null}
function jsonSafe(o){return JSON.stringify(o).replace(/</g,'\\u003c')}

function buildDoc(){
  var css=$('#css').textContent, app=$('#appsrc').textContent, cfg=$('#cfg').textContent;
  var fonts='<link rel="preconnect" href="https://fonts.googleapis.com">'+
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'+
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@400;700;800'+
    '&family=IBM+Plex+Sans+KR:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">';
  return '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n'+
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n'+
    '<title>선배님의 20년 — 내 생각</title>\n'+fonts+'\n<style id="css">'+css+'<\/style>\n</head>\n<body>\n'+
    SHELL+'\n<div id="toast"><\/div>\n'+
    '<script type="application/json" id="cfg">'+cfg.replace(/</g,'\\u003c')+'<\/script>\n'+
    '<script type="application/json" id="posts">'+jsonSafe(POSTS)+'<\/script>\n'+
    '<script type="application/json" id="notes">'+jsonSafe(NOTES)+'<\/script>\n'+
    '<script type="text/plain" id="appsrc">'+app+'<\/script>\n'+
    '<script>'+app+'<\/script>\n</body>\n</html>\n';
}
function setBusy(b){var el=$('#savebtn'); if(el){el.disabled=b; el.textContent=b?'저장 중…':'저장'}}
function persist(){
  var n=noteById(cur); if(n) n.updated=today();
  if(artifactNS){
    stash(); setBusy(true);
    artifactNS.publish(buildDoc()).then(function(){}).catch(function(e){
      setBusy(false);
      var c=e&&e.code;
      if(c==='conflict'){ toast('다른 곳에서 먼저 저장되었습니다. 화면이 갱신됩니다.'); return }
      if(c==='not_writer'||c==='not_granted'||c==='not_declared'){
        localMode=true; artifactNS=null; saveLocal(); dirty=false; render();
        toast('읽기 전용 화면이라 이 브라우저에만 저장했습니다.'); return }
      if(c==='too_large'){ toast('내용이 너무 커서 저장하지 못했습니다.'); return }
      if(c==='rate_limited'){ toast('저장이 너무 잦습니다. 잠시 후 다시 눌러 주세요.'); return }
      toast('저장 실패: '+(e&&e.message||'알 수 없는 오류'));
    });
  } else { saveLocal(); dirty=false; renderSaveBar(); toast('이 브라우저에 저장했습니다'); }
}

function toMD(){
  var L=['# 내 생각 — 선배님 블로그 아카이브','','원문 760편(2006~2026) 기준. 내보낸 날짜: '+today(),'','---',''];
  NOTES.slice().sort(function(a,b){
    var da=PMAP[a.post]?PMAP[a.post].d:'0', db=PMAP[b.post]?PMAP[b.post].d:'0';
    return da<db?-1:da>db?1:0}).forEach(function(n){
    var p=PMAP[n.post];
    L.push('## '+(p?p.t:'(글 미지정)'),'');
    if(p) L.push('- 원문: ['+p.d+' · '+p.c+' · '+p.t+']('+p.u+')');
    L.push('- 상태: '+(n.status==='done'?'정리됨':'초안')+' · 작성 '+(n.created||'')+' · 수정 '+(n.updated||''));
    if(n.tags&&n.tags.length) L.push('- 태그: '+n.tags.map(function(t){return '#'+t}).join(' '));
    if(n.links&&n.links.length){ L.push('- 연결되는 글:');
      n.links.forEach(function(id){var q=PMAP[id]; if(q) L.push('    - ['+q.d+' '+q.t+']('+q.u+')')}) }
    L.push('');
    FIELDS.forEach(function(f){
      var v=(n[f.k]||'').trim(); if(!v) return;
      L.push('### '+f.label.replace(/\s*—.*$/,''),'');
      if(f.k==='quote') v=v.split('\n').map(function(x){return '> '+x}).join('\n');
      L.push(v,'');
    });
    L.push('---','');
  });
  return L.join('\n');
}
function fallbackDL(md,fn){
  try{ var b=new Blob([md],{type:'text/markdown;charset=utf-8'});
    var a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download=fn;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){URL.revokeObjectURL(a.href)},20000); toast('내려받았습니다');
  }catch(e){ toast('내보내기를 지원하지 않는 화면입니다') }
}
function exportMD(){
  var md=toMD(), fn='내생각_'+today()+'.md';
  if(dlNS){ dlNS.save({filename:fn,data:md}).then(function(){toast('저장했습니다')})
    .catch(function(e){ if(e&&e.code==='declined') return; fallbackDL(md,fn) }); return }
  fallbackDL(md,fn);
}
function newNote(){
  NOTES.unshift({id:uid(),post:'',quote:'',think:'',apply:'',differ:'',ask:'',links:[],tags:[],
    status:'draft',created:today(),updated:today()});
  cur=NOTES[0].id; dirty=true; render();
  setTimeout(function(){var el=$('#pickpost'); if(el) el.focus()},60);
}
function delNote(){
  if(!noteById(cur)) return;
  if(!confirm('이 노트를 지웁니다. 되돌릴 수 없습니다.')) return;
  NOTES=NOTES.filter(function(x){return x.id!==cur});
  cur=NOTES.length?sortedNotes()[0].id:null; dirty=true; render(); persist();
}
function sortedNotes(){
  return NOTES.slice().sort(function(a,b){
    var da=PMAP[a.post]?PMAP[a.post].d:'0', db=PMAP[b.post]?PMAP[b.post].d:'0';
    return da<db?1:da>db?-1:0});
}
function visibleNotes(){
  var q=filter.q.toLowerCase();
  return sortedNotes().filter(function(n){
    if(filter.st!=='all' && n.status!==filter.st) return false;
    if(!q) return true;
    var p=PMAP[n.post];
    var hay=[(p?p.t+' '+p.c+' '+p.d:''),n.quote,n.think,n.apply,n.differ,n.ask,(n.tags||[]).join(' ')].join(' ').toLowerCase();
    return hay.indexOf(q)>=0});
}

function renderBadge(){
  var b=$('#mode'); if(!b) return;
  if(!resolved){ b.textContent='연결 확인 중'; b.className='badge'; return }
  if(artifactNS){ b.textContent='저장됨 · 어디서나'; b.className='badge live' }
  else { b.textContent='이 브라우저에만 저장'; b.className='badge' }
}
function renderSaveBar(){ var el=$('#savestate'); if(el) el.textContent=dirty?'저장하지 않은 변경이 있습니다':'' }
function renderList(){
  var v=visibleNotes(), el=$('#nlist');
  if(!v.length){ el.innerHTML='<div class="empty">'+(NOTES.length?'조건에 맞는 노트가 없습니다.':
    '아직 노트가 없습니다.<br>위 <b>새 노트</b>로 시작하세요.')+'</div>'; return }
  el.innerHTML=v.map(function(n){
    var p=PMAP[n.post];
    var snip=(n.think||n.quote||'').replace(/\s+/g,' ').trim().slice(0,90);
    return '<button class="nitem'+(n.id===cur?' on':'')+'" data-id="'+n.id+'"><div class="nmeta">'+
      (p?'<span class="ndate">'+p.d+'</span><span class="ncat">'+esc(p.c.split(' > ').pop())+'</span>'
        :'<span class="ndate">미지정</span>')+
      '<span class="nst'+(n.status==='done'?' done':'')+'">'+(n.status==='done'?'정리됨':'초안')+'</span></div>'+
      '<div class="ntitle">'+esc(p?p.t:'(글을 고르세요)')+'</div>'+
      (snip?'<div class="nsnip">'+esc(snip)+'</div>':'')+'</button>'}).join('');
}
function resultsHTML(q,exclude){
  var s=q.trim().toLowerCase(); if(!s) return '';
  var hit=POSTS.filter(function(p){
    if(exclude&&exclude.indexOf(p.i)>=0) return false;
    return (p.t+' '+p.c+' '+p.d).toLowerCase().indexOf(s)>=0}).slice(0,40);
  if(!hit.length) return '<div class="empty" style="padding:18px">검색 결과가 없습니다.</div>';
  return hit.map(function(p){
    return '<button data-pick="'+p.i+'"><span class="rd">'+p.d+'</span> <span class="rc">'+
      esc(p.c.split(' > ').pop())+'</span><div class="rt">'+esc(p.t)+'</div></button>'}).join('');
}
function renderEditor(){
  var pane=$('#pane'), n=noteById(cur);
  if(!n){
    var done=NOTES.filter(function(x){return x.status==='done'}).length, cov={};
    NOTES.forEach(function(x){if(x.post) cov[x.post]=1});
    pane.innerHTML='<div class="wrap"><div class="stat">'+
      '<div><b class="tnum">'+NOTES.length+'</b><span>노트</span></div>'+
      '<div><b class="tnum">'+Object.keys(cov).length+'</b><span>다룬 글</span></div>'+
      '<div><b class="tnum">'+done+'</b><span>정리됨</span></div>'+
      '<div><b class="tnum">760</b><span>전체 글</span></div></div>'+
      '<div class="guide"><b>여기는 원문을 읽는 곳이 아니라, 원문에 내 답을 다는 곳입니다.</b><br>'+
      '글을 하나 고르고 다섯 칸을 채웁니다 — 인용 / 내 생각 / 나에게 적용하면 / 다른 점 / 남는 질문.<br>'+
      '그중 <b>‘다른 점’</b>이 이 노트의 핵심입니다. 그 칸이 비어 있으면 대개 아직 소화되지 않은 것입니다.<br>'+
      '<b>연결되는 글</b>을 걸어 두면 20년치 안에서 같은 이야기가 어떻게 반복되는지 보입니다.</div>'+
      '<div class="empty">왼쪽에서 노트를 고르거나 <b>새 노트</b>를 눌러 시작하세요.</div></div>';
    return }
  var p=PMAP[n.post], h=['<div class="wrap">'];
  h.push('<div class="src"><div class="lbl">대상 글</div>');
  if(p){ h.push('<h2>'+esc(p.t)+'</h2><div class="meta"><span class="chip cat">'+esc(p.c)+
      '</span><span class="chip mono">'+p.d+'</span></div><div class="acts">'+
      '<a class="tbtn" href="'+esc(p.u)+'" target="_blank" rel="noopener">네이버 원문 ↗</a>'+
      '<a class="tbtn" href="'+esc(CFG.dash)+'" target="_blank" rel="noopener">아카이브 대시보드 ↗</a>'+
      '<button class="tbtn" id="changepost">글 바꾸기</button></div>') }
  else { h.push('<div class="pick"><input id="pickpost" type="text" autocomplete="off" '+
      'placeholder="760편에서 글 찾기 — 제목·게시판·날짜"><div class="res" id="pickres" hidden></div></div>') }
  h.push('</div>');
  FIELDS.forEach(function(f){
    h.push('<div class="fld'+(f.cls?' '+f.cls:'')+'"><label for="f_'+f.k+'">'+f.label+'</label>'+
      '<div class="hint">'+f.hint+'</div><textarea id="f_'+f.k+'" data-k="'+f.k+'" rows="'+f.rows+
      '" placeholder="'+esc(f.ph)+'">'+esc(n[f.k]||'')+'</textarea></div>')});
  h.push('<div class="fld"><label>연결되는 글</label><div class="hint">'+
    '같은 이야기가 나오는 다른 글을 걸어 둡니다. 20년치 안에서 반복되는 지점을 찾는 장치입니다.</div>');
  (n.links||[]).forEach(function(id){var q=PMAP[id]; if(!q) return;
    h.push('<div class="linkrow"><span class="ld">'+q.d+'</span><span class="lt">'+esc(q.t)+'</span>'+
      '<a class="ld" href="'+esc(q.u)+'" target="_blank" rel="noopener">↗</a>'+
      '<button class="x" data-unlink="'+id+'" title="빼기">×</button></div>')});
  h.push('<div class="pick"><input id="picklink" type="text" autocomplete="off" placeholder="글 검색해서 추가">'+
    '<div class="res" id="linkres" hidden></div></div></div>');
  h.push('<div class="fld"><label for="f_tags">태그</label><div class="hint">'+
    '쉼표로 구분. 나중에 주제별로 모아 볼 때 씁니다.</div>'+
    '<input id="f_tags" type="text" placeholder="레버리지, 손절, 심리" value="'+esc((n.tags||[]).join(', '))+'">'+
    '<div class="tags">'+(n.tags||[]).map(function(t){return '<span class="tag">#'+esc(t)+'</span>'}).join('')+
    '</div></div>');
  h.push('<div class="savebar"><span class="st" id="savestate"></span>'+
    '<button class="tbtn" id="statusbtn">'+(n.status==='done'?'✓ 정리됨':'초안')+'</button>'+
    '<button class="tbtn" id="delbtn">삭제</button>'+
    '<button class="tbtn primary" id="savebtn">저장</button></div></div>');
  pane.innerHTML=h.join(''); renderSaveBar();
}
function render(){renderList();renderEditor();renderBadge()}

document.addEventListener('input',function(e){
  var t=e.target, n=noteById(cur);
  if(t.dataset&&t.dataset.k){ if(n){n[t.dataset.k]=t.value; dirty=true; renderSaveBar()} }
  else if(t.id==='f_tags'){ if(n){n.tags=t.value.split(',').map(function(x){return x.trim()}).filter(Boolean);
    dirty=true; renderSaveBar()} }
  else if(t.id==='nsearch'){ filter.q=t.value; renderList() }
  else if(t.id==='pickpost'){ var r=$('#pickres'); r.innerHTML=resultsHTML(t.value); r.hidden=!t.value.trim() }
  else if(t.id==='picklink'){ var r2=$('#linkres');
    r2.innerHTML=resultsHTML(t.value,((n&&n.links)||[]).concat(n&&n.post?[n.post]:[]));
    r2.hidden=!t.value.trim() }
});
document.addEventListener('click',function(e){
  var b, n;
  if(b=e.target.closest('.nitem')){ cur=b.dataset.id; render(); return }
  if(b=e.target.closest('[data-pick]')){ n=noteById(cur); if(!n) return;
    if(e.target.closest('#linkres')){ n.links=n.links||[];
      if(n.links.indexOf(b.dataset.pick)<0) n.links.push(b.dataset.pick) }
    else { n.post=b.dataset.pick }
    dirty=true; render(); return }
  if(b=e.target.closest('[data-unlink]')){ n=noteById(cur);
    if(n) n.links=(n.links||[]).filter(function(x){return x!==b.dataset.unlink});
    dirty=true; render(); return }
  if(e.target.closest('#changepost')){ n=noteById(cur); if(n){n.post=''; dirty=true; render()} return }
  if(e.target.closest('#newbtn')){ newNote(); return }
  if(e.target.closest('#savebtn')){ persist(); return }
  if(e.target.closest('#delbtn')){ delNote(); return }
  if(e.target.closest('#exportbtn')){ exportMD(); return }
  if(e.target.closest('#statusbtn')){ n=noteById(cur);
    if(n){n.status=n.status==='done'?'draft':'done'; dirty=true; render()} return }
  if(b=e.target.closest('.fbtn')){ filter.st=b.dataset.st;
    Array.prototype.forEach.call(document.querySelectorAll('.fbtn'),function(x){
      x.classList.toggle('on',x.dataset.st===filter.st)});
    renderList(); return }
  if(e.target.closest('#themebtn')){
    var c=document.documentElement.getAttribute('data-theme');
    var dk=window.matchMedia('(prefers-color-scheme:dark)').matches;
    var nx=c?(c==='dark'?'light':'dark'):(dk?'light':'dark');
    document.documentElement.setAttribute('data-theme',nx);
    try{localStorage.setItem('nb_theme',nx)}catch(err){} return }
  if(!e.target.closest('.pick')){
    var a=$('#pickres'), c2=$('#linkres'); if(a)a.hidden=true; if(c2)c2.hidden=true }
});
document.addEventListener('keydown',function(e){
  if((e.ctrlKey||e.metaKey)&&(e.key==='s'||e.key==='S')){e.preventDefault(); if(noteById(cur)) persist()}
});
window.addEventListener('beforeunload',function(e){ if(dirty){e.preventDefault(); e.returnValue=''} });

SHELL=$('#shell').outerHTML;
try{var th=localStorage.getItem('nb_theme'); if(th) document.documentElement.setAttribute('data-theme',th)}catch(e){}
try{var s=sessionStorage.getItem(SS); if(s){var d=JSON.parse(s); sessionStorage.removeItem(SS);
  if(d&&d.cur) cur=d.cur}}catch(e){}
if(!cur&&NOTES.length) cur=sortedNotes()[0].id;
render();
function goLocal(){
  localMode=true; resolved=true;
  var lv=null; try{lv=localStorage.getItem(LS)}catch(e){}
  if(lv){ try{ var arr=JSON.parse(lv);
    if(arr&&arr.length){ NOTES=arr; if(!noteById(cur)) cur=NOTES.length?sortedNotes()[0].id:null } }catch(e){} }
  render();
}
if(window.claude&&window.claude.use){
  window.claude.use('artifact').then(function(a){
    artifactNS=a; resolved=true;
    if(!a) goLocal(); else renderBadge();
  }).catch(function(){goLocal()});
  window.claude.use('downloads').then(function(d){dlNS=d}).catch(function(){});
  setTimeout(function(){ if(!resolved) goLocal() },11000);
} else { goLocal() }
})();
