# -*- coding: utf-8 -*-
"""선배님 글의 시세 대조용 인터랙티브 차트 페이지 — 봉 데이터를 내장한 독립 HTML.

   실행: python _수집스크립트/make_chart.py 차트/2025-04-09_나스닥선물.json
   결과: 스펙과 같은 이름의 .html (lightweight-charts, 일봉/1시간봉 전환, MA20/50/200·RSI14·거래량,
         이벤트 마커, 십자선 범례, 봉 데이터 표) 과 _일봉.csv / _1시간봉.csv.
         스펙에 vol_index·options 가 있으면 변동성 지수 창과 옵션 이론가(Black-76) 표·CSV 까지.

   시세는 Yahoo Finance v8 chart API 에서 받는다 — 이 PC 에서 실행한다(Claude 의 네트워크 경로는 막힌다).
   1시간봉은 야후가 최근 730일까지만 준다. 정리 문서에는 [링크](차트/이름.html) 로 건다 — 두 마크다운
   변환기(md2html.py·markdown.ts)가 HTML 태그를 이스케이프하므로 iframe 내장은 안 된다.
   공개 페이지(/blog)는 markdown.ts 가 그 링크를 /blog/charts/ 로 바꿔 route 로 서빙한다.

   스펙 필드
     symbol, name, title, post{title,board,date,url}, event_date
     daily{from}                 일봉 시작일 (끝은 오늘)
     hourly{from,to}             생략하면 1시간봉 없음
     table{daily_sessions | daily_from,daily_to ; hourly_from_utc,hourly_to_utc}
     session_note                범례에 보일 세션 설명 (예: "ET 전일 18:00~당일 17:00")
     view{"1d":[앞,뒤],"1h":[앞,뒤]}  "이벤트로 이동" 때 보일 봉 수 (기본 일봉 70/30, 1시간봉 60/60)
     price_decimals              가격 소수 자리 (기본 2, 원화는 0)
     events[{daily?, utc?, pos, color, text}]
     notes[]                     "무엇을 보는가"
     vol_index{symbol,name}      생략 가능 — 변동성 지수 창
     options{multiplier,rate,otm_pct,daily_asof_hours,notes}  생략 가능 — 옵션 이론가 (vol_index 필요)"""
import io, os, sys, json, csv, math, datetime as dt, urllib.request, urllib.parse

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
def fetch(symbol, interval, p1, p2):
    url = ('https://query2.finance.yahoo.com/v8/finance/chart/' + urllib.parse.quote(symbol)
           + f'?interval={interval}&period1={p1}&period2={p2}')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)['chart']
    if d.get('error'):
        raise SystemExit(f'yahoo {symbol} {interval}: {d["error"]}')
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

# ---------------- 변동성 지수 붙이기 ----------------
def attach_vx(bars, vxd, vxh, daily):
    """각 봉에 변동성 지수를 붙인다. 일봉은 같은 세션 날짜의 종가, 1시간봉은 그 시각 이전 마지막 봉의 종가
       (VXN 은 미국 정규장에만 산출되므로 야간 봉에는 전일 종가가 이어진다). 지수가 없으면 None."""
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
    """주간(다음 금요일) · 근월물(이달 3째 금요일, 지났으면 다음 달) · 차월물(그다음 달 3째 금요일)"""
    fri = asof + dt.timedelta(days=(4 - asof.weekday()) % 7 or 7)
    y, m = asof.year, asof.month
    front = third_friday(y, m)
    if front <= asof:
        y, m = (y + 1, 1) if m == 12 else (y, m + 1); front = third_friday(y, m)
    y2, m2 = (y + 1, 1) if m == 12 else (y, m + 1)
    return fri, front, third_friday(y2, m2)
def option_row(F, vx, asof_dt, opt):
    """asof_dt: 평가 시각(UTC). 만기는 현지 09:30 기준(미국 지수옵션). 키 w/f/n = 주간/근월/차월."""
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
    """표·CSV 공용. 일봉은 세션 마감(봉 시각 + daily_asof_hours) 기준, 1시간봉은 봉 시작 시각 기준으로 평가."""
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
def main(spec_path):
    global EXCH, GMTOFF, HAS_2TZ, LOC_ABBR, PDEC
    spec = json.load(io.open(spec_path, encoding='utf-8'))
    base = os.path.splitext(os.path.abspath(spec_path))[0]
    name = os.path.basename(base)
    now = int(dt.datetime.now(UTC).timestamp())
    PDEC = int(spec.get('price_decimals', 2))

    d1, meta = fetch(spec['symbol'], '1d', epoch(spec['daily']['from'] + 'T00:00:00Z'), now)
    EXCH = meta.get('exchangeTimezoneName') or EXCH
    GMTOFF = int(meta.get('gmtoffset') or GMTOFF)
    HAS_2TZ = EXCH != 'Asia/Seoul'
    LOC_ABBR = 'ET' if EXCH == 'America/New_York' else ('KST' if EXCH == 'Asia/Seoul' else meta.get('timezone', EXCH))
    d1 = enrich(d1)
    h1 = []
    if spec.get('hourly'):
        h1, _ = fetch(spec['symbol'], '1h', epoch(spec['hourly']['from'] + 'T00:00:00Z'), epoch(spec['hourly']['to'] + 'T00:00:00Z'))
        h1 = enrich(h1)
    print(f'{spec["symbol"]} ({EXCH}) 일봉 {len(d1)}개 {session_date(d1[0][0])} ~ {session_date(d1[-1][0])}'
          + (f' / 1시간봉 {len(h1)}개 {kst_dt(h1[0][0]):%Y-%m-%d %H:%M} ~ {kst_dt(h1[-1][0]):%Y-%m-%d %H:%M} KST' if h1 else ' / 1시간봉 없음'))

    # 변동성 지수 — 있으면 일봉 전 구간 + 1시간봉 구간(미국 정규장만 나온다)
    vi, opt = spec.get('vol_index'), spec.get('options')
    vxd = vxh = None
    if vi:
        vxd, _ = fetch(vi['symbol'], '1d', epoch(spec['daily']['from'] + 'T00:00:00Z'), now)
        if spec.get('hourly'):
            vxh, _ = fetch(vi['symbol'], '1h', epoch(spec['hourly']['from'] + 'T00:00:00Z'), epoch(spec['hourly']['to'] + 'T00:00:00Z'))
        print(f'{vi["symbol"]} 일봉 {len(vxd)}개 / 1시간봉 {len(vxh or [])}개')
    d1 = attach_vx(d1, vxd, None, True)
    h1 = attach_vx(h1, vxd, vxh, False)

    write_csv(base + '_일봉.csv', d1, True)
    if h1: write_csv(base + '_1시간봉.csv', h1, False)

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
            u = epoch(e['utc']); when = f'KST {kst_dt(u):%Y-%m-%d %H:%M}' + (f' · {LOC_ABBR} {loc_dt(u):%m-%d %H:%M}' if HAS_2TZ else '')
        else:
            when = f'{e["daily"]} 세션'
        ev_list.append(f'<li><span class="tag" style="color:{e["color"]}">{tag}</span>{e["text"]}<span class="when">{when}</span></li>')
        if e.get('daily'):
            md.append(dict(m, time=e['daily']))
        if e.get('utc') and h1:
            t = snap(epoch(e['utc'])); ev_hours.add(t)
            mh.append(dict(m, time=t + 9 * 3600))
    mh.sort(key=lambda x: x['time'])

    ev = spec['event_date']
    tb = spec['table']
    if tb.get('daily_from'):
        tbl_d = [b for b in d1 if tb['daily_from'] <= session_date(b[0]) <= tb['daily_to']]
    else:
        idx = next(i for i, b in enumerate(d1) if session_date(b[0]) >= ev)
        n = tb['daily_sessions']
        tbl_d = d1[max(0, idx - n): idx + n + 1]
    tbl_h = []
    if h1:
        tf, tt = epoch(tb['hourly_from_utc']), epoch(tb['hourly_to_utc'])
        tbl_h = [b for b in h1 if tf <= b[0] <= tt]

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

    data = {'1d': daily_rows, '1h': hour_rows, 'markers': {'1d': md, '1h': mh},
            'vxName': vi['name'] if vi else None, 'tz': EXCH, 'has2tz': HAS_2TZ, 'locAbbr': LOC_ABBR, 'pdec': PDEC,
            'sessionNote': spec.get('session_note', ''),
            'view': spec.get('view'),   # {"1d":[앞 봉 수, 뒤 봉 수], "1h":[..]} — "이벤트로 이동" 기본 범위
            'event': ev, 'eventUtc': [epoch(e['utc']) for e in spec['events'] if e.get('utc')]}
    hourly_tables = ''
    if h1:
        hourly_tables = ('<details><summary>봉 데이터 — 1시간봉 (이벤트 전후' + (', KST/' + LOC_ABBR if HAS_2TZ else ', KST') + ')</summary>'
                         + table_html(tbl_h, False, ev, ev_hours, bool(vi)) + '</details>')
    page = (TEMPLATE
            .replace('__TITLE__', spec['title'])
            .replace('__NAME__', spec['name'])
            .replace('__POST__', json.dumps(spec['post'], ensure_ascii=False))
            .replace('__NOTES__', ''.join(f'<li>{x}</li>' for x in spec['notes']))
            .replace('__EVENTS__', ''.join(ev_list))
            .replace('__OPT_SECTION__', opt_section)
            .replace('__TABLE_D__', table_html(tbl_d, True, ev, set(), bool(vi)))
            .replace('__TABLE_H__', hourly_tables)
            .replace('__CSV_D__', name + '_일봉.csv')
            .replace('__CSV_H__', ('<a href="' + name + '_1시간봉.csv">1시간봉 CSV</a>') if h1 else '')
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
#legend .ma20{color:#f5a623} #legend .ma50{color:#2962ff} #legend .ma200{color:#9c27b0} #legend .rsi{color:#7e57c2} #legend .vx{color:#ff7043}
#main{height:520px} #rsi{height:150px;border-top:1px solid var(--line)} #vx{height:130px;border-top:1px solid var(--line)}
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
  <button id="tgMa" class="on">MA 20·50·200</button><button id="tgRsi" class="on">RSI 14</button><button id="tgVol" class="on">거래량</button><button id="tgVx" class="on">VXN</button>
  <span class="sp"></span>
  <span class="sub" id="range"></span>
  <button id="theme">테마</button>
</div>
<div id="wrap">
  <div id="legend"></div>
  <div id="main"></div>
  <div id="rsi"></div>
  <div id="vx"></div>
</div>
<section>
  <h2>이벤트 마커</h2>
  <ol class="ev">__EVENTS__</ol>
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
  <p class="links">전체 데이터: <a href="__CSV_D__">일봉 CSV</a>__CSV_H__</p>
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
  var PD = DATA.pdec;
  function n(x, p) { return x == null ? '–' : x.toLocaleString('ko-KR', { minimumFractionDigits: p, maximumFractionDigits: p }); }

  var TF = '1d';
  var mainEl = document.getElementById('main'), rsiEl = document.getElementById('rsi'), vxEl = document.getElementById('vx');
  var main = LWC.createChart(mainEl, Object.assign(layout(), { width: mainEl.clientWidth, height: 520 }));
  var rsi  = LWC.createChart(rsiEl,  Object.assign(layout(), { width: rsiEl.clientWidth,  height: 150 }));
  var vx   = LWC.createChart(vxEl,   Object.assign(layout(), { width: vxEl.clientWidth,   height: 130 }));
  rsi.applyOptions({ rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.1 } } });
  vx.applyOptions({ rightPriceScale: { scaleMargins: { top: 0.15, bottom: 0.05 } } });
  var vxLine = vx.addAreaSeries({ lineColor: '#ff7043', topColor: 'rgba(255,112,67,.35)', bottomColor: 'rgba(255,112,67,.02)', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true, title: 'VXN' });
  if (!DATA.vxName) { vxEl.style.display = 'none'; document.getElementById('tgVx').style.display = 'none'; }
  if (!DATA['1h'].length) { document.getElementById('tf1h').style.display = 'none'; }
  // 시간축은 보이는 창 중 맨 아래 하나에만
  function axes() {
    var vOn = vxEl.style.display !== 'none', rOn = rsiEl.style.display !== 'none';
    main.applyOptions({ timeScale: { visible: !rOn && !vOn } });
    rsi.applyOptions({ timeScale: { visible: rOn && !vOn } });
    vx.applyOptions({ timeScale: { visible: vOn } });
  }
  axes();

  var candles = main.addCandlestickSeries({ upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350', priceFormat: { type: 'price', precision: PD, minMove: PD ? Math.pow(10, -PD) : 1 } });
  var vol = main.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
  main.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  var maOpt = function (c) { return { color: c, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }; };
  var ma20 = main.addLineSeries(maOpt('#f5a623')), ma50 = main.addLineSeries(maOpt('#2962ff')), ma200 = main.addLineSeries(maOpt('#9c27b0'));
  var rsiLine = rsi.addLineSeries({ color: '#7e57c2', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true });
  [30, 50, 70].forEach(function (v) { rsiLine.createPriceLine({ price: v, color: v === 50 ? '#8b8f9a' : '#ef5350', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' }); });

  var rows = [], byTime = {};
  function load(tf) {
    TF = tf; rows = DATA[tf]; byTime = {};
    var c = [], v = [], a = [], b = [], d = [], r = [], q = [];
    rows.forEach(function (x) {
      var t = x[0]; byTime[typeof t === 'string' ? t : String(t)] = x;
      c.push({ time: t, open: x[2], high: x[3], low: x[4], close: x[5] });
      v.push({ time: t, value: x[6], color: x[5] >= x[2] ? 'rgba(38,166,154,.45)' : 'rgba(239,83,80,.45)' });
      if (x[7] != null) a.push({ time: t, value: x[7] });
      if (x[8] != null) b.push({ time: t, value: x[8] });
      if (x[9] != null) d.push({ time: t, value: x[9] });
      if (x[10] != null) r.push({ time: t, value: x[10] });
      if (x[12] != null) q.push({ time: t, value: x[12] });
    });
    candles.setData(c); vol.setData(v); ma20.setData(a); ma50.setData(b); ma200.setData(d); rsiLine.setData(r); vxLine.setData(q);
    candles.setMarkers(DATA.markers[tf]);
    var intraday = tf === '1h';
    [main, rsi, vx].forEach(function (ch) { ch.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } }); });
    document.getElementById('tf1d').classList.toggle('on', tf === '1d');
    document.getElementById('tf1h').classList.toggle('on', tf === '1h');
    var first = rows[0], last = rows[rows.length - 1];
    document.getElementById('range').textContent = rows.length + '봉 · ' + label(first) + ' ~ ' + label(last) + (intraday ? ' KST' : '');
    // setData 직후엔 각 창이 자기 범위 변경(마지막 봉 보기)을 내보내 동기화로 덮어쓴다 — 한 틱 뒤에 이동
    setTimeout(gotoEvent, 50); legend(last);
  }
  function label(x) {
    if (TF === '1d') return x[0];
    return fmt('Asia/Seoul', x[1] * 1000).slice(5);
  }
  function legend(x) {
    if (!x) return;
    var chg = x[5] - x[2], pct = chg / x[2] * 100, cls = chg >= 0 ? 'u' : 'd';
    var when = TF === '1d' ? '<b>' + x[0] + '</b> <span style="color:var(--mut)">세션' + (DATA.sessionNote ? '(' + DATA.sessionNote + ')' : '') + '</span>'
             : '<b>' + fmt('Asia/Seoul', x[1] * 1000) + ' KST</b>' + (DATA.has2tz ? ' <span style="color:var(--mut)">' + DATA.locAbbr + ' ' + fmt(DATA.tz, x[1] * 1000) + '</span>' : '');
    document.getElementById('legend').innerHTML = when +
      '<br>O <b>' + n(x[2], PD) + '</b> H <b>' + n(x[3], PD) + '</b> L <b>' + n(x[4], PD) + '</b> C <b class="' + cls + '">' + n(x[5], PD) + '</b> ' +
      '<span class="' + cls + '">' + (chg >= 0 ? '+' : '') + n(chg, PD) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)</span>' +
      ' Vol <b>' + n(x[6], 0) + '</b>' +
      '<br><span class="ma20">MA20 ' + n(x[7], PD) + '</span> <span class="ma50">MA50 ' + n(x[8], PD) + '</span> <span class="ma200">MA200 ' + n(x[9], PD) + '</span>' +
      ' <span class="rsi">RSI14 ' + n(x[10], 1) + '</span> ATR14 ' + n(x[11], PD) + (DATA.vxName ? ' <span class="vx">VXN ' + n(x[12], 1) + '</span>' : '');
  }
  function timeKey(t) { return typeof t === 'string' ? t : (t && t.year ? t.year + '-' + String(t.month).padStart(2, '0') + '-' + String(t.day).padStart(2, '0') : String(t)); }
  var charts = [main, rsi, vx];
  function onMove(src) {
    return function (p) {
      var x = p.time != null ? byTime[timeKey(p.time)] : null;
      legend(x || rows[rows.length - 1]);
      var targets = [[main, candles, x && x[5]], [rsi, rsiLine, x && (x[10] == null ? 50 : x[10])], [vx, vxLine, x && x[12]]];
      targets.forEach(function (t) {
        if (t[0] === src) return;
        try { if (p.time != null && x && t[2] != null) t[0].setCrosshairPosition(t[2], p.time, t[1]); else t[0].clearCrosshairPosition(); } catch (e) {}
      });
    };
  }
  charts.forEach(function (ch) { ch.subscribeCrosshairMove(onMove(ch)); });
  var syncing = false;
  charts.forEach(function (a) {
    a.timeScale().subscribeVisibleLogicalRangeChange(function (r) {
      if (syncing || !r) return; syncing = true;
      charts.forEach(function (b) { if (b !== a) b.timeScale().setVisibleLogicalRange(r); });
      syncing = false;
    });
  });

  function eventIndex() {
    if (TF === '1d') { for (var i = 0; i < rows.length; i++) if (rows[i][0] >= DATA.event) return i; return rows.length - 1; }
    var t = DATA.eventUtc[1] || DATA.eventUtc[0];
    for (var j = 0; j < rows.length; j++) if (rows[j][1] >= t) return j; return rows.length - 1;
  }
  function gotoEvent() {
    var i = eventIndex(), v = (DATA.view && DATA.view[TF]) || (TF === '1d' ? [70, 30] : [60, 60]);
    main.timeScale().setVisibleLogicalRange({ from: i - v[0], to: i + v[1] });
  }
  document.getElementById('goto').onclick = gotoEvent;
  document.getElementById('fit').onclick = function () { main.timeScale().fitContent(); };
  document.getElementById('tf1d').onclick = function () { load('1d'); };
  document.getElementById('tf1h').onclick = function () { load('1h'); };
  function toggle(id, fn) { var b = document.getElementById(id); b.onclick = function () { b.classList.toggle('on'); fn(b.classList.contains('on')); }; }
  toggle('tgMa', function (on) { [ma20, ma50, ma200].forEach(function (s) { s.applyOptions({ visible: on }); }); });
  toggle('tgVol', function (on) { vol.applyOptions({ visible: on }); });
  toggle('tgRsi', function (on) { rsiEl.style.display = on ? '' : 'none'; axes(); resize(); });
  toggle('tgVx', function (on) { vxEl.style.display = on ? '' : 'none'; axes(); resize(); });
  document.getElementById('theme').onclick = function () {
    if (dark()) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', 'dark');
    try { localStorage.setItem('sb-chart-theme', dark() ? 'dark' : 'light'); } catch (e) {}
    charts.forEach(function (ch) { ch.applyOptions(layout()); }); axes();
  };
  function resize() { main.applyOptions({ width: mainEl.clientWidth }); rsi.applyOptions({ width: rsiEl.clientWidth }); vx.applyOptions({ width: vxEl.clientWidth }); }
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
