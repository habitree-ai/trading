# -*- coding: utf-8 -*-
"""선배님 글의 시세 대조용 인터랙티브 차트 페이지 — 봉 데이터를 내장한 독립 HTML.

   실행: python _수집스크립트/make_chart.py 차트/2025-04-09_나스닥선물.json
         python _수집스크립트/make_chart.py --all          # 차트/*.json 전부 (앱 JS 를 고친 뒤)
   결과: 스펙과 같은 이름의 .html 과 _일봉.csv / _1시간봉.csv / (_15분봉.csv)
         스펙에 vol_index·options 가 있으면 변동성 지수와 옵션 이론가(Black-76) 표·CSV 까지.

   페이지 기능은 chart_app.js + chart_css.txt 한 벌이다 — 모든 차트 페이지가 같은 앱을 인라인하므로
   기능을 고치면 --all 로 재생성한다. 시간대(15분·1시간·4시간·일·주), 이동평균 추가/삭제(SMA/EMA·기간·색),
   볼린저 밴드, RSI, 거래량, 변동성 지수, 이벤트 마커(진입/정리/정보)·가격선·구간 음영, 로그 스케일, 전체화면.
   지표는 클라이언트가 계산하므로 기간을 바꿔도 재생성이 필요 없다(표·CSV 의 지표 열만 여기서 계산).

   시세는 Yahoo Finance v8 chart API — 이 PC 에서 실행한다(Claude 의 네트워크 경로는 막힌다).
   야후 제약: 1시간봉은 최근 730일, 15분봉은 최근 60일까지만. 4시간봉·주봉은 페이지가 합성한다.
   정리 문서에는 [링크](차트/이름.html) 로 건다(변환기가 HTML 태그를 이스케이프해 iframe 은 안 된다).
   공개 페이지(/blog)는 markdown.ts 가 그 링크를 /blog/charts/ 로 바꿔 route 로 서빙한다.

   스펙 필드
     symbol, name, title, post{title,board,date,url}, event_date
     daily{from}                 일봉 시작일 (끝은 오늘)
     hourly{from,to}             1시간봉 구간. 생략하면 사건이 730일 안일 때 자동(사건 -60일 ~ +120일)
     minutes15{from,to}          15분봉 구간. 생략하면 사건이 60일 안일 때 자동(사건 -5일 ~ +10일)
     table{daily_sessions | daily_from,daily_to ; hourly_from_utc,hourly_to_utc}
     session_note                범례에 보일 세션 설명 (예: "ET 전일 18:00~당일 17:00")
     price_decimals              가격 소수 자리 (기본 2, 원화는 0)
     view{"1d":[앞,뒤],"1h":[앞,뒤],...}  "이벤트로 이동" 때 보일 봉 수
     indicators{ma:[{type,n,color}], bb:{on,n,k}, rsi:{on,n}, volume, vx}   페이지 기본 지표
     events[{daily?, utc?, kind: entry|exit|info, pos, color, text, price?, label?, primary?}]
     zones[{from|from_utc, to|to_utc, label, color}]   구간 음영
     lines[{price, label, color}]                       가격선
     notes[]                     "무엇을 보는가"
     vol_index{symbol,name}      생략 가능 — 변동성 지수 창
     options{multiplier,rate,otm_pct,daily_asof_hours,notes}  생략 가능 — 옵션 이론가 (vol_index 필요)"""
import io, os, sys, json, csv, math, glob, datetime as dt, urllib.request, urllib.parse

try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')   # 윈도 콘솔(cp949)에서도 로그가 깨지지 않게
except Exception: pass
D = os.path.dirname(os.path.abspath(__file__)); R = os.path.dirname(D)
UTC = dt.timezone.utc
KST = dt.timezone(dt.timedelta(hours=9))

# 거래소 시간대 — main() 에서 야후 meta 로 채운다
EXCH = 'America/New_York'   # IANA 이름
GMTOFF = -4 * 3600          # 야후 meta.gmtoffset (지금 시점의 오프셋)
HAS_2TZ = True              # 거래소가 한국이 아니면 KST 와 현지 시각을 둘 다 보인다
LOC_ABBR = 'ET'
PDEC = 2

# ---------------- 시세 ----------------
class YahooError(Exception): pass

def fetch(symbol, interval, p1, p2):
    url = ('https://query2.finance.yahoo.com/v8/finance/chart/' + urllib.parse.quote(symbol)
           + f'?interval={interval}&period1={p1}&period2={p2}')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.load(r)['chart']
    except urllib.error.HTTPError as e:
        try: d = json.load(e)['chart']
        except Exception: raise YahooError(f'{symbol} {interval}: HTTP {e.code}')
    if d.get('error'):
        raise YahooError(f'{symbol} {interval}: {d["error"].get("description") or d["error"]}')
    res = d['result'][0]; q = res['indicators']['quote'][0]
    bars = []
    for i, t in enumerate(res['timestamp']):
        o, h, l, c, v = q['open'][i], q['high'][i], q['low'][i], q['close'][i], q['volume'][i]
        if None in (o, h, l, c):
            continue          # 거래 없는 시간대·결측
        bars.append([int(t), float(o), float(h), float(l), float(c), int(v or 0)])
    return bars, res['meta']

def epoch(iso):
    return int(dt.datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp())
def day_epoch(date_str):
    return epoch(date_str + 'T00:00:00Z')

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

def kst_dt(t): return dt.datetime.fromtimestamp(t, KST)
def et_dt(t):  return et(dt.datetime.fromtimestamp(t, UTC))
def loc_dt(t):
    """거래소 현지 시각. 뉴욕은 DST 규칙, 서울은 KST, 그 밖은 야후가 준 고정 오프셋."""
    if EXCH == 'America/New_York': return et_dt(t)
    if EXCH == 'Asia/Seoul': return kst_dt(t)
    return dt.datetime.fromtimestamp(t, dt.timezone(dt.timedelta(seconds=GMTOFF)))
def session_date(t):
    """야후 일봉 timestamp 는 거래소 현지 00:00(또는 개장 시각)이다 — 현지 날짜가 세션 날짜."""
    return dt.datetime.fromtimestamp(t + GMTOFF, UTC).date().isoformat()

# ---------------- 지표 (표·CSV 용. 종가 기준, Wilder) ----------------
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

# ---------------- 변동성 지수 붙이기 (표·CSV 용) ----------------
def attach_vx(bars, vxd, vxh, daily):
    if vxd is None:
        return [b + [None] for b in bars]
    if daily:
        byd = {session_date(b[0]): b[4] for b in vxd}
        return [b + [byd.get(session_date(b[0]))] for b in bars]
    src = sorted(vxh or vxd, key=lambda b: b[0]); j = -1; out = []
    for b in bars:
        while j + 1 < len(src) and src[j + 1][0] <= b[0]: j += 1
        out.append(b + [src[j][4] if j >= 0 else None])
    return out

# ---------------- 옵션 이론가 (Black-76, 변동성 지수를 IV 로) ----------------
def ncdf(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))
def b76(F, K, T, sig, r):
    if T <= 0 or sig <= 0: return max(F - K, 0.0), max(K - F, 0.0)
    v = sig * math.sqrt(T); d1 = (math.log(F / K) + v * v / 2) / v; d2 = d1 - v; df = math.exp(-r * T)
    return df * (F * ncdf(d1) - K * ncdf(d2)), df * (K * ncdf(-d2) - F * ncdf(-d1))
def third_friday(y, m):
    d = dt.date(y, m, 1); d += dt.timedelta(days=(4 - d.weekday()) % 7); return d + dt.timedelta(weeks=2)
def expiries(asof):
    fri = asof + dt.timedelta(days=(4 - asof.weekday()) % 7 or 7)
    y, m = asof.year, asof.month
    front = third_friday(y, m)
    if front <= asof:
        y, m = (y + 1, 1) if m == 12 else (y, m + 1); front = third_friday(y, m)
    y2, m2 = (y + 1, 1) if m == 12 else (y, m + 1)
    return fri, front, third_friday(y2, m2)
def option_row(F, vx, asof_dt, opt):
    sig, r = vx / 100.0, opt['rate']
    out = {}
    for key, ex in zip(('w', 'f', 'n'), expiries(loc_dt(int(asof_dt.timestamp())).date())):
        T = max((dt.datetime.combine(ex, dt.time(13, 30), UTC) - asof_dt).total_seconds(), 0.0) / 86400.0 / 365.0
        c, p = b76(F, F, T, sig, r)
        row = {'exp': ex.isoformat(), 'days': T * 365, 'call': c, 'put': p, 'straddle': c + p, 'straddle_pct': (c + p) / F * 100}
        for pct in opt['otm_pct']:
            k = int(round(pct * 100))
            row[f'put_otm{k}'] = b76(F, F * (1 - pct), T, sig, r)[1]
            row[f'call_otm{k}'] = b76(F, F * (1 + pct), T, sig, r)[0]
        out[key] = row
    return out

# ---------------- 표기 ----------------
def num(x, p=2):
    return '' if x is None else (f'{x:,.{p}f}' if p else f'{x:,.0f}')
def time_cells(t, daily):
    if daily: return [session_date(t)]
    cells = [kst_dt(t).strftime('%m-%d %H:%M')]
    if HAS_2TZ: cells.append(loc_dt(t).strftime('%m-%d %H:%M'))
    return cells
def time_head(daily):
    if daily: return ['세션(' + LOC_ABBR + ')']
    return ['KST'] + ([LOC_ABBR] if HAS_2TZ else [])

def write_csv(path, rows, daily):
    with io.open(path, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        head = ['session_date'] if daily else ['bar_start_utc', 'bar_start_kst'] + (['bar_start_local'] if HAS_2TZ else [])
        w.writerow(head + ['open', 'high', 'low', 'close', 'volume', 'ma20', 'ma50', 'ma200', 'rsi14', 'atr14', 'vol_index'])
        for b in rows:
            t = b[0]
            if daily: h = [session_date(t)]
            else:
                h = [dt.datetime.fromtimestamp(t, UTC).strftime('%Y-%m-%d %H:%M'), kst_dt(t).strftime('%Y-%m-%d %H:%M')]
                if HAS_2TZ: h.append(loc_dt(t).strftime('%Y-%m-%d %H:%M'))
            w.writerow(h + [b[1], b[2], b[3], b[4], b[5]] + ['' if x is None else x for x in b[6:]])

def table_html(rows, daily, event_daily, event_hours, has_vx):
    hd = time_head(daily) + ['시가', '고가', '저가', '종가', '등락', '거래량', 'MA20', 'MA50', 'MA200', 'RSI14', 'ATR14'] + (['VXN'] if has_vx else [])
    out = ['<div class="tw"><table><thead><tr>' + ''.join(f'<th>{h}</th>' for h in hd) + '</tr></thead><tbody>']
    for i, b in enumerate(rows):
        t = b[0]
        prev = rows[i - 1][4] if i else None
        chg = '' if prev is None else f'{(b[4] / prev - 1) * 100:+.2f}%'
        hit = (session_date(t) == event_daily) if daily else (t in event_hours)
        cells = time_cells(t, daily) + [num(b[1], PDEC), num(b[2], PDEC), num(b[3], PDEC), num(b[4], PDEC), chg, num(b[5], 0),
                                        num(b[6], PDEC), num(b[7], PDEC), num(b[8], PDEC), num(b[9], 1), num(b[10], PDEC)]
        if has_vx: cells.append(num(b[11], 1))
        cls = ' class="hit"' if hit else ''
        out.append(f'<tr{cls}>' + ''.join(f'<td>{c}</td>' for c in cells) + '</tr>')
    out.append('</tbody></table></div>')
    return ''.join(out)

def opt_rows(rows, daily, opt):
    out = []
    for b in rows:
        t, F, vx = b[0], b[4], b[11]
        if vx is None: continue
        asof = dt.datetime.fromtimestamp(t + (opt.get('daily_asof_hours', 17) * 3600 if daily else 0), UTC)
        out.append((b, asof, option_row(F, vx, asof, opt)))
    return out

def write_opt_csv(path, rows, daily, opt):
    keys = ['exp', 'days', 'call', 'put', 'straddle', 'straddle_pct'] + \
           [f'{s}_otm{int(round(p * 100))}' for p in opt['otm_pct'] for s in ('put', 'call')]
    with io.open(path, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        head = ['session_date', 'asof_utc'] if daily else ['bar_start_utc', 'bar_start_kst'] + (['bar_start_local'] if HAS_2TZ else [])
        w.writerow(head + ['underlying', 'vol_index'] + [f'{lab}_{k}' for lab in ('weekly', 'front', 'next') for k in keys])
        for b, asof, o in opt_rows(rows, daily, opt):
            if daily: h = [session_date(b[0]), asof.strftime('%Y-%m-%d %H:%M')]
            else:
                h = [dt.datetime.fromtimestamp(b[0], UTC).strftime('%Y-%m-%d %H:%M'), kst_dt(b[0]).strftime('%Y-%m-%d %H:%M')]
                if HAS_2TZ: h.append(loc_dt(b[0]).strftime('%Y-%m-%d %H:%M'))
            vals = []
            for lab in ('w', 'f', 'n'):
                vals += [o[lab][k] if k == 'exp' else round(o[lab][k], 2) for k in keys]
            w.writerow(h + [b[4], b[11]] + vals)

def opt_table_html(rows, daily, opt, event_daily, event_hours):
    hd = time_head(daily) + ['기초', 'VXN', '차월물 만기', 'T(일)', 'ATM 콜', 'ATM 풋', '스트래들', '스트래들 %', '1계약 $',
                             '5% OTM 풋', '10% OTM 풋', '5% OTM 콜', '근월물 스트래들 %', '주간 스트래들 %']
    out = ['<div class="tw"><table><thead><tr>' + ''.join(f'<th>{h}</th>' for h in hd) + '</tr></thead><tbody>']
    for b, asof, o in opt_rows(rows, daily, opt):
        t = b[0]; n_ = o['n']
        hit = (session_date(t) == event_daily) if daily else (t in event_hours)
        cells = time_cells(t, daily) + [num(b[4], PDEC), num(b[11], 1), n_['exp'][5:], f'{n_["days"]:.1f}', num(n_['call']), num(n_['put']),
                  num(n_['straddle']), f'{n_["straddle_pct"]:.1f}%', '$' + num(n_['straddle'] * opt['multiplier'], 0),
                  num(n_['put_otm5']), num(n_['put_otm10']), num(n_['call_otm5']),
                  f'{o["f"]["straddle_pct"]:.1f}%', f'{o["w"]["straddle_pct"]:.1f}%']
        cls = ' class="hit"' if hit else ''
        out.append(f'<tr{cls}>' + ''.join(f'<td>{c}</td>' for c in cells) + '</tr>')
    out.append('</tbody></table></div>')
    return ''.join(out)

# ---------------- 메인 ----------------
def rd(p): return io.open(os.path.join(D, p), encoding='utf-8').read()

def intraday_range(spec, key, max_days, before, after, today):
    """스펙에 구간이 있으면 그대로, 없으면 사건일 기준 자동. 야후 한도(max_days) 밖이면 None."""
    if spec.get(key):
        return day_epoch(spec[key]['from']), min(day_epoch(spec[key]['to']), today)
    ev = day_epoch(spec['event_date'])
    if ev < today - max_days * 86400: return None
    return max(ev - before * 86400, today - max_days * 86400 + 3600), min(ev + after * 86400, today)

def main(spec_path):
    global EXCH, GMTOFF, HAS_2TZ, LOC_ABBR, PDEC
    spec = json.load(io.open(spec_path, encoding='utf-8'))
    base = os.path.splitext(os.path.abspath(spec_path))[0]
    name = os.path.basename(base)
    now = int(dt.datetime.now(UTC).timestamp())
    PDEC = int(spec.get('price_decimals', 2))

    d1, meta = fetch(spec['symbol'], '1d', day_epoch(spec['daily']['from']), now)
    EXCH = meta.get('exchangeTimezoneName') or EXCH
    GMTOFF = int(meta.get('gmtoffset') or GMTOFF)
    HAS_2TZ = EXCH != 'Asia/Seoul'
    LOC_ABBR = 'ET' if EXCH == 'America/New_York' else ('KST' if EXCH == 'Asia/Seoul' else meta.get('timezone', EXCH))
    d1 = enrich(d1)
    log = [f'{spec["symbol"]} ({EXCH}) 일봉 {len(d1)}개 {session_date(d1[0][0])} ~ {session_date(d1[-1][0])}']

    h1, m15 = [], []
    rng = intraday_range(spec, 'hourly', 729, 60, 120, now)
    if rng:
        try:
            h1, _ = fetch(spec['symbol'], '1h', rng[0], rng[1]); h1 = enrich(h1)
            log.append(f'1시간봉 {len(h1)}개 {kst_dt(h1[0][0]):%Y-%m-%d %H:%M} ~ {kst_dt(h1[-1][0]):%Y-%m-%d %H:%M} KST')
        except YahooError as e: log.append('1시간봉 없음 — ' + str(e))
    else: log.append('1시간봉 없음 — 사건이 야후 한도(730일) 밖')
    rng = intraday_range(spec, 'minutes15', 59, 5, 10, now)
    if rng:
        try:
            m15, _ = fetch(spec['symbol'], '15m', rng[0], rng[1])
            log.append(f'15분봉 {len(m15)}개')
        except YahooError as e: log.append('15분봉 없음 — ' + str(e))
    else: log.append('15분봉 없음 — 사건이 야후 한도(60일) 밖')

    vi, opt = spec.get('vol_index'), spec.get('options')
    vxd = vxh = None
    if vi:
        vxd, _ = fetch(vi['symbol'], '1d', day_epoch(spec['daily']['from']), now)
        if h1:
            try: vxh, _ = fetch(vi['symbol'], '1h', h1[0][0] - 86400, h1[-1][0] + 86400)
            except YahooError: vxh = None
        log.append(f'{vi["symbol"]} 일봉 {len(vxd)}개 / 1시간봉 {len(vxh or [])}개')
    d1 = attach_vx(d1, vxd, None, True)
    h1 = attach_vx(h1, vxd, vxh, False)
    print(' / '.join(log))

    write_csv(base + '_일봉.csv', d1, True)
    if h1: write_csv(base + '_1시간봉.csv', h1, False)
    if m15:
        with io.open(base + '_15분봉.csv', 'w', encoding='utf-8-sig', newline='') as f:
            w = csv.writer(f); w.writerow(['bar_start_utc', 'bar_start_kst', 'open', 'high', 'low', 'close', 'volume'])
            for b in m15: w.writerow([dt.datetime.fromtimestamp(b[0], UTC).strftime('%Y-%m-%d %H:%M'), kst_dt(b[0]).strftime('%Y-%m-%d %H:%M')] + b[1:6])

    # 차트용 원봉 — 일봉은 세션 날짜 문자열, 인트라데이는 KST 벽시계로 보이도록 9시간 민 epoch
    tfs = {'1d': [[session_date(b[0]), b[0]] + b[1:6] for b in d1]}
    if h1: tfs['1h'] = [[b[0] + 9 * 3600, b[0]] + b[1:6] for b in h1]
    if m15: tfs['15m'] = [[b[0] + 9 * 3600, b[0]] + b[1:6] for b in m15]
    vx = None
    if vi:
        vx = {'name': vi['name'], '1d': [[session_date(b[0]), b[4]] for b in vxd], '1h': [[b[0], b[4]] for b in (vxh or [])]}

    hour_times = {b[0] for b in h1}
    def snap(t):
        t = t // 3600 * 3600
        while t not in hour_times and t > h1[0][0]: t -= 3600
        return t
    CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮'
    events, ev_hours = [], set()
    for k, e in enumerate(spec['events']):
        tag = CIRCLED[k] if k < len(CIRCLED) else str(k + 1)
        if e.get('utc'):
            u = epoch(e['utc']); when = f'KST {kst_dt(u):%Y-%m-%d %H:%M}' + (f' · {LOC_ABBR} {loc_dt(u):%m-%d %H:%M}' if HAS_2TZ else '')
            if h1: ev_hours.add(snap(u))
        else:
            when = f'{e["daily"]} 세션'
        events.append({'tag': tag, 'kind': e.get('kind', 'info'), 'pos': e.get('pos', 'below'), 'color': e.get('color', '#8b8f9a'),
                       'text': e['text'], 'when': when, 'daily': e.get('daily'), 'utc': epoch(e['utc']) if e.get('utc') else None,
                       'price': e.get('price'), 'label': e.get('label'), 'primary': bool(e.get('primary'))})
    if not any(x['primary'] for x in events) and events:
        # 기본 이동 대상: event_date 와 같은 날의 첫 이벤트, 없으면 첫 이벤트
        for x in events:
            if x['daily'] == spec['event_date'] or (x['utc'] and session_date(x['utc']) == spec['event_date']): x['primary'] = True; break
        else: events[0]['primary'] = True
    zones = []
    for z in spec.get('zones', []):
        zones.append({'from': z.get('from'), 'to': z.get('to'), 'from_utc': epoch(z['from_utc']) if z.get('from_utc') else None,
                      'to_utc': epoch(z['to_utc']) if z.get('to_utc') else None, 'label': z.get('label', ''), 'color': z.get('color')})

    ev = spec['event_date']
    tb = spec['table']
    if tb.get('daily_from'):
        tbl_d = [b for b in d1 if tb['daily_from'] <= session_date(b[0]) <= tb['daily_to']]
    else:
        idx = next(i for i, b in enumerate(d1) if session_date(b[0]) >= ev)
        nn = tb['daily_sessions']
        tbl_d = d1[max(0, idx - nn): idx + nn + 1]
    tbl_h = []
    if h1 and tb.get('hourly_from_utc'):
        tf_, tt = epoch(tb['hourly_from_utc']), epoch(tb['hourly_to_utc'])
        tbl_h = [b for b in h1 if tf_ <= b[0] <= tt]

    opt_section = ''
    if vi and opt:
        write_opt_csv(base + '_옵션이론가_일봉.csv', d1, True, opt)
        if tbl_h: write_opt_csv(base + '_옵션이론가_1시간봉.csv', tbl_h, False, opt)
        opt_section = (OPT_SECTION
                       .replace('__VXNAME__', vi['name'])
                       .replace('__OPT_NOTES__', ''.join(f'<li>{x}</li>' for x in opt['notes']))
                       .replace('__TABLE_OPT_D__', opt_table_html(tbl_d, True, opt, ev, set()))
                       .replace('__TABLE_OPT_H__', opt_table_html(tbl_h, False, opt, ev, ev_hours) if tbl_h else '')
                       .replace('__CSV_OD__', name + '_옵션이론가_일봉.csv').replace('__CSV_OH__', name + '_옵션이론가_1시간봉.csv'))

    zone_notes = ''.join(f'<li><span class="tag" style="color:{z["color"] or "#8b8f9a"}">▮</span>{z["label"]}'
                         f'<span class="when">{z["from"] or kst_dt(z["from_utc"]).strftime("KST %Y-%m-%d %H:%M")} ~ {z["to"] or kst_dt(z["to_utc"]).strftime("KST %Y-%m-%d %H:%M")}</span></li>'
                         for z in zones)
    data = {'name': name, 'post': spec['post'], 'tfs': tfs, 'vx': vx, 'events': events, 'zones': zones, 'lines': spec.get('lines', []),
            'indicators': spec.get('indicators'), 'view': spec.get('view'),
            'tz': EXCH, 'has2tz': HAS_2TZ, 'locAbbr': LOC_ABBR, 'pdec': PDEC, 'sessionNote': spec.get('session_note', ''), 'event': ev}
    hourly_tables = ''
    if tbl_h:
        hourly_tables = ('<details><summary>봉 데이터 — 1시간봉 (이벤트 전후' + (', KST/' + LOC_ABBR if HAS_2TZ else ', KST') + ')</summary>'
                         + table_html(tbl_h, False, ev, ev_hours, bool(vi)) + '</details>')
    csv_links = f'<a href="{name}_일봉.csv">일봉 CSV</a>' + (f'<a href="{name}_1시간봉.csv">1시간봉 CSV</a>' if h1 else '') + (f'<a href="{name}_15분봉.csv">15분봉 CSV</a>' if m15 else '')
    page = (TEMPLATE
            .replace('__CSS__', rd('chart_css.txt'))
            .replace('__APP__', rd('chart_app.js').replace('</', '<\\/'))
            .replace('__TITLE__', spec['title'])
            .replace('__NAME__', spec['name'])
            .replace('__NOTES__', ''.join(f'<li>{x}</li>' for x in spec['notes']))
            .replace('__ZONES__', zone_notes)
            .replace('__OPT_SECTION__', opt_section)
            .replace('__TABLE_D__', table_html(tbl_d, True, ev, set(), bool(vi)))
            .replace('__TABLE_H__', hourly_tables)
            .replace('__CSV_LINKS__', csv_links)
            .replace('__FETCHED__', dt.datetime.now(KST).strftime('%Y-%m-%d %H:%M KST'))
            .replace('__DATA__', json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')))
    io.open(base + '.html', 'w', encoding='utf-8').write(page)
    print(f'→ {os.path.relpath(base + ".html", R)}  ({len(page.encode("utf-8")) // 1024}KB)')

OPT_SECTION = r'''<section>
  <h2>옵션 가격 — "차월물 옵션가격 보면 화성에서 우주인 침공하나 싶다"</h2>
  <ul class="notes">__OPT_NOTES__</ul>
  <p class="sub" style="margin:10px 0 6px">__VXNAME__ 는 차트 맨 아래 창에 그대로 그렸다. 아래 표의 옵션 값은 그 VXN 으로 계산한 이론가다.</p>
  <details open><summary>옵션 이론가 — 일봉 (세션 마감 기준, 차월물 ATM·OTM)</summary>__TABLE_OPT_D__</details>
  <details><summary>옵션 이론가 — 1시간봉 (이벤트 세션 전후 · 야간은 전일 VXN 종가 사용)</summary>__TABLE_OPT_H__</details>
  <p class="links">전체 데이터: <a href="__CSV_OD__">옵션 이론가 일봉 CSV</a><a href="__CSV_OH__">옵션 이론가 1시간봉 CSV</a> (주간·근월·차월 셋 다 들어 있다)</p>
</section>
'''

TEMPLATE = r'''<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<script src="https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>
<style>
__CSS__
</style>
</head>
<body>
<header>
  <h1>__TITLE__</h1>
  <span class="sub">__NAME__ · <a id="postlink" target="_blank" rel="noopener"></a></span>
</header>
<div class="bar">
  <span class="grp" id="tfs"></span>
  <span style="width:8px"></span>
  <span class="grp"><button id="goto">이벤트로 이동</button><button id="fit">전체 보기</button></span>
  <span style="width:8px"></span>
  <span class="grp"><button id="tgInd">지표 ▾</button><button id="tgVx" class="on">VXN</button><button id="tgLog">로그</button><button id="full">전체화면</button></span>
  <span class="sp"></span>
  <span class="sub" id="range"></span>
  <button id="theme">테마</button>
</div>
<div id="wrap">
  <div id="legend"></div>
  <div id="indpanel" hidden></div>
  <div id="main"></div>
  <div id="rsi"></div>
  <div id="vx"></div>
</div>
<section>
  <h2>이벤트 마커 <span class="mut">— 목록을 누르면 그 자리로, 차트의 마커 봉을 누르면 목록이 밝아진다. ▲ 진입 · ▼ 정리 · ● 정보</span></h2>
  <ol class="ev" id="events"></ol>
  <ol class="ev">__ZONES__</ol>
</section>
<section>
  <h2>무엇을 보는가</h2>
  <ul class="notes">__NOTES__</ul>
</section>
__OPT_SECTION__<section>
  <details open><summary>봉 데이터 — 일봉 (이벤트 앞뒤 세션)</summary>__TABLE_D__</details>
</section>
<section>
  __TABLE_H__
  <p class="links">전체 데이터: __CSV_LINKS__</p>
</section>
<footer>시세 Yahoo Finance · 수집 __FETCHED__ · 차트 TradingView Lightweight Charts · 드래그 이동, 휠 확대/축소, 시간축 드래그로 봉 간격 조절 · 4시간봉·주봉은 1시간봉·일봉에서 합성 · 지표는 이 페이지가 계산</footer>
<script id="data" type="application/json">__DATA__</script>
<script>
__APP__
</script>
</body>
</html>
'''

if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit('사용: python make_chart.py 차트/<이름>.json | --all')
    if sys.argv[1] == '--all':
        for p in sorted(glob.glob(os.path.join(R, '차트', '*.json'))):
            if os.path.basename(p).startswith('_'): continue
            main(p)
    else:
        main(sys.argv[1])
