(function(){
"use strict";
var D=window.BLOG_DATA, P=D.posts, C=D.cats, M=D.meta, CFG=window.NBCFG||{};
var HAS_IMG=!!CFG.hasImg, EXCERPT=!!CFG.excerpt, PER=30;
var $=function(s){return document.querySelector(s)};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
  return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]})};
var nf=function(n){return n.toLocaleString('ko-KR')};
var ss=function(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v)}catch(e){return null}};

var st={cat:'',year:'',q:'',page:1,sort:'new',view:'list',post:null};

/* ---- 블로그 헤더 숫자 ---- */
$('#nums').innerHTML=[['<b class="tnum">'+nf(M.total)+'</b><span>편</span>'],
  ['<b class="tnum">'+nf(Math.round(M.chars/10000))+'</b><span>만 자</span>'],
  ['<b class="tnum">'+nf(M.images)+'</b><span>장</span>'],
  ['<b class="tnum">'+M.from.slice(0,4)+'–'+M.to.slice(0,4)+'</b><span>년</span>']]
  .map(function(x){return '<div>'+x+'</div>'}).join('');

/* ---- 사이드바: 게시판 + 연도 ---- */
var years=(function(){var m={};M.years.forEach(function(y){m[y[0]]=y[1]});
  var a=[];for(var y=+M.to.slice(0,4);y>=+M.from.slice(0,4);y--) if(m[String(y)]) a.push([String(y),m[String(y)]]);
  return a})();
function renderCats(){
  var h='<div class="cgroup">게시판</div>';
  h+='<button class="crow all'+(st.cat===''?' on':'')+'" data-c=""><u>전체보기</u><b class="tnum">'+M.total+'</b></button>';
  C.forEach(function(c){
    var sub=c.path.indexOf(' > ')>-1;
    h+='<button class="crow'+(sub?' sub':'')+(st.cat===c.path?' on':'')+'" data-c="'+esc(c.path)+'">'+
       '<u>'+esc(sub?c.path.split(' > ').pop():c.name)+'</u><b class="tnum">'+c.n+'</b></button>';
  });
  h+='<div class="cgroup">연도</div>';
  h+='<button class="crow all'+(st.year===''?' on':'')+'" data-y=""><u>전체 기간</u><b class="tnum">'+M.total+'</b></button>';
  years.forEach(function(y){
    h+='<button class="crow'+(st.year===y[0]?' on':'')+'" data-y="'+y[0]+'"><u>'+y[0]+'년</u>'+
       '<b class="tnum">'+y[1]+'</b></button>'});
  $('#cats').innerHTML=h;
}

/* ---- 목록 ---- */
function match(p){
  if(st.cat && p.c!==st.cat) return false;
  if(st.year && p.d.slice(0,4)!==st.year) return false;
  if(st.q){var s=st.q.toLowerCase(); if(p.t.toLowerCase().indexOf(s)<0 && p.b.toLowerCase().indexOf(s)<0) return false}
  return true;
}
function view(){
  var v=P.filter(match);
  v.sort(function(a,b){return st.sort==='new'?(a.d<b.d?1:a.d>b.d?-1:0):(a.d<b.d?-1:a.d>b.d?1:0)});
  return v;
}
function snip(p){
  var b=p.b.replace(/\s+/g,' ').trim();
  if(st.q){var i=b.toLowerCase().indexOf(st.q.toLowerCase()); if(i>50) b='…'+b.slice(i-40)}
  return b.slice(0,150);
}
function pagerHTML(total,page){
  var last=Math.max(1,Math.ceil(total/PER)); if(last<2) return '';
  var h='<div class="pager">';
  h+='<button data-p="'+(page-1)+'"'+(page<=1?' disabled':'')+'>‹ 이전</button>';
  var s=Math.max(1,page-4), e=Math.min(last,s+9); s=Math.max(1,e-9);
  if(s>1){h+='<button data-p="1">1</button>'; if(s>2) h+='<span class="gap">…</span>'}
  for(var i=s;i<=e;i++) h+='<button data-p="'+i+'"'+(i===page?' class="on"':'')+'>'+i+'</button>';
  if(e<last){ if(e<last-1) h+='<span class="gap">…</span>'; h+='<button data-p="'+last+'">'+last+'</button>'}
  h+='<button data-p="'+(page+1)+'"'+(page>=last?' disabled':'')+'>다음 ›</button></div>';
  return h;
}
function renderList(){
  var v=view(), last=Math.max(1,Math.ceil(v.length/PER));
  if(st.page>last) st.page=last;
  var slice=v.slice((st.page-1)*PER, st.page*PER);
  var title=st.cat||'전체보기', extra=st.year?(' · '+st.year+'년'):'';
  var h='<div class="listwrap"><div class="lhead"><h2>'+esc(title)+esc(extra)+'</h2>'+
    '<span class="cnt">글 '+nf(v.length)+'개</span><div class="tools">'+
    '<button data-sort="new"'+(st.sort==='new'?' class="on"':'')+'>최신순</button>'+
    '<button data-sort="old"'+(st.sort==='old'?' class="on"':'')+'>오래된순</button>'+
    '<button data-view="list"'+(st.view==='list'?' class="on"':'')+'>목록형</button>'+
    '<button data-view="card"'+(st.view==='card'?' class="on"':'')+'>요약형</button>'+
    '</div></div><div class="srch"><input id="q" type="search" placeholder="제목·본문 검색   ( / )" '+
    'autocomplete="off" value="'+esc(st.q)+'"></div>';
  if(!slice.length){ h+='<div class="none">해당하는 글이 없습니다.</div></div>'; $('#body').innerHTML=h; return }
  if(st.view==='list'){
    h+='<div class="rows">'+slice.map(function(p){
      return '<button class="prow" data-id="'+p.id+'">'+
        '<span class="t">'+esc(p.t)+'</span>'+
        (st.cat?'':'<span class="c">'+esc(p.c.split(' > ').pop())+'</span>')+
        (p.m.length?'<span class="ic">◨'+p.m.length+'</span>':'')+
        (p.x?'<span class="x">✕'+p.x+'</span>':'')+
        '<span class="d">'+p.d+'</span></button>'}).join('')+'</div>';
  } else {
    h+='<div class="cards">'+slice.map(function(p){
      return '<button class="pcard" data-id="'+p.id+'"><div class="ph">'+
        '<span class="c">'+esc(p.c.split(' > ').pop())+'</span>'+
        (p.m.length?'<span class="d">◨ '+p.m.length+'</span>':'')+
        '<span class="d">'+p.d+'</span></div>'+
        '<h3>'+esc(p.t)+'</h3>'+(p.b?'<p>'+esc(snip(p))+'</p>':'')+'</button>'}).join('')+'</div>';
  }
  h+=pagerHTML(v.length,st.page)+'</div>';
  $('#body').innerHTML=h;
}

/* ---- 포스트 ---- */
function renderPost(){
  var p=null; for(var i=0;i<P.length;i++) if(P[i].id===st.post){p=P[i];break}
  if(!p){st.post=null;renderList();return}
  var sib=view(), ix=-1; for(var j=0;j<sib.length;j++) if(sib[j].id===p.id){ix=j;break}
  var prev=ix>0?sib[ix-1]:null, next=ix>=0&&ix<sib.length-1?sib[ix+1]:null;
  var imgs='';
  if(HAS_IMG&&p.m.length) imgs='<div class="pimgs">'+p.m.map(function(f){
    return '<img loading="lazy" src="이미지/'+encodeURI(f).replace(/#/g,'%23')+'" alt="">'}).join('')+'</div>';
  else if(p.m.length) imgs='<div class="pimgs"><div class="pnote">이미지 '+p.m.length+
    '장은 로컬 아카이브(선배님\\이미지)에 있습니다. 원문에서도 볼 수 있습니다.</div></div>';
  var body=p.b?esc(p.b):'<span class="pnote" style="display:block">본문 텍스트가 없는 글입니다. '+
    '2007~2009년 매매일지는 차트 이미지로만 작성되어, 내용이 이미지에 담겨 있습니다.</span>';
  if(EXCERPT&&p.b&&p.n>p.b.length) body=esc(p.b)+
    '<span style="color:var(--ink-3)">…  (전문은 로컬 아카이브 또는 원문에서)</span>';
  var h='<div class="postwrap"><button class="back" id="back">← 목록으로</button>'+
    '<div class="pcrumb">'+esc(p.c)+'</div><h2 class="ptitle">'+esc(p.t)+'</h2>'+
    '<div class="pmeta"><span class="chip mono">'+p.d+'</span>'+
    (p.n?'<span class="chip mono">'+nf(p.n)+'자</span>':'')+
    (p.m.length?'<span class="chip mono">이미지 '+p.m.length+'</span>':'')+
    (p.x?'<span class="chip warn mono">원본 소실 '+p.x+'</span>':'')+'</div>'+
    '<div class="pbody">'+body+'</div>'+imgs+
    (p.g.length?'<div class="ptags">'+p.g.map(function(g){return '<span>#'+esc(g)+'</span>'}).join('')+'</div>':'')+
    '<div class="porig"><a href="'+esc(p.u)+'" target="_blank" rel="noopener">네이버 원문으로 열기 ↗</a></div>'+
    '<div class="pnav">'+
      '<button data-go="'+(prev?prev.id:'')+'"'+(prev?'':' disabled')+'><span class="lb">이전 글</span>'+
        '<span class="tt">'+esc(prev?prev.t:'없음')+'</span><span class="dd">'+(prev?prev.d:'')+'</span></button>'+
      '<button data-go="'+(next?next.id:'')+'"'+(next?'':' disabled')+'><span class="lb">다음 글</span>'+
        '<span class="tt">'+esc(next?next.t:'없음')+'</span><span class="dd">'+(next?next.d:'')+'</span></button>'+
    '</div></div>';
  $('#body').innerHTML=h; $('#body').scrollTop=0; window.scrollTo(0,0);
}
function render(){ renderCats(); if(st.post) renderPost(); else renderList() }

/* ---- 이벤트 ---- */
document.addEventListener('click',function(e){
  var b;
  if(b=e.target.closest('[data-c]')){ st.cat=b.dataset.c; st.page=1; st.post=null; ss('nb_cat',st.cat); render(); return }
  if(b=e.target.closest('[data-y]')){ st.year=b.dataset.y; st.page=1; st.post=null; render(); return }
  if(b=e.target.closest('[data-sort]')){ st.sort=b.dataset.sort; st.page=1; ss('nb_sort',st.sort); render(); return }
  if(b=e.target.closest('[data-view]')){ st.view=b.dataset.view; ss('nb_view',st.view); render(); return }
  if(b=e.target.closest('[data-p]')){ st.page=+b.dataset.p; renderList(); $('#body').scrollTop=0; window.scrollTo(0,0); return }
  if(b=e.target.closest('[data-id]')){ st.post=b.dataset.id; renderPost(); return }
  if(b=e.target.closest('[data-go]')){ if(b.dataset.go){ st.post=b.dataset.go; renderPost() } return }
  if(e.target.closest('#back')){ st.post=null; renderList(); return }
  if(e.target.closest('#themebtn')){
    var c=document.documentElement.getAttribute('data-theme');
    var dk=window.matchMedia('(prefers-color-scheme:dark)').matches;
    var nx=c?(c==='dark'?'light':'dark'):(dk?'light':'dark');
    document.documentElement.setAttribute('data-theme',nx); ss('nb_theme',nx); return }
});
var tm; document.addEventListener('input',function(e){
  if(e.target.id!=='q') return; var v=e.target.value;
  clearTimeout(tm); tm=setTimeout(function(){ st.q=v.trim(); st.page=1; st.post=null; renderList();
    var el=$('#q'); if(el){el.focus(); el.setSelectionRange(el.value.length,el.value.length)} },200);
});
document.addEventListener('keydown',function(e){
  if(e.target.tagName==='INPUT'){ if(e.key==='Escape') e.target.blur(); return }
  if(e.key==='/'){ e.preventDefault(); var el=$('#q'); if(el) el.focus(); return }
  if(e.key==='Escape'&&st.post){ st.post=null; renderList(); return }
  if(st.post&&(e.key==='j'||e.key==='k')){
    var sib=view(), ix=-1; for(var i=0;i<sib.length;i++) if(sib[i].id===st.post){ix=i;break}
    var n=e.key==='j'?ix+1:ix-1; if(n>=0&&n<sib.length){ st.post=sib[n].id; renderPost() } }
});
var t0=ss('nb_theme'); if(t0) document.documentElement.setAttribute('data-theme',t0);
var c0=ss('nb_cat'); if(c0&&C.some(function(c){return c.path===c0})) st.cat=c0;
var s0=ss('nb_sort'); if(s0==='old'||s0==='new') st.sort=s0;
var v0=ss('nb_view'); if(v0==='card'||v0==='list') st.view=v0;
render();
})();
