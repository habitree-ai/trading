(function(){
var docs=Array.prototype.slice.call(document.querySelectorAll('.doc'));
var btns=Array.prototype.slice.call(document.querySelectorAll('.dbtn'));
var art=document.getElementById('art');
var ss=function(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v)}catch(e){return null}};
function show(id,anchor){
  docs.forEach(function(d){d.classList.toggle('on', d.id==='doc-'+id)});
  btns.forEach(function(b){b.classList.toggle('on', b.dataset.doc===id)});
  document.querySelectorAll('.toc').forEach(function(t){t.hidden = t.dataset.doc!==id});
  ss('nb_doc',id);
  if(anchor){var el=document.getElementById(anchor); if(el){el.scrollIntoView(); heads=[]; return}}
  art.scrollTop=0; window.scrollTo(0,0); heads=[];
}
btns.forEach(function(b){b.onclick=function(){show(b.dataset.doc); history.replaceState(null,'','#'+b.dataset.doc)}});
document.querySelectorAll('.toc a').forEach(function(a){
  a.onclick=function(e){e.preventDefault(); var id=a.dataset.doc, h=a.getAttribute('href').slice(1);
    show(id,h); history.replaceState(null,'','#'+h)}});
document.addEventListener('click',function(e){
  if(!e.target.closest('#themebtn')) return;
  var c=document.documentElement.getAttribute('data-theme');
  var dk=window.matchMedia('(prefers-color-scheme:dark)').matches;
  var nx=c?(c==='dark'?'light':'dark'):(dk?'light':'dark');
  document.documentElement.setAttribute('data-theme',nx); ss('nb_theme',nx);
});
var t=ss('nb_theme'); if(t) document.documentElement.setAttribute('data-theme',t);
var heads=[];
function idxHeads(){var a=Array.prototype.slice.call(document.querySelectorAll('.doc.on h1,.doc.on h2,.doc.on h3'));heads=a.slice(1)}
art.addEventListener('scroll',function(){
  if(!heads.length) idxHeads();
  var top=art.scrollTop+90, cur=null;
  heads.forEach(function(h){ if(h.offsetTop<=top) cur=h.id });
  document.querySelectorAll('.toc a').forEach(function(a){
    a.classList.toggle('here', a.getAttribute('href')==='#'+cur)});
},{passive:true});
var h=location.hash.slice(1), start=null;
if(h){ var b=btns.filter(function(x){return x.dataset.doc===h})[0];
  if(b) start=[h,null];
  else { try{ var a=document.querySelector('.toc a[href="#'+CSS.escape(h)+'"]'); if(a) start=[a.dataset.doc,h] }catch(e){} } }
if(!start){ var s=ss('nb_doc');
  start=[(s&&docs.some(function(d){return d.id==='doc-'+s}))?s:btns[0].dataset.doc,null] }
show(start[0],start[1]); idxHeads();
})();
