/* 시세 대조 차트 앱 — make_chart.py 가 페이지에 인라인한다. 모든 차트 페이지가 이 한 파일을 쓴다.
   데이터(DATA)는 페이지의 <script id="data"> JSON. 지표는 여기서 계산하므로 기간·종류를 바꿔도 재생성이 필요 없다.
   시간대: 15m·1h 는 야후 원봉, 4h 는 1h 를 UTC 4시간 단위로, 1w 는 일봉을 월요일 시작 주 단위로 합성한다. */
(function () {
  var DATA = JSON.parse(document.getElementById('data').textContent);
  var LWC = window.LightweightCharts;
  var $ = function (id) { return document.getElementById(id); };
  var pl = $('postlink'); pl.href = DATA.post.url; pl.textContent = '「' + DATA.post.title + '」 ' + DATA.post.date + ' · ' + DATA.post.board;
  if (!LWC) { $('main').innerHTML = '<p style="padding:20px">차트 라이브러리를 불러오지 못했습니다(인터넷 연결 필요). 아래 표와 CSV 는 그대로 볼 수 있습니다.</p>'; return; }

  // ---------- 상태 (localStorage) ----------
  var KEY = 'sbchart:' + DATA.name;
  var DEFAULT_IND = DATA.indicators || { ma: [{ type: 'SMA', n: 20 }, { type: 'SMA', n: 50 }, { type: 'SMA', n: 200 }], bb: { on: false, n: 20, k: 2 }, rsi: { on: true, n: 14 }, volume: true, vx: true };
  var MA_COLORS = ['#f5a623', '#2962ff', '#9c27b0', '#00bcd4', '#8bc34a', '#ff5722'];
  var state = { tf: null, ind: JSON.parse(JSON.stringify(DEFAULT_IND)), log: false, theme: null };
  try { var s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s) { if (s.ind) state.ind = s.ind; if (s.tf) state.tf = s.tf; if (s.log) state.log = s.log; if (s.theme) state.theme = s.theme; } } catch (e) {}
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }

  // ---------- 테마 ----------
  var root = document.documentElement;
  if (state.theme === 'dark' || (!state.theme && matchMedia('(prefers-color-scheme: dark)').matches)) root.setAttribute('data-theme', 'dark');
  function dark() { return root.getAttribute('data-theme') === 'dark'; }
  function layout() {
    return { layout: { background: { type: 'solid', color: dark() ? '#131722' : '#fbfaf7' }, textColor: dark() ? '#d1d4dc' : '#1f1d1a' },
             grid: { vertLines: { color: dark() ? '#1f2431' : '#eeebe4' }, horzLines: { color: dark() ? '#1f2431' : '#eeebe4' } },
             crosshair: { mode: LWC.CrosshairMode.Normal },
             rightPriceScale: { borderColor: dark() ? '#2a2e39' : '#e4e0d8', mode: state.log ? LWC.PriceScaleMode.Logarithmic : LWC.PriceScaleMode.Normal },
             timeScale: { borderColor: dark() ? '#2a2e39' : '#e4e0d8', rightOffset: 6, barSpacing: 8 } };
  }

  // ---------- 시각 ----------
  var PD = DATA.pdec;
  function n(x, p) { return x == null ? '–' : x.toLocaleString('ko-KR', { minimumFractionDigits: p, maximumFractionDigits: p }); }
  function fmt(tz, ms, dateOnly) {
    var o = {}; new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms)).forEach(function (x) { o[x.type] = x.value; });
    return o.year + '-' + o.month + '-' + o.day + (dateOnly ? '' : ' ' + (o.hour === '24' ? '00' : o.hour) + ':' + o.minute);
  }
  var SHIFT = 9 * 3600;   // 인트라데이 봉의 차트 시각 = UTC + 9h (KST 벽시계)

  // ---------- 시간대 데이터 ----------
  var TF_LABEL = { '15m': '15분', '1h': '1시간', '4h': '4시간', '1d': '일봉', '1w': '주봉' };
  var TF_ORDER = ['15m', '1h', '4h', '1d', '1w'];
  var cache = {};
  function bars(tf) {   // [{time, utc, o,h,l,c,v}]
    if (cache[tf]) return cache[tf];
    var out = [];
    if (tf === '4h') {
      var src = bars('1h'), cur = null;
      src.forEach(function (b) {
        var k = Math.floor(b.utc / 14400) * 14400;
        if (!cur || cur.utc !== k) { cur = { time: k + SHIFT, utc: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; out.push(cur); }
        else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
      });
    } else if (tf === '1w') {
      var srcD = bars('1d'), curW = null;
      srcD.forEach(function (b) {
        var d = new Date(b.time + 'T00:00:00Z'), dow = (d.getUTCDay() + 6) % 7;   // 월=0
        var mon = new Date(d.getTime() - dow * 86400000).toISOString().slice(0, 10);
        if (!curW || curW.week !== mon) { curW = { week: mon, time: b.time, utc: b.utc, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; out.push(curW); }
        else { curW.h = Math.max(curW.h, b.h); curW.l = Math.min(curW.l, b.l); curW.c = b.c; curW.v += b.v; }
      });
    } else {
      (DATA.tfs[tf] || []).forEach(function (r) { out.push({ time: r[0], utc: r[1], o: r[2], h: r[3], l: r[4], c: r[5], v: r[6] }); });
    }
    cache[tf] = out; return out;
  }
  var AVAIL = TF_ORDER.filter(function (tf) {
    if (tf === '4h') return !!(DATA.tfs['1h'] && DATA.tfs['1h'].length);
    if (tf === '1w') return !!(DATA.tfs['1d'] && DATA.tfs['1d'].length);
    return !!(DATA.tfs[tf] && DATA.tfs[tf].length);
  });
  if (AVAIL.indexOf(state.tf) < 0) state.tf = AVAIL.indexOf('1d') >= 0 ? '1d' : AVAIL[0];
  function intraday(tf) { return tf === '15m' || tf === '1h' || tf === '4h'; }
  function timeKey(t) { return typeof t === 'string' ? t : (t && t.year ? t.year + '-' + String(t.month).padStart(2, '0') + '-' + String(t.day).padStart(2, '0') : String(t)); }

  // ---------- 지표 ----------
  function sma(a, k) { var out = [], s = 0; for (var i = 0; i < a.length; i++) { s += a[i]; if (i >= k) s -= a[i - k]; out.push(i >= k - 1 ? s / k : null); } return out; }
  function ema(a, k) { var out = [], m = 2 / (k + 1), e = null; for (var i = 0; i < a.length; i++) { e = e == null ? a[i] : a[i] * m + e * (1 - m); out.push(i >= k - 1 ? e : null); } return out; }
  function stdev(a, k) { var out = []; for (var i = 0; i < a.length; i++) { if (i < k - 1) { out.push(null); continue; } var s = 0, s2 = 0; for (var j = i - k + 1; j <= i; j++) { s += a[j]; s2 += a[j] * a[j]; } var mu = s / k; out.push(Math.sqrt(Math.max(s2 / k - mu * mu, 0))); } return out; }
  function rsi(a, k) { var out = [null]; if (a.length <= k) return a.map(function () { return null; }); var g = 0, l = 0; for (var i = 1; i <= k; i++) { var ch = a[i] - a[i - 1]; if (ch > 0) g += ch; else l -= ch; out.push(null); } var ag = g / k, al = l / k; out[k] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); for (var j = k + 1; j < a.length; j++) { var c = a[j] - a[j - 1]; ag = (ag * (k - 1) + Math.max(c, 0)) / k; al = (al * (k - 1) + Math.max(-c, 0)) / k; out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al)); } return out; }
  function atr(bs, k) { var out = [], trs = []; for (var i = 0; i < bs.length; i++) { var pc = i ? bs[i - 1].c : bs[i].c; trs.push(Math.max(bs[i].h - bs[i].l, Math.abs(bs[i].h - pc), Math.abs(bs[i].l - pc))); } var a = null; for (var j = 0; j < bs.length; j++) { if (j < k) { out.push(null); continue; } if (a == null) { a = 0; for (var q = 1; q <= k; q++) a += trs[q]; a /= k; } else a = (a * (k - 1) + trs[j]) / k; out.push(a); } return out; }

  // ---------- 차트 ----------
  var mainEl = $('main'), rsiEl = $('rsi'), vxEl = $('vx');
  var main = LWC.createChart(mainEl, Object.assign(layout(), { width: mainEl.clientWidth, height: 520 }));
  var rsiC = LWC.createChart(rsiEl, Object.assign(layout(), { width: rsiEl.clientWidth, height: 150 }));
  var vxC = LWC.createChart(vxEl, Object.assign(layout(), { width: vxEl.clientWidth, height: 130 }));
  rsiC.applyOptions({ rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.1 }, mode: 0 } });
  vxC.applyOptions({ rightPriceScale: { scaleMargins: { top: 0.15, bottom: 0.05 }, mode: 0 } });
  var charts = [main, rsiC, vxC];

  var zones = main.addHistogramSeries({ priceScaleId: 'zones', base: 0, lastValueVisible: false, priceLineVisible: false, priceFormat: { type: 'volume' } });
  main.priceScale('zones').applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
  var candles = main.addCandlestickSeries({ upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350', priceFormat: { type: 'price', precision: PD, minMove: PD ? Math.pow(10, -PD) : 1 } });
  var vol = main.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
  main.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  var bbU = main.addLineSeries({ color: '#29b6f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  var bbM = main.addLineSeries({ color: 'rgba(41,182,246,.7)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  var bbL = main.addLineSeries({ color: '#29b6f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  var maSeries = [];
  var rsiLine = rsiC.addLineSeries({ color: '#7e57c2', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true });
  [30, 50, 70].forEach(function (v) { rsiLine.createPriceLine({ price: v, color: v === 50 ? '#8b8f9a' : '#ef5350', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' }); });
  var vxLine = vxC.addAreaSeries({ lineColor: '#ff7043', topColor: 'rgba(255,112,67,.35)', bottomColor: 'rgba(255,112,67,.02)', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true, title: 'VXN' });
  var priceLines = [];

  function axes() {
    var vOn = vxEl.style.display !== 'none', rOn = rsiEl.style.display !== 'none';
    main.applyOptions({ timeScale: { visible: !rOn && !vOn } });
    rsiC.applyOptions({ timeScale: { visible: rOn && !vOn } });
    vxC.applyOptions({ timeScale: { visible: vOn } });
  }

  // ---------- 현재 시간대 데이터 적재 ----------
  var rows = [], byTime = {}, calc = {};
  function load(tf) {
    state.tf = tf; save();
    syncing = true;   // 적재 중엔 각 창이 내보내는 '전체 보기' 범위 변경이 서로를 덮어쓰지 않게 동기화를 막는다
    rows = bars(tf); byTime = {};
    var c = [], v = [], zd = [];
    rows.forEach(function (b, i) { byTime[timeKey(b.time)] = i; c.push({ time: b.time, open: b.o, high: b.h, low: b.l, close: b.c }); v.push({ time: b.time, value: b.v, color: b.c >= b.o ? 'rgba(38,166,154,.45)' : 'rgba(239,83,80,.45)' }); });
    candles.setData(c); vol.setData(v);
    // 구간 음영 — 봉 전체 높이의 히스토그램
    (DATA.zones || []).forEach(function (z) {
      var a = zoneRange(z, tf);
      for (var i = a[0]; i <= a[1]; i++) zd.push({ time: rows[i].time, value: 1, color: z.color || 'rgba(38,166,154,.15)' });
    });
    zd.sort(function (x, y) { return (typeof x.time === 'string' ? x.time.localeCompare(y.time) : x.time - y.time); });
    zones.setData(dedupe(zd));
    applyIndicators();
    candles.setMarkers(markersFor(tf));
    var intra = intraday(tf);
    charts.forEach(function (ch) { ch.applyOptions({ timeScale: { timeVisible: intra, secondsVisible: false } }); });
    document.querySelectorAll('#tfs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tf === tf); });
    $('range').textContent = rows.length + '봉 · ' + label(rows[0]) + ' ~ ' + label(rows[rows.length - 1]) + (intra ? ' KST' : '');
    // setData 직후 각 창이 자기 범위 변경을 내보낸다 — 가라앉은 뒤 동기화를 풀고 이동하고, 늦게 오는 것에 대비해 한 번 더
    setTimeout(function () { syncing = false; gotoEvent(); }, 80);
    setTimeout(gotoEvent, 400);
    legend(rows.length - 1);
  }
  function dedupe(d) { var out = [], last = null; d.forEach(function (x) { var k = timeKey(x.time); if (k !== last) { out.push(x); last = k; } }); return out; }
  function idxAtUtc(u) { var lo = 0; for (var i = 0; i < rows.length; i++) { if (rows[i].utc <= u) lo = i; else break; } return lo; }
  function idxAtDaily(d) { for (var i = 0; i < rows.length; i++) if (rows[i].time >= d) return i; return rows.length - 1; }
  function eventIndex(e, tf) {
    if (intraday(tf)) { if (e.utc != null) return idxAtUtc(e.utc); if (e.daily) return idxAtDaily_intra(e.daily); }
    if (e.daily) return idxAtDaily(e.daily);
    if (e.utc != null) return idxAtUtc(e.utc);
    return 0;
  }
  function idxAtDaily_intra(d) { var u = Date.parse(d + 'T00:00:00Z') / 1000 - 9 * 3600 + 24 * 3600; for (var i = 0; i < rows.length; i++) if (rows[i].utc >= u - 24 * 3600) return i; return rows.length - 1; }
  function zoneRange(z, tf) {
    var a = eventIndex({ utc: z.from_utc, daily: z.from }, tf), b = eventIndex({ utc: z.to_utc, daily: z.to }, tf);
    if (intraday(tf) && z.to_utc == null && z.to) b = idxAtUtc(Date.parse(z.to + 'T23:59:59Z') / 1000);
    if (b < a) b = a; return [a, b];
  }
  function markersFor(tf) {
    var ms = DATA.events.map(function (e) {
      var i = eventIndex(e, tf), kind = e.kind || 'info';
      var shape = kind === 'entry' ? 'arrowUp' : kind === 'exit' ? 'arrowDown' : 'circle';
      var pos = kind === 'entry' ? 'belowBar' : kind === 'exit' ? 'aboveBar' : (e.pos === 'above' ? 'aboveBar' : 'belowBar');
      return { time: rows[i].time, position: pos, shape: shape, color: e.color, text: e.tag, size: kind === 'info' ? 1 : 2 };
    });
    ms.sort(function (x, y) { return (typeof x.time === 'string' ? x.time.localeCompare(y.time) : x.time - y.time); });
    return ms;
  }

  // ---------- 지표 적용 ----------
  function applyIndicators() {
    var ind = state.ind, closes = rows.map(function (b) { return b.c; });
    maSeries.forEach(function (s) { main.removeSeries(s.series); }); maSeries = [];
    (ind.ma || []).forEach(function (m, k) {
      var vals = (m.type === 'EMA' ? ema : sma)(closes, m.n), color = m.color || MA_COLORS[k % MA_COLORS.length];
      var s = main.addLineSeries({ color: color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(rows.map(function (b, i) { return vals[i] == null ? null : { time: b.time, value: vals[i] }; }).filter(Boolean));
      maSeries.push({ series: s, vals: vals, label: m.type + m.n, color: color });
    });
    var bb = ind.bb || { on: false }, bbOn = !!bb.on;
    if (bbOn) {
      var mid = sma(closes, bb.n), sd = stdev(closes, bb.n);
      calc.bb = { u: mid.map(function (m, i) { return m == null ? null : m + bb.k * sd[i]; }), m: mid, l: mid.map(function (m, i) { return m == null ? null : m - bb.k * sd[i]; }) };
      [['u', bbU], ['m', bbM], ['l', bbL]].forEach(function (p) { p[1].setData(rows.map(function (b, i) { return calc.bb[p[0]][i] == null ? null : { time: b.time, value: calc.bb[p[0]][i] }; }).filter(Boolean)); });
    } else { calc.bb = null; [bbU, bbM, bbL].forEach(function (s) { s.setData([]); }); }
    [bbU, bbM, bbL].forEach(function (s) { s.applyOptions({ visible: bbOn }); });
    var r = ind.rsi || { on: false, n: 14 };
    calc.rsi = r.on ? rsi(closes, r.n) : null;
    rsiLine.setData(r.on ? rows.map(function (b, i) { return calc.rsi[i] == null ? null : { time: b.time, value: calc.rsi[i] }; }).filter(Boolean) : []);
    rsiEl.style.display = r.on ? '' : 'none';
    calc.atr = atr(rows, 14);
    vol.applyOptions({ visible: ind.volume !== false });
    var vxOn = !!(DATA.vx && ind.vx !== false);
    if (DATA.vx) { calc.vx = vxFor(state.tf); vxLine.setData(vxOn ? rows.map(function (b, i) { return calc.vx[i] == null ? null : { time: b.time, value: calc.vx[i] }; }).filter(Boolean) : []); }
    vxEl.style.display = vxOn ? '' : 'none';
    $('tgVx').style.display = DATA.vx ? '' : 'none';
    // 가격선: 스펙 lines + 가격이 있는 이벤트
    priceLines.forEach(function (p) { candles.removePriceLine(p); }); priceLines = [];
    (DATA.lines || []).concat(DATA.events.filter(function (e) { return e.price != null; }).map(function (e) { return { price: e.price, label: e.tag + ' ' + (e.label || ''), color: e.color }; }))
      .forEach(function (l) { priceLines.push(candles.createPriceLine({ price: l.price, color: l.color || '#8b8f9a', lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: l.label || '' })); });
    axes(); resize();
  }
  function vxFor(tf) {   // 현재 시간대의 각 봉에 붙는 변동성 지수 값 (일봉·주봉은 날짜, 인트라데이는 그 시각 이전 마지막 값)
    var src = intraday(tf) ? (DATA.vx['1h'] || []) : (DATA.vx['1d'] || []), out = [], j = -1;
    if (!intraday(tf)) { var byD = {}; src.forEach(function (x) { byD[x[0]] = x[1]; }); if (tf === '1w') { var keys = Object.keys(byD).sort(); return rows.map(function (b, i) { var nxt = rows[i + 1] ? rows[i + 1].time : '9999'; var v = null; keys.forEach(function (k) { if (k >= b.time && k < nxt) v = byD[k]; }); return v; }); } return rows.map(function (b) { return byD[b.time] == null ? null : byD[b.time]; }); }
    return rows.map(function (b) { while (j + 1 < src.length && src[j + 1][0] <= b.utc) j++; return j >= 0 ? src[j][1] : null; });
  }

  // ---------- 범례 ----------
  function label(b) { return intraday(state.tf) ? fmt('Asia/Seoul', b.utc * 1000).slice(5) : b.time; }
  function legend(i) {
    var b = rows[i]; if (!b) return;
    var chg = b.c - b.o, pct = chg / b.o * 100, cls = chg >= 0 ? 'u' : 'd';
    var when = intraday(state.tf)
      ? '<b>' + fmt('Asia/Seoul', b.utc * 1000) + ' KST</b>' + (DATA.has2tz ? ' <span class="mut">' + DATA.locAbbr + ' ' + fmt(DATA.tz, b.utc * 1000) + '</span>' : '')
      : '<b>' + b.time + '</b> <span class="mut">' + (state.tf === '1w' ? '주봉(월요일 시작)' : '세션' + (DATA.sessionNote ? '(' + DATA.sessionNote + ')' : '')) + '</span>';
    var h = when + '<br>O <b>' + n(b.o, PD) + '</b> H <b>' + n(b.h, PD) + '</b> L <b>' + n(b.l, PD) + '</b> C <b class="' + cls + '">' + n(b.c, PD) + '</b> ' +
      '<span class="' + cls + '">' + (chg >= 0 ? '+' : '') + n(chg, PD) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)</span> Vol <b>' + n(b.v, 0) + '</b><br>';
    maSeries.forEach(function (m) { h += '<span style="color:' + m.color + '">' + m.label + ' ' + n(m.vals[i], PD) + '</span> '; });
    if (calc.bb) h += '<span class="bb">BB ' + n(calc.bb.u[i], PD) + ' / ' + n(calc.bb.m[i], PD) + ' / ' + n(calc.bb.l[i], PD) + '</span> ';
    if (calc.rsi) h += '<span class="rsi">RSI' + state.ind.rsi.n + ' ' + n(calc.rsi[i], 1) + '</span> ';
    h += 'ATR14 ' + n(calc.atr[i], PD);
    if (calc.vx && DATA.vx && state.ind.vx !== false) h += ' <span class="vx">VXN ' + n(calc.vx[i], 1) + '</span>';
    $('legend').innerHTML = h;
  }
  function onMove(src) {
    return function (p) {
      var i = p.time != null ? byTime[timeKey(p.time)] : null;
      legend(i == null ? rows.length - 1 : i);
      var targets = [[main, candles, i != null && rows[i].c], [rsiC, rsiLine, i != null && calc.rsi && calc.rsi[i]], [vxC, vxLine, i != null && calc.vx && calc.vx[i]]];
      targets.forEach(function (t) { if (t[0] === src) return; try { if (p.time != null && t[2] != null && t[2] !== false) t[0].setCrosshairPosition(t[2], p.time, t[1]); else t[0].clearCrosshairPosition(); } catch (e) {} });
    };
  }
  charts.forEach(function (ch) { ch.subscribeCrosshairMove(onMove(ch)); });
  var syncing = false;
  charts.forEach(function (a) { a.timeScale().subscribeVisibleLogicalRangeChange(function (r) { if (syncing || !r) return; syncing = true; charts.forEach(function (b) { if (b !== a) b.timeScale().setVisibleLogicalRange(r); }); syncing = false; }); });

  // ---------- 이벤트 목록 · 클릭 ----------
  var evEl = $('events');
  DATA.events.forEach(function (e, k) {
    var li = document.createElement('li'); li.dataset.k = k;
    var kindTxt = e.kind === 'entry' ? '<span class="kind entry">진입</span>' : e.kind === 'exit' ? '<span class="kind exit">정리</span>' : '';
    li.innerHTML = '<span class="tag" style="color:' + e.color + '">' + e.tag + '</span>' + kindTxt + e.text + (e.price != null ? ' <span class="px">' + n(e.price, PD) + '</span>' : '') + '<span class="when">' + e.when + '</span>';
    li.onclick = function () { gotoIndex(eventIndex(e, state.tf)); flash(k); };
    evEl.appendChild(li);
  });
  function flash(k) { evEl.querySelectorAll('li').forEach(function (li) { li.classList.toggle('hl', li.dataset.k == k); }); }
  main.subscribeClick(function (p) {
    if (p.time == null) return; var i = byTime[timeKey(p.time)]; if (i == null) return;
    var hit = null; DATA.events.forEach(function (e, k) { if (eventIndex(e, state.tf) === i) hit = k; });
    if (hit != null) { flash(hit); evEl.querySelector('li[data-k="' + hit + '"]').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  });

  // ---------- 이동 · 조작 ----------
  var VIEW_DEFAULT = { '15m': [80, 80], '1h': [60, 60], '4h': [60, 60], '1d': [70, 30], '1w': [30, 20] };
  function gotoIndex(i, tf) { var v = (DATA.view && DATA.view[state.tf]) || VIEW_DEFAULT[state.tf]; main.timeScale().setVisibleLogicalRange({ from: i - v[0], to: i + v[1] }); }
  function gotoEvent() { var e = DATA.events.filter(function (x) { return x.primary; })[0] || DATA.events[0]; gotoIndex(e ? eventIndex(e, state.tf) : 0); }
  $('goto').onclick = gotoEvent;
  $('fit').onclick = function () { main.timeScale().fitContent(); };
  var tfs = $('tfs');
  AVAIL.forEach(function (tf) { var b = document.createElement('button'); b.dataset.tf = tf; b.textContent = TF_LABEL[tf]; b.onclick = function () { load(tf); }; tfs.appendChild(b); });
  $('tgLog').onclick = function () { state.log = !state.log; save(); $('tgLog').classList.toggle('on', state.log); main.applyOptions({ rightPriceScale: { mode: state.log ? LWC.PriceScaleMode.Logarithmic : LWC.PriceScaleMode.Normal } }); };
  $('tgLog').classList.toggle('on', state.log);
  $('theme').onclick = function () { if (dark()) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', 'dark'); state.theme = dark() ? 'dark' : 'light'; save(); charts.forEach(function (ch) { ch.applyOptions(layout()); }); axes(); };
  $('full').onclick = function () { var w = $('wrap'); if (document.fullscreenElement) document.exitFullscreen(); else if (w.requestFullscreen) w.requestFullscreen(); };
  document.addEventListener('fullscreenchange', function () { var fs = !!document.fullscreenElement; var extra = (rsiEl.style.display !== 'none' ? 150 : 0) + (vxEl.style.display !== 'none' ? 130 : 0); main.applyOptions({ height: fs ? Math.max(300, window.innerHeight - extra - 8) : 520 }); resize(); });
  function resize() { main.applyOptions({ width: mainEl.clientWidth }); rsiC.applyOptions({ width: rsiEl.clientWidth }); vxC.applyOptions({ width: vxEl.clientWidth }); }
  window.addEventListener('resize', resize);

  // ---------- 지표 패널 ----------
  var panel = $('indpanel');
  $('tgInd').onclick = function () { panel.hidden = !panel.hidden; $('tgInd').classList.toggle('on', !panel.hidden); if (!panel.hidden) renderPanel(); };
  function renderPanel() {
    var ind = state.ind, h = '';
    h += '<div class="row head"><b>이동평균</b><button class="mini" id="addMa">+ 추가</button></div>';
    (ind.ma || []).forEach(function (m, k) {
      h += '<div class="row" data-k="' + k + '"><select class="maType"><option' + (m.type === 'SMA' ? ' selected' : '') + '>SMA</option><option' + (m.type === 'EMA' ? ' selected' : '') + '>EMA</option></select>' +
           '<input class="maN" type="number" min="2" max="500" value="' + m.n + '"><input class="maC" type="color" value="' + toHex(m.color || MA_COLORS[k % MA_COLORS.length]) + '"><button class="mini del">✕</button></div>';
    });
    var bb = ind.bb || { on: false, n: 20, k: 2 };
    h += '<div class="row head"><label><input type="checkbox" id="bbOn"' + (bb.on ? ' checked' : '') + '> <b>볼린저 밴드</b></label> 기간 <input id="bbN" type="number" min="2" max="500" value="' + bb.n + '"> 승수 <input id="bbK" type="number" step="0.1" min="0.5" max="5" value="' + bb.k + '"></div>';
    var r = ind.rsi || { on: true, n: 14 };
    h += '<div class="row head"><label><input type="checkbox" id="rsiOn"' + (r.on ? ' checked' : '') + '> <b>RSI</b></label> 기간 <input id="rsiN" type="number" min="2" max="200" value="' + r.n + '"></div>';
    h += '<div class="row head"><label><input type="checkbox" id="volOn"' + (ind.volume !== false ? ' checked' : '') + '> <b>거래량</b></label>' + (DATA.vx ? ' <label><input type="checkbox" id="vxOn"' + (ind.vx !== false ? ' checked' : '') + '> <b>' + DATA.vx.name + '</b></label>' : '') + '</div>';
    h += '<div class="row"><button class="mini" id="indReset">기본값으로</button><span class="mut">바꾼 설정은 이 브라우저에 남는다</span></div>';
    panel.innerHTML = h;
    var apply = function () {
      ind.ma = [].map.call(panel.querySelectorAll('.row[data-k]'), function (row) { return { type: row.querySelector('.maType').value, n: Math.max(2, parseInt(row.querySelector('.maN').value, 10) || 20), color: row.querySelector('.maC').value }; });
      ind.bb = { on: $('bbOn').checked, n: Math.max(2, parseInt($('bbN').value, 10) || 20), k: parseFloat($('bbK').value) || 2 };
      ind.rsi = { on: $('rsiOn').checked, n: Math.max(2, parseInt($('rsiN').value, 10) || 14) };
      ind.volume = $('volOn').checked; if ($('vxOn')) ind.vx = $('vxOn').checked;
      save(); applyIndicators(); legend(rows.length - 1);
    };
    panel.querySelectorAll('input,select').forEach(function (el) { el.addEventListener('change', apply); });
    panel.querySelectorAll('.del').forEach(function (b) { b.onclick = function () { b.parentNode.remove(); apply(); renderPanel(); }; });
    $('addMa').onclick = function () { ind.ma = (ind.ma || []).concat([{ type: 'SMA', n: 10 }]); save(); applyIndicators(); legend(rows.length - 1); renderPanel(); };
    $('indReset').onclick = function () { state.ind = JSON.parse(JSON.stringify(DEFAULT_IND)); save(); applyIndicators(); legend(rows.length - 1); renderPanel(); };
  }
  function toHex(c) { if (/^#[0-9a-f]{6}$/i.test(c)) return c; var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); return m ? '#' + [m[1], m[2], m[3]].map(function (x) { return ('0' + parseInt(x, 10).toString(16)).slice(-2); }).join('') : '#f5a623'; }
  $('tgVx').onclick = function () { state.ind.vx = state.ind.vx === false; save(); applyIndicators(); };

  // 표는 스크롤 영역이라 이벤트 행이 접힌 아래에 숨는다 — 열릴 때 그 행이 보이게 맞춘다
  function showHit(tw) { var hit = tw.querySelector('tr.hit'); if (hit) tw.scrollTop = Math.max(0, hit.offsetTop - tw.clientHeight / 2); }
  document.querySelectorAll('.tw').forEach(showHit);
  document.querySelectorAll('details').forEach(function (d) { d.addEventListener('toggle', function () { if (d.open) d.querySelectorAll('.tw').forEach(showHit); }); });

  // ---------- 그리기 — 선·도형 (트레이딩뷰식). 점은 UTC 초·가격으로 저장해 시간대를 바꿔도 같은 자리 ----------
  var DKEY = 'sbchart:draw:' + DATA.name;
  var drawings = [], selected = -1, tool = null, pending = null, drag = null, history = [], curColor = '#2962ff';
  try { var dd = JSON.parse(localStorage.getItem(DKEY) || 'null'); drawings = dd ? dd : JSON.parse(JSON.stringify(DATA.drawings || [])); } catch (e) {}
  var cv = $('draw'), ctx = cv.getContext('2d'), wrapEl = $('wrap'), txtEl = $('drawtext');
  function dsave() { try { localStorage.setItem(DKEY, JSON.stringify(drawings)); } catch (e) {} }
  function dpush() { history.push(JSON.stringify(drawings)); if (history.length > 40) history.shift(); }
  var TF_SEC = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
  function barDur(i) { var b = rows[i], nb = rows[i + 1]; return nb ? nb.utc - b.utc : TF_SEC[state.tf]; }
  function utcToLogical(u) { if (!rows.length) return 0; if (u < rows[0].utc) return (u - rows[0].utc) / barDur(0); var i = idxAtUtc(u); return i + Math.max(0, Math.min(1, (u - rows[i].utc) / barDur(i))); }
  function logicalToUtc(l) { if (!rows.length) return 0; var i = Math.floor(l), f = l - i; if (i < 0) return rows[0].utc + l * barDur(0); if (i >= rows.length) { i = rows.length - 1; f = l - i; } return rows[i].utc + f * barDur(i); }
  // lightweight-charts 4.2 의 logicalToCoordinate 는 정수 인덱스만 받는다(소수를 주면 0) — 봉 사이 점은 앞뒤 봉 좌표로 보간한다
  function logicalToX(l) { var ts = main.timeScale(), i = Math.floor(l), f = l - i, x0 = ts.logicalToCoordinate(i); if (x0 == null) return null; if (!f) return x0; var x1 = ts.logicalToCoordinate(i + 1); return x1 == null ? x0 + f * ts.options().barSpacing : x0 + f * (x1 - x0); }
  function toXY(p) { var x = logicalToX(utcToLogical(p.u)), y = candles.priceToCoordinate(p.p); return (x == null || y == null) ? null : { x: x, y: y }; }
  function fromXY(x, y) { var l = main.timeScale().coordinateToLogical(x), p = candles.coordinateToPrice(y); return (l == null || p == null) ? null : { u: logicalToUtc(l), p: p }; }
  function fmtPoint(u) { return intraday(state.tf) ? fmt('Asia/Seoul', u * 1000).slice(5) + ' KST' : fmt(DATA.tz, u * 1000, true); }
  function paneSize() { var ts = main.timeScale(); return { w: mainEl.clientWidth - main.priceScale('right').width(), h: mainEl.clientHeight - (ts.options().visible ? ts.height() : 0) }; }
  function pill(t, x, y, align) { ctx.font = '11.5px system-ui, sans-serif'; var w = ctx.measureText(t).width + 8, x0 = align === 'right' ? x - w : x; ctx.save(); ctx.globalAlpha = 0.92; ctx.fillRect(x0, y - 13, w, 16); ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(t, x0 + 4, y - 1); ctx.restore(); }
  function drawOne(d, sel, ps) {
    var col = d.color || '#2962ff'; ctx.lineWidth = sel ? 2.5 : 1.5; ctx.strokeStyle = col; ctx.fillStyle = col; ctx.setLineDash(d.type === 'vline' ? [4, 3] : []);
    var a = toXY(d.pts[0]); if (!a) return; var b = d.pts[1] ? toXY(d.pts[1]) : null;
    if (d.type === 'hline') { ctx.beginPath(); ctx.moveTo(0, a.y); ctx.lineTo(ps.w, a.y); ctx.stroke(); pill(n(d.pts[0].p, PD), ps.w - 4, a.y - 3, 'right'); }
    else if (d.type === 'vline') { ctx.beginPath(); ctx.moveTo(a.x, 0); ctx.lineTo(a.x, ps.h); ctx.stroke(); pill(fmtPoint(d.pts[0].u), a.x + 4, 16, 'left'); }
    else if (d.type === 'trend' && b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    else if (d.type === 'rect' && b) { var x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y); ctx.globalAlpha = 0.14; ctx.fillRect(x1, y1, w, h); ctx.globalAlpha = 1; ctx.strokeRect(x1, y1, w, h); }
    else if (d.type === 'text') { ctx.beginPath(); ctx.arc(a.x, a.y, 2.5, 0, 6.283); ctx.fill(); pill(d.text || '', a.x + 5, a.y - 4, 'left'); }
    if (sel) [a, b].forEach(function (p) { if (!p) return; ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 6.283); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke(); });
  }
  function redraw() {
    var w = mainEl.clientWidth, h = mainEl.clientHeight, r = window.devicePixelRatio || 1;
    cv.style.left = mainEl.offsetLeft + 'px'; cv.style.top = mainEl.offsetTop + 'px'; cv.style.width = w + 'px'; cv.style.height = h + 'px';
    if (cv.width !== Math.round(w * r) || cv.height !== Math.round(h * r)) { cv.width = Math.round(w * r); cv.height = Math.round(h * r); }
    ctx.setTransform(r, 0, 0, r, 0, 0); ctx.clearRect(0, 0, w, h);
    if (!rows.length) return;
    var ps = paneSize(); ctx.save(); ctx.beginPath(); ctx.rect(0, 0, ps.w, ps.h); ctx.clip();
    drawings.forEach(function (d, k) { drawOne(d, k === selected, ps); });
    if (pending && pending.preview) drawOne(pending.preview, false, ps);
    ctx.restore();
  }
  function segDist(x, y, a, b) { var dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0; return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)); }
  function distTo(d, x, y) {
    var a = toXY(d.pts[0]); if (!a) return null; var b = d.pts[1] ? toXY(d.pts[1]) : null;
    if (d.type === 'hline') return Math.abs(y - a.y); if (d.type === 'vline') return Math.abs(x - a.x); if (d.type === 'text') return Math.hypot(x - a.x, y - a.y);
    if (!b) return null; if (d.type === 'trend') return segDist(x, y, a, b);
    if (d.type === 'rect') { var x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y); if (x >= x1 && x <= x2 && y >= y1 && y <= y2) return 0; return Math.hypot(Math.max(x1 - x, 0, x - x2), Math.max(y1 - y, 0, y - y2)); }
    return null;
  }
  function hitTest(x, y) { var best = -1, bd = 8; drawings.forEach(function (d, k) { var v = distTo(d, x, y); if (v != null && v < bd) { bd = v; best = k; } }); return best; }
  function handleAt(d, q) { for (var i = 0; i < d.pts.length; i++) { var p = toXY(d.pts[i]); if (p && Math.hypot(q.x - p.x, q.y - p.y) <= 8) return i; } return null; }
  function setTool(t) { tool = t || null; pending = null; if (tool) selected = -1; cv.style.pointerEvents = (tool || selected >= 0) ? 'auto' : 'none'; cv.style.cursor = tool ? 'crosshair' : 'default';
    document.querySelectorAll('#drawbar button[data-tool]').forEach(function (b) { b.classList.toggle('on', (b.dataset.tool || null) === tool); }); redraw(); }
  function select(k) { selected = k; cv.style.pointerEvents = k >= 0 ? 'auto' : 'none'; redraw(); }
  function ptr(e) { var r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function addDrawing(d) { dpush(); drawings.push(d); dsave(); }
  function openText(q, pt) { txtEl.hidden = false; txtEl.value = ''; txtEl.style.left = (mainEl.offsetLeft + q.x) + 'px'; txtEl.style.top = (mainEl.offsetTop + q.y) + 'px'; txtEl.focus();
    txtEl.onkeydown = function (e) { if (e.key === 'Enter') { if (txtEl.value.trim()) addDrawing({ type: 'text', pts: [pt], color: curColor, text: txtEl.value.trim() }); txtEl.hidden = true; setTool(null); } else if (e.key === 'Escape') { txtEl.hidden = true; setTool(null); } e.stopPropagation(); };
    txtEl.onblur = function () { txtEl.hidden = true; }; }
  cv.addEventListener('pointerdown', function (e) {
    var q = ptr(e), pt = fromXY(q.x, q.y); if (!pt) return; e.preventDefault();
    if (tool === 'hline' || tool === 'vline') { addDrawing({ type: tool, pts: [pt], color: curColor }); setTool(null); return; }
    if (tool === 'text') { openText(q, pt); return; }
    if (tool === 'trend' || tool === 'rect') { if (!pending) pending = { type: tool, p1: pt }; else { addDrawing({ type: tool, pts: [pending.p1, pt], color: curColor }); setTool(null); } return; }
    if (selected >= 0) {
      var d = drawings[selected], hnd = handleAt(d, q);
      if (hnd == null) { var k = hitTest(q.x, q.y); if (k < 0) { select(-1); return; } selected = k; d = drawings[k]; }
      dpush(); drag = { k: selected, which: hnd == null ? 'all' : hnd, start: q, orig: JSON.parse(JSON.stringify(d.pts)) }; cv.setPointerCapture(e.pointerId); redraw();
    }
  });
  cv.addEventListener('pointermove', function (e) {
    var q = ptr(e);
    if (pending) { var pt = fromXY(q.x, q.y); if (pt) { pending.preview = { type: pending.type, pts: [pending.p1, pt], color: curColor }; redraw(); } return; }
    if (drag) { var dx = q.x - drag.start.x, dy = q.y - drag.start.y; drawings[drag.k].pts = drag.orig.map(function (p, i) { if (drag.which !== 'all' && drag.which !== i) return p; var o = toXY(p); if (!o) return p; return fromXY(o.x + dx, o.y + dy) || p; }); redraw(); return; }
    if (selected >= 0) cv.style.cursor = (handleAt(drawings[selected], q) != null || hitTest(q.x, q.y) >= 0) ? 'move' : 'default';
  });
  cv.addEventListener('pointerup', function () { if (drag) { drag = null; dsave(); } });
  main.subscribeClick(function (p) { if (tool || !p.point) return; var k = hitTest(p.point.x, p.point.y); if (k >= 0) select(k); });
  document.querySelectorAll('#drawbar button[data-tool]').forEach(function (b) { b.onclick = function () { setTool(b.dataset.tool || null); }; });
  $('drawColor').onchange = function () { curColor = $('drawColor').value; if (selected >= 0) { dpush(); drawings[selected].color = curColor; dsave(); redraw(); } };
  $('drawDel').onclick = function () { if (selected < 0) return; dpush(); drawings.splice(selected, 1); select(-1); dsave(); };
  $('drawUndo').onclick = function () { var prev = history.pop(); if (prev != null) { drawings = JSON.parse(prev); select(-1); dsave(); } };
  $('drawClear').onclick = function () { if (!drawings.length) return; dpush(); drawings = []; select(-1); dsave(); };
  $('drawReset').onclick = function () { dpush(); drawings = JSON.parse(JSON.stringify(DATA.drawings || [])); select(-1); dsave(); };
  function resetView() { main.priceScale('right').applyOptions({ autoScale: true }); gotoEvent(); }
  document.addEventListener('keydown', function (e) {
    var tg = e.target && e.target.tagName; if (tg === 'INPUT' || tg === 'SELECT' || tg === 'TEXTAREA') return;
    var k = e.key.toLowerCase();
    if (e.altKey && k === 'r') { e.preventDefault(); resetView(); }
    else if (e.altKey && k === 't') { e.preventDefault(); setTool('trend'); }
    else if (e.altKey && k === 'h') { e.preventDefault(); setTool('hline'); }
    else if (e.altKey && k === 'v') { e.preventDefault(); setTool('vline'); }
    else if (e.key === 'Escape') { select(-1); setTool(null); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0) { e.preventDefault(); $('drawDel').onclick(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); $('drawUndo').onclick(); }
  });
  main.timeScale().subscribeVisibleLogicalRangeChange(redraw);
  main.subscribeCrosshairMove(redraw);
  window.addEventListener('resize', redraw);
  setInterval(redraw, 500);   // 가격축 드래그처럼 이벤트가 없는 변화도 따라가게
  $('goto').addEventListener('click', function () { setTimeout(redraw, 60); });

  load(state.tf);
  setTimeout(redraw, 500);
})();
