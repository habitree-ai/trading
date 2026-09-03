# -*- coding: utf-8 -*-
"""선배님 글의 시세 대조용 인터랙티브 차트 페이지 — 봉 데이터를 내장한 독립 HTML.

   실행: python _수집스크립트/make_chart.py 차트/2025-04-09_나스닥선물.json
   결과: 스펙과 같은 이름의 .html (lightweight-charts, 일봉/1시간봉 전환, MA20/50/200·RSI14·거래량,
         이벤트 마커, 십자선 범례, 봉 데이터 표) 과 _일봉.csv / _1시간봉.csv

   시세는 Yahoo Finance v8 chart API 에서 받는다 — 이 PC 에서 실행한다(Claude 의 네트워크 경로는 막힌다).
   1시간봉은 야후가 최근 730일까지만 준다. 정리 문서에는 [링크](차트/이름.html) 로 건다 — 두 마크다운
   변환기(md2html.py·markdown.ts)가 HTML 태그를 이스케이프하므로 iframe 내장은 안 된다."""
import io, os, sys, json, csv, datetime as dt, urllib.request, urllib.parse

D = os.path.dirname(os.path.abspath(__file__)); R = os.path.dirname(D)
UTC = dt.timezone.utc
KST = dt.timezone(dt.timedelta(hours=9))

# ---------------- 시세 ----------------
def fetch(symbol, interval, p1, p2):
    url = ('https://query2.finance.yahoo.com/v8/finance/chart/' + urllib.parse.quote(symbol)
           + f'?interval={interval}&period1={p1}&period2={p2}')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)['chart']
    if d.get('error'):
        raise SystemExit(f'yahoo {interval}: {d["error"]}')
    res = d['result'][0]; q = res['indicators']['quote'][0]
    bars = []
    for i, t in enumerate(res['timestamp']):
        o, h, l, c, v = q['open'][i], q['high'][i], q['low'][i], q['close'][i], q['volume'][i]
        if None in (o, h, l, c):
            continue          # 거래 없는 시간대·결측
        bars.append([int(t), float(o), float(h), float(l), float(c), int(v or 0)])
    return bars

def epoch(iso):
    return int(dt.datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp())

# ---------------- 미국 동부 시각 (DST: 3월 둘째 일요일 02:00 ~ 11월 첫째 일요일 02:00) ----------------
def _nth_sunday(y, m, n):
    d = dt.date(y, m, 1)
    d += dt.timedelta(days=(6 - d.weekday()) % 7)
    return d + dt.timedelta(weeks=n - 1)

def et(utc_dt):
    y = utc_dt.year
    start = dt.datetime.combine(_nth_sunday(y, 3, 2), dt.time(7), UTC)   # 02:00 EST = 07:00 UTC
    end   = dt.datetime.combine(_nth_sunday(y, 11, 1), dt.time(6), UTC)  # 02:00 EDT = 06:00 UTC
    off = -4 if start <= utc_dt < end else -5
    return utc_dt.astimezone(dt.timezone(dt.timedelta(hours=off)))

# ---------------- 지표 (종가 기준, Wilder) ----------------
def sma(vals, n):
    out, s = [None] * len(vals), 0.0
    for i, v in enumerate(vals):
        s += v
        if i >= n: s -= vals[i - n]
        if i >= n - 1: out[i] = s / n
    return out

def rsi(vals, n=14):
    out = [None] * len(vals)
    if len(vals) <= n: return out
    g = l = 0.0
    for i in range(1, n + 1):
        ch = vals[i] - vals[i - 1]
        if ch > 0: g += ch
        else: l -= ch
    ag, al = g / n, l / n
    out[n] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(n + 1, len(vals)):
        ch = vals[i] - vals[i - 1]
        ag = (ag * (n - 1) + max(ch, 0)) / n
        al = (al * (n - 1) + max(-ch, 0)) / n
        out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out

def atr(bars, n=14):
    out = [None] * len(bars)
    if len(bars) <= n: return out
    trs = []
    for i, b in enumerate(bars):
        h, l = b[2], b[3]
        pc = bars[i - 1][4] if i else b[4]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    a = sum(trs[1:n + 1]) / n
    out[n] = a
    for i in range(n + 1, len(bars)):
        a = (a * (n - 1) + trs[i]) / n
        out[i] = a
    return out

def enrich(bars):
    closes = [b[4] for b in bars]
    m20, m50, m200, r, a = sma(closes, 20), sma(closes, 50), sma(closes, 200), rsi(closes), atr(bars)
    rd = lambda x, p=2: None if x is None else round(x, p)
    return [b + [rd(m20[i]), rd(m50[i]), rd(m200[i]), rd(r[i], 1), rd(a[i])] for i, b in enumerate(bars)]

# ---------------- 표기 ----------------
def kst_dt(t): return dt.datetime.fromtimestamp(t, KST)
def et_dt(t):  return et(dt.datetime.fromtimestamp(t, UTC))
def session_date(t):   # 야후 일봉 timestamp 는 거래소 현지 00:00 (04:00/05:00 UTC)
    return dt.datetime.fromtimestamp(t - 4 * 3600, UTC).date().isoformat()
def num(x, p=2):
    return '' if x is None else (f'{x:,.{p}f}' if p else f'{x:,.0f}')

def write_csv(path, rows, daily):
    with io.open(path, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow((['session_date_et'] if daily else ['bar_start_utc', 'bar_start_kst', 'bar_start_et'])
                   + ['open', 'high', 'low', 'close', 'volume', 'ma20', 'ma50', 'ma200', 'rsi14', 'atr14'])
        for b in rows:
            t = b[0]
            head = [session_date(t)] if daily else [
                dt.datetime.fromtimestamp(t, UTC).strftime('%Y-%m-%d %H:%M'),
                kst_dt(t).strftime('%Y-%m-%d %H:%M'), et_dt(t).strftime('%Y-%m-%d %H:%M')]
            w.writerow(head + [b[1], b[2], b[3], b[4], b[5]] + ['' if x is None else x for x in b[6:]])

def table_html(rows, daily, event_daily, event_hours):
    hd = (['세션(ET)'] if daily else ['KST', 'ET']) + ['시가', '고가', '저가', '종가', '등락', '거래량', 'MA20', 'MA50', 'MA200', 'RSI14', 'ATR14']
    out = ['<div class="tw"><table><thead><tr>' + ''.join(f'<th>{h}</th>' for h in hd) + '</tr></thead><tbody>']
    for i, b in enumerate(rows):
        t = b[0]
        prev = rows[i - 1][4] if i else None
        chg = '' if prev is None else f'{(b[4] / prev - 1) * 100:+.2f}%'
        if daily:
            key = session_date(t); cells = [key]; hit = key == event_daily
        else:
            cells = [kst_dt(t).strftime('%m-%d %H:%M'), et_dt(t).strftime('%m-%d %H:%M')]; hit = t in event_hours
        cells += [num(b[1]), num(b[2]), num(b[3]), num(b[4]), chg, num(b[5], 0),
                  num(b[6]), num(b[7]), num(b[8]), num(b[9], 1), num(b[10])]
        cls = ' class="hit"' if hit else ''
        out.append(f'<tr{cls}>' + ''.join(f'<td>{c}</td>' for c in cells) + '</tr>')
    out.append('</tbody></table></div>')
    return ''.join(out)

# ---------------- 메인 ----------------
def main(spec_path):
    spec = json.load(io.open(spec_path, encoding='utf-8'))
    base = os.path.splitext(os.path.abspath(spec_path))[0]
    name = os.path.basename(base)
    now = int(dt.datetime.now(UTC).timestamp())

    d1 = enrich(fetch(spec['symbol'], '1d', epoch(spec['daily']['from'] + 'T00:00:00Z'), now))
    h1 = enrich(fetch(spec['symbol'], '1h', epoch(spec['hourly']['from'] + 'T00:00:00Z'),
                      epoch(spec['hourly']['to'] + 'T00:00:00Z')))
    print(f'일봉 {len(d1)}개 {session_date(d1[0][0])} ~ {session_date(d1[-1][0])} / '
          f'1시간봉 {len(h1)}개 {kst_dt(h1[0][0]):%Y-%m-%d %H:%M} ~ {kst_dt(h1[-1][0]):%Y-%m-%d %H:%M} KST')

    write_csv(base + '_일봉.csv', d1, True)
    write_csv(base + '_1시간봉.csv', h1, False)

    # 차트용 — 일봉은 세션 날짜 문자열, 1시간봉은 KST 벽시계로 보이도록 9시간 민 epoch
    daily_rows = [[session_date(b[0]), b[0]] + b[1:] for b in d1]
    hour_rows = [[b[0] + 9 * 3600, b[0]] + b[1:] for b in h1]
    hour_times = {b[0] for b in h1}

    def snap(t):   # 이벤트 시각이 속한(그 이전 가장 가까운) 1시간봉
        t = t // 3600 * 3600
        while t not in hour_times and t > h1[0][0]: t -= 3600
        return t
    shape = {'below': 'arrowUp', 'above': 'arrowDown'}
    # 마커 글씨는 겹치므로 번호만 찍고, 본문은 차트 아래 '이벤트 마커' 목록에 둔다
    CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩'
    md, mh, ev_hours, ev_list = [], [], set(), []
    for k, e in enumerate(spec['events']):
        tag = CIRCLED[k] if k < len(CIRCLED) else str(k + 1)
        m = {'position': e['pos'] + 'Bar', 'shape': shape[e['pos']], 'color': e['color'], 'text': tag}
        if e.get('utc'):
            u = epoch(e['utc']); when = f'KST {kst_dt(u):%Y-%m-%d %H:%M} · ET {et_dt(u):%m-%d %H:%M}'
        else:
            when = f'{e["daily"]} 세션'
        ev_list.append(f'<li><span class="tag" style="color:{e["color"]}">{tag}</span>{e["text"]}<span class="when">{when}</span></li>')
        if e.get('daily'):
            md.append(dict(m, time=e['daily']))
        if e.get('utc'):
            t = snap(epoch(e['utc'])); ev_hours.add(t)
            mh.append(dict(m, time=t + 9 * 3600))
    mh.sort(key=lambda x: x['time'])

    ev = spec['event_date']
    idx = next(i for i, b in enumerate(d1) if session_date(b[0]) >= ev)
    n = spec['table']['daily_sessions']
    tbl_d = d1[max(0, idx - n): idx + n + 1]
    tf, tt = epoch(spec['table']['hourly_from_utc']), epoch(spec['table']['hourly_to_utc'])
    tbl_h = [b for b in h1 if tf <= b[0] <= tt]

    data = {'1d': daily_rows, '1h': hour_rows, 'markers': {'1d': md, '1h': mh},
            'event': ev, 'eventUtc': [epoch(e['utc']) for e in spec['events'] if e.get('utc')]}
    page = (TEMPLATE
            .replace('__TITLE__', spec['title'])
            .replace('__NAME__', spec['name'])
            .replace('__POST__', json.dumps(spec['post'], ensure_ascii=False))
            .replace('__NOTES__', ''.join(f'<li>{x}</li>' for x in spec['notes']))
            .replace('__EVENTS__', ''.join(ev_list))
            .replace('__TABLE_D__', table_html(tbl_d, True, ev, set()))
            .replace('__TABLE_H__', table_html(tbl_h, False, ev, ev_hours))
            .replace('__CSV_D__', name + '_일봉.csv').replace('__CSV_H__', name + '_1시간봉.csv')
            .replace('__FETCHED__', dt.datetime.now(KST).strftime('%Y-%m-%d %H:%M KST'))
            .replace('__DATA__', json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')))
    io.open(base + '.html', 'w', encoding='utf-8').write(page)
    print(f'→ {os.path.relpath(base + ".html", R)}  ({len(page.encode("utf-8")) // 1024}KB)')

TEMPLATE = r'''<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<script src="https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>
<style>
:root{--bg:#fbfaf7;--fg:#1f1d1a;--mut:#6f6a62;--line:#e4e0d8;--card:#fff;--up:#26a69a;--dn:#ef5350;--acc:#2962ff;--hit:#fff4d6}
:root[data-theme=dark]{--bg:#131722;--fg:#d1d4dc;--mut:#8b8f9a;--line:#2a2e39;--card:#1e222d;--hit:#3a3320}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 "IBM Plex Sans KR",system-ui,sans-serif}
header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--line)}
header h1{font-size:16px;margin:0;font-weight:600}
header .sub{color:var(--mut);font-size:12px}
.bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 18px;border-bottom:1px solid var(--line)}
button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit;font-size:12.5px}
button.on{border-color:var(--acc);color:var(--acc);font-weight:600}
.sp{flex:1}
#wrap{position:relative;padding:0 18px}
#legend{position:absolute;left:26px;top:8px;z-index:5;font-size:12px;line-height:1.5;pointer-events:none;background:color-mix(in srgb,var(--bg) 82%,transparent);padding:4px 8px;border-radius:6px}
#legend b{font-weight:600}
#legend .u{color:var(--up)} #legend .d{color:var(--dn)}
#legend .ma20{color:#f5a623} #legend .ma50{color:#2962ff} #legend .ma200{color:#9c27b0} #legend .rsi{color:#7e57c2}
#main{height:520px} #rsi{height:150px;border-top:1px solid var(--line)}
section{padding:14px 18px;border-top:1px solid var(--line)}
section h2{font-size:14px;margin:0 0 8px}
ul.notes{margin:0;padding-left:18px;color:var(--fg)} ul.notes li{margin:4px 0}
ol.ev{margin:0;padding:0;list-style:none} ol.ev li{margin:3px 0} ol.ev .tag{font-weight:700;margin-right:6px} ol.ev .when{color:var(--mut);font-size:12px;margin-left:8px}
.tw{overflow:auto;max-height:420px;border:1px solid var(--line);border-radius:6px}
table{border-collapse:collapse;font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
th,td{padding:4px 8px;text-align:right;border-bottom:1px solid var(--line)}
th{position:sticky;top:0;background:var(--card);text-align:right}
td:first-child,th:first-child{text-align:left}
tr.hit td{background:var(--hit);font-weight:600}
.links a{margin-right:14px}
a{color:var(--acc)}
footer{padding:10px 18px;color:var(--mut);font-size:12px;border-top:1px solid var(--line)}
details summary{cursor:pointer;font-weight:600;margin-bottom:8px}
</style>
</head>
<body>
<header>
  <h1>__TITLE__</h1>
  <span class="sub">__NAME__ · <a id="postlink" target="_blank" rel="noopener"></a></span>
</header>
<div class="bar">
  <button id="tf1d" class="on">일봉</button><button id="tf1h">1시간봉</button>
  <span style="width:10px"></span>
  <button id="goto">이벤트로 이동</button><button id="fit">전체 보기</button>
  <span style="width:10px"></span>
  <button id="tgMa" class="on">MA 20·50·200</button><button id="tgRsi" class="on">RSI 14</button><button id="tgVol" class="on">거래량</button>
  <span class="sp"></span>
  <span class="sub" id="range"></span>
  <button id="theme">테마</button>
</div>
<div id="wrap">
  <div id="legend"></div>
  <div id="main"></div>
  <div id="rsi"></div>
</div>
<section>
  <h2>이벤트 마커</h2>
  <ol class="ev">__EVENTS__</ol>
</section>
<section>
  <h2>무엇을 보는가</h2>
  <ul class="notes">__NOTES__</ul>
</section>
<section>
  <details open><summary>봉 데이터 — 일봉 (이벤트 앞뒤 세션)</summary>__TABLE_D__</details>
</section>
<section>
  <details><summary>봉 데이터 — 1시간봉 (매수일 세션 전후, KST/ET)</summary>__TABLE_H__</details>
  <p class="links">전체 데이터: <a href="__CSV_D__">일봉 CSV</a><a href="__CSV_H__">1시간봉 CSV</a></p>
</section>
<footer>시세 Yahoo Finance · 수집 __FETCHED__ · 차트 TradingView Lightweight Charts · 조작: 드래그 이동, 휠 확대/축소, 시간축 드래그로 봉 간격 조절</footer>
<script id="data" type="application/json">__DATA__</script>
<script>
(function(){
  var DATA = JSON.parse(document.getElementById('data').textContent);
  var POST = __POST__;
  var pl = document.getElementById('postlink'); pl.href = POST.url; pl.textContent = '「' + POST.title + '」 ' + POST.date + ' · ' + POST.board;
  var LWC = window.LightweightCharts;
  if (!LWC) { document.getElementById('main').innerHTML = '<p style="padding:20px">차트 라이브러리를 불러오지 못했습니다(인터넷 연결 필요). 아래 표와 CSV 는 그대로 볼 수 있습니다.</p>'; return; }

  var root = document.documentElement;
  var saved = null; try { saved = localStorage.getItem('sb-chart-theme'); } catch (e) {}
  if (saved === 'dark' || (!saved && matchMedia('(prefers-color-scheme: dark)').matches)) root.setAttribute('data-theme', 'dark');
  function dark() { return root.getAttribute('data-theme') === 'dark'; }
  function layout() {
    return { layout: { background: { type: 'solid', color: dark() ? '#131722' : '#fbfaf7' }, textColor: dark() ? '#d1d4dc' : '#1f1d1a' },
             grid: { vertLines: { color: dark() ? '#1f2431' : '#eeebe4' }, horzLines: { color: dark() ? '#1f2431' : '#eeebe4' } },
             crosshair: { mode: LWC.CrosshairMode.Normal },
             rightPriceScale: { borderColor: dark() ? '#2a2e39' : '#e4e0d8' },
             timeScale: { borderColor: dark() ? '#2a2e39' : '#e4e0d8', rightOffset: 6, barSpacing: 8 } };
  }

  function fmt(tz, ms) {
    var p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
    var o = {}; p.forEach(function (x) { o[x.type] = x.value; });
    return o.year + '-' + o.month + '-' + o.day + ' ' + (o.hour === '24' ? '00' : o.hour) + ':' + o.minute;
  }
  function n(x, p) { return x == null ? '–' : x.toLocaleString('ko-KR', { minimumFractionDigits: p, maximumFractionDigits: p }); }

  var TF = '1d';
  var mainEl = document.getElementById('main'), rsiEl = document.getElementById('rsi');
  var main = LWC.createChart(mainEl, Object.assign(layout(), { width: mainEl.clientWidth, height: 520 }));
  var rsi  = LWC.createChart(rsiEl,  Object.assign(layout(), { width: rsiEl.clientWidth,  height: 150 }));
  main.applyOptions({ timeScale: { visible: false } });
  rsi.applyOptions({ rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.1 } } });

  var candles = main.addCandlestickSeries({ upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350' });
  var vol = main.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
  main.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  var maOpt = function (c) { return { color: c, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }; };
  var ma20 = main.addLineSeries(maOpt('#f5a623')), ma50 = main.addLineSeries(maOpt('#2962ff')), ma200 = main.addLineSeries(maOpt('#9c27b0'));
  var rsiLine = rsi.addLineSeries({ color: '#7e57c2', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true });
  [30, 50, 70].forEach(function (v) { rsiLine.createPriceLine({ price: v, color: v === 50 ? '#8b8f9a' : '#ef5350', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' }); });

  var rows = [], byTime = {};
  function load(tf) {
    TF = tf; rows = DATA[tf]; byTime = {};
    var c = [], v = [], a = [], b = [], d = [], r = [];
    rows.forEach(function (x) {
      var t = x[0]; byTime[typeof t === 'string' ? t : String(t)] = x;
      c.push({ time: t, open: x[2], high: x[3], low: x[4], close: x[5] });
      v.push({ time: t, value: x[6], color: x[5] >= x[2] ? 'rgba(38,166,154,.45)' : 'rgba(239,83,80,.45)' });
      if (x[7] != null) a.push({ time: t, value: x[7] });
      if (x[8] != null) b.push({ time: t, value: x[8] });
      if (x[9] != null) d.push({ time: t, value: x[9] });
      if (x[10] != null) r.push({ time: t, value: x[10] });
    });
    candles.setData(c); vol.setData(v); ma20.setData(a); ma50.setData(b); ma200.setData(d); rsiLine.setData(r);
    candles.setMarkers(DATA.markers[tf]);
    var intraday = tf === '1h';
    [main, rsi].forEach(function (ch) { ch.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } }); });
    document.getElementById('tf1d').classList.toggle('on', tf === '1d');
    document.getElementById('tf1h').classList.toggle('on', tf === '1h');
    var first = rows[0], last = rows[rows.length - 1];
    document.getElementById('range').textContent = rows.length + '봉 · ' + label(first) + ' ~ ' + label(last);
    gotoEvent(); legend(last);
  }
  function label(x) {
    if (TF === '1d') return x[0];
    return fmt('Asia/Seoul', x[1] * 1000) + ' KST';
  }
  function legend(x) {
    if (!x) return;
    var chg = x[5] - x[2], pct = chg / x[2] * 100, cls = chg >= 0 ? 'u' : 'd';
    var when = TF === '1d' ? '<b>' + x[0] + '</b> <span style="color:var(--mut)">세션(ET 전일 18:00~당일 17:00)</span>'
             : '<b>' + fmt('Asia/Seoul', x[1] * 1000) + ' KST</b> <span style="color:var(--mut)">ET ' + fmt('America/New_York', x[1] * 1000) + '</span>';
    document.getElementById('legend').innerHTML = when +
      '<br>O <b>' + n(x[2], 2) + '</b> H <b>' + n(x[3], 2) + '</b> L <b>' + n(x[4], 2) + '</b> C <b class="' + cls + '">' + n(x[5], 2) + '</b> ' +
      '<span class="' + cls + '">' + (chg >= 0 ? '+' : '') + n(chg, 2) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)</span>' +
      ' Vol <b>' + n(x[6], 0) + '</b>' +
      '<br><span class="ma20">MA20 ' + n(x[7], 1) + '</span> <span class="ma50">MA50 ' + n(x[8], 1) + '</span> <span class="ma200">MA200 ' + n(x[9], 1) + '</span>' +
      ' <span class="rsi">RSI14 ' + n(x[10], 1) + '</span> ATR14 ' + n(x[11], 1);
  }
  function timeKey(t) { return typeof t === 'string' ? t : (t && t.year ? t.year + '-' + String(t.month).padStart(2, '0') + '-' + String(t.day).padStart(2, '0') : String(t)); }
  main.subscribeCrosshairMove(function (p) {
    var x = p.time != null ? byTime[timeKey(p.time)] : null;
    legend(x || rows[rows.length - 1]);
    try { if (p.time != null && x) rsi.setCrosshairPosition(x[10] == null ? 50 : x[10], p.time, rsiLine); else rsi.clearCrosshairPosition(); } catch (e) {}
  });
  rsi.subscribeCrosshairMove(function (p) {
    var x = p.time != null ? byTime[timeKey(p.time)] : null;
    legend(x || rows[rows.length - 1]);
    try { if (p.time != null && x) main.setCrosshairPosition(x[5], p.time, candles); else main.clearCrosshairPosition(); } catch (e) {}
  });
  var syncing = false;
  function sync(a, b) { a.timeScale().subscribeVisibleLogicalRangeChange(function (r) { if (syncing || !r) return; syncing = true; b.timeScale().setVisibleLogicalRange(r); syncing = false; }); }
  sync(main, rsi); sync(rsi, main);

  function eventIndex() {
    if (TF === '1d') { for (var i = 0; i < rows.length; i++) if (rows[i][0] >= DATA.event) return i; return rows.length - 1; }
    var t = DATA.eventUtc[1] || DATA.eventUtc[0];
    for (var j = 0; j < rows.length; j++) if (rows[j][1] >= t) return j; return rows.length - 1;
  }
  function gotoEvent() {
    var i = eventIndex(), before = TF === '1d' ? 70 : 60, after = TF === '1d' ? 30 : 60;
    main.timeScale().setVisibleLogicalRange({ from: i - before, to: i + after });
  }
  document.getElementById('goto').onclick = gotoEvent;
  document.getElementById('fit').onclick = function () { main.timeScale().fitContent(); };
  document.getElementById('tf1d').onclick = function () { load('1d'); };
  document.getElementById('tf1h').onclick = function () { load('1h'); };
  function toggle(id, fn) { var b = document.getElementById(id); b.onclick = function () { b.classList.toggle('on'); fn(b.classList.contains('on')); }; }
  toggle('tgMa', function (on) { [ma20, ma50, ma200].forEach(function (s) { s.applyOptions({ visible: on }); }); });
  toggle('tgVol', function (on) { vol.applyOptions({ visible: on }); });
  toggle('tgRsi', function (on) { rsiEl.style.display = on ? '' : 'none'; main.applyOptions({ timeScale: { visible: !on } }); resize(); });
  document.getElementById('theme').onclick = function () {
    if (dark()) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', 'dark');
    try { localStorage.setItem('sb-chart-theme', dark() ? 'dark' : 'light'); } catch (e) {}
    main.applyOptions(layout()); rsi.applyOptions(layout()); main.applyOptions({ timeScale: { visible: rsiEl.style.display === 'none' } });
  };
  function resize() { main.applyOptions({ width: mainEl.clientWidth }); rsi.applyOptions({ width: rsiEl.clientWidth }); }
  window.addEventListener('resize', resize);
  // 표는 스크롤 영역이라 이벤트 행이 접힌 아래에 숨는다 — 열릴 때 그 행이 보이게 맞춘다
  function showHit(tw) { var hit = tw.querySelector('tr.hit'); if (hit) tw.scrollTop = Math.max(0, hit.offsetTop - tw.clientHeight / 2); }
  document.querySelectorAll('.tw').forEach(showHit);
  document.querySelectorAll('details').forEach(function (d) { d.addEventListener('toggle', function () { if (d.open) d.querySelectorAll('.tw').forEach(showHit); }); });
  load('1d');
})();
</script>
</body>
</html>
'''

if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit('사용: python make_chart.py 차트/<이름>.json')
    main(sys.argv[1])
