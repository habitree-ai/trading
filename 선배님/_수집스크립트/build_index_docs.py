# -*- coding: utf-8 -*-
"""정리 문서 3종을 해석 없는 색인으로 생성한다.

  게시판별정리.md   게시판 → 연도 → 글 (인덱스.csv)
  투자철학정리.md   방법론 주제어 → 글 (본문 문자열 검색)
  종목테마별정리.md 종목·시장 주제어 → 글 (본문 문자열 검색)

입력은 인덱스.csv · 아카이브/**.md · 차트/*.json 뿐이다. 주제어 표기는 아래 CONFIG 에 있다 —
원문이 실제로 쓰는 표기만 넣는다(0건인 표기는 뺀다). 새 글이 들어오면 이 스크립트를 돌리고
build_all.py 로 투자철학.html 을 다시 만든다.
"""
import csv, io, os, re, glob, json, collections, datetime

S = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TODAY = datetime.date.today().isoformat()

# 게시판: 아카이브 폴더 번호 순. indexName 은 인덱스.csv 게시판 열(NBSP 를 공백으로 바꾼 뒤) 값.
BOARDS = [
    ('01', '27년 초대장.', '27년 초대장.', ''),
    ('02', '턱걸이', '턱걸이', ''),
    ('03', 'Trend following', 'Trend following', ''),
    ('04', '단상 (斷想 )', '단상 (斷想 )', ''),
    ('05', '후배들에게', '후배들에게', ''),
    ('06', 'all in', 'all in', ''),
    ('07', '매매일지', '매매일지', ''),
    ('08', '트레이딩', '트레이딩', ''),
    ('09', '옛글 모음', '옛글 모음', ''),
    ('10', '열대어', '열대어', ''),
    ('11', '음악,영화,책.etc', '음악,영화,책.etc', ''),
    ('12', '낙서장', '낙서장', ''),
    ('13', '좋은 글', '좋은 글', ''),
    ('14', '끄적끄적', '끄적끄적', ''),
    ('15', '포토로그', '포토로그', ''),
    ('18', '여행 스케치', '포토로그 > 여행 스케치', '포토로그'),
    ('20', '벼리와 강탄이', '벼리와 강탄이', ''),
    ('21', '질문에 대한 생각.', '질문에 대한 생각.', ''),
    ('22', '작심삼일', '작심삼일', ''),
]

BRACKET_NOTE = '> 제목의 반각 대괄호 `[ ]` 는 링크 문법과 겹쳐 전각 `［ ］` 로 적었다(「[공유] …」 5편).'

# 주제어 그룹: (이름, 표기들, 목록 기준 최소 언급 횟수, 주석). 기준이 1이면 한 번이라도 나온 글 전부,
# 그 이상이면 제목에 표기가 있거나 본문 언급이 기준 이상인 글만 목록에 올린다.
PHILOSOPHY = {
    'title': '투자철학 정리 — 방법론 주제어 색인',
    'intro': [
        '> 투자 방법론 주제어가 본문에 나오는 글을 767편 전문에서 **기계적으로** 뽑은 색인이다. 요약·해석은 없다 — 무엇을 읽고 무엇을 남길지는 내 생각 노트(`/blog`)에서 정한다.',
        '> 규칙: 표기를 본문·제목에서 부분 문자열로 센다(대소문자 무시). 목록에는 **제목에 표기가 있거나 본문 언급이 기준 횟수 이상**인 글만 올리고, 표기가 한 번이라도 나온 글 수는 표의 「글 수」에 적는다. 한 글이 여러 주제에 오를 수 있다.',
        '> 표기는 원문이 실제로 쓰는 말만 골랐다 — 「정지선」「백테스트」「이탈선」은 원문에 없어 빼고, 「생명선」「마지노선」「과최적화」「전진분석」처럼 원문이 쓰는 말로 잡았다.',
        BRACKET_NOTE,
        '> 게시판별 글 목록은 `게시판별정리.md`, 종목·시장 주제어는 `종목테마별정리.md`.',
    ],
    'sections': [
        ('방법론 주제어', '', [
            ('심리·기질', ['심리', '기질'], 3, '투자와 무관한 일반적 뜻으로도 자주 쓰이는 말이다.'),
            ('확신·아집·조급', ['확신', '아집', '조급'], 3, '「확신」은 일반어라 주제와 무관한 용례도 섞인다.'),
            ('인내·절제', ['인내', '절제'], 3, ''),
            ('공포', ['공포'], 3, ''),
            ('목계·평정심', ['목계', '평정심'], 1, '「木鷄」 한자 병기는 「목계」와 같은 글에만 나와 따로 세지 않는다.'),
            ('손익비·승률', ['손익비', '승률'], 1, ''),
            ('자금관리·리스크·생명선', ['자금관리', '자금 관리', '리스크', '생명선', '마지노선', '널빤지'], 3, '「마지노선」은 투자와 무관한 용례가 소수 있다.'),
            ('손절', ['손절'], 3, '「손절매」「손절선」도 이 표기에 포함된다.'),
            ('레버리지·올인·신용·미수', ['레버리지', '올인', '신용', '미수'], 3, '영문 「all in」은 게시판 이름이라 글 하단 카테고리 표기에 반복돼 세지 않는다. 「미수」는 짧아 다른 말(재미수준 등)도 잡힌다.'),
            ('물타기·불타기', ['물타기', '불타기'], 1, ''),
            ('추세·이동평균', ['추세', '이동평균', '이평선', '120일선', '정배열', '역배열'], 3, '「추세추종」은 「추세」에 포함된다.'),
            ('시스템 트레이딩·성배·MDD', ['시스템 트레이딩', '시스템트레이딩', '성배', '과최적화', '전진분석', 'MDD'], 3, ''),
            ('복리', ['복리'], 3, ''),
            ('오답·정답', ['오답', '정답'], 3, ''),
            ('복기', ['복기'], 1, ''),
            ('파산', ['파산'], 3, ''),
            ('앵커링', ['앵커링'], 1, ''),
            ('재량 매매', ['재량'], 1, ''),
            ('보조지표·거래량·수급', ['보조지표', '볼린저', 'RSI', '거래량', '수급'], 3, ''),
            ('전업', ['전업'], 3, '투자 외 직업 맥락이 소수 섞인다.'),
        ]),
    ],
}

THEMES = {
    'title': '종목·테마별 정리 — 종목·시장 주제어 색인',
    'intro': [
        '> 종목 이름과 시장·상품·제도 주제어가 본문에 나오는 글을 767편 전문에서 **기계적으로** 뽑은 색인이다. 요약·해석은 없다 — 무엇을 읽고 무엇을 남길지는 내 생각 노트(`/blog`)에서 정한다.',
        '> 규칙: 표기를 본문·제목에서 부분 문자열로 센다(대소문자 무시). 종목은 한 번이라도 나온 글을 전부 올리고, 시장·상품 주제어 중 빈도가 높은 것은 **제목에 표기가 있거나 본문 언급이 기준 횟수 이상**인 글만 올린다. 표기가 한 번이라도 나온 글 수는 표의 「글 수」에 적는다.',
        '> 표기는 원문이 실제로 쓰는 형태다 — 「SK하이닉스」는 원문에 없고 늘 「하이닉스」, 「삼양」만 쓰면 별개 회사 삼양사가 섞여 「삼양식품」으로 잡았다.',
        BRACKET_NOTE,
        '> 방법론 주제어는 `투자철학정리.md`, 게시판별 글 목록은 `게시판별정리.md`.',
    ],
    'sections': [
        ('종목', '언급 1회 이상 전부.', [
            ('삼성전자', ['삼성전자'], 1, ''),
            ('SK하이닉스', ['하이닉스'], 1, ''),
            ('삼양식품', ['삼양식품'], 1, ''),
            ('와이지엔터테인먼트', ['와이지', 'YG'], 1, ''),
            ('파크시스템스', ['파크시스템'], 1, ''),
            ('알테오젠', ['알테오젠'], 1, ''),
            ('보로노이', ['보로노이'], 1, ''),
            ('메리츠금융지주', ['메리츠'], 1, ''),
            ('삼천리자전거', ['삼천리'], 1, ''),
            ('테슬라', ['테슬라'], 1, ''),
            ('애플', ['애플'], 1, '2007-12-10 글의 「애플」은 블로그 닉네임이다.'),
            ('SBS', ['SBS'], 1, ''),
            ('SK바이오팜', ['바이오팜'], 1, ''),
            ('유한양행', ['유한양행'], 1, ''),
            ('DN오토모티브', ['오토모티브'], 1, ''),
            ('위메이드·위믹스', ['위메이드', '위믹스'], 1, ''),
            ('LIG넥스원', ['넥스원'], 1, ''),
            ('한맥증권', ['한맥증권'], 1, ''),
            ('SK텔레콤', ['SK텔레콤'], 1, ''),
            ('포스코', ['포스코'], 1, ''),
            ('두산', ['두산'], 1, ''),
        ]),
        ('시장·상품·제도', '', [
            ('선물', ['선물'], 3, '「선물(先物)」과 「선물(膳物)」이 같이 잡힌다 — 턱걸이 게시판의 글은 대개 후자다.'),
            ('옵션', ['옵션'], 3, ''),
            ('파생', ['파생'], 3, ''),
            ('가치투자', ['가치투자'], 3, ''),
            ('코스닥', ['코스닥'], 1, ''),
            ('코스피·종합지수', ['코스피', '종합지수'], 1, ''),
            ('나스닥', ['나스닥'], 1, ''),
            ('코인', ['코인'], 1, '「비트코인」도 이 표기에 포함된다.'),
            ('공매도', ['공매도'], 1, ''),
            ('금투세', ['금투세'], 1, ''),
            ('2차전지', ['2차전지'], 1, ''),
            ('인버스·곱버스', ['인버스', '곱버스'], 1, ''),
            ('ETF', ['ETF'], 1, ''),
        ]),
    ],
}


def nb(s):
    return s.replace(' ', ' ').strip()


def slug(t):
    """md2html._slug 와 같은 규칙. 문서 안에서 헤딩 텍스트가 유일하다고 가정한다."""
    return re.sub(r'[^\w가-힣]+', '-', t).strip('-').lower() or 'h'


def esc(s):
    return s.replace('|', '\\|')


# ---------- 색인 ----------
rows = list(csv.DictReader(io.open(os.path.join(S, '인덱스.csv'), encoding='utf-8-sig')))
for r in rows:
    r['게시판'] = nb(r['게시판'])
    r['logNo'] = r['원문URL'].rstrip('/').rsplit('/', 1)[-1]
    md = io.open(os.path.join(S, r['MD파일']), encoding='utf-8').read()
    if md.startswith('---'):
        j = md.find('\n---', 3)
        md = md[j + 4:] if j > 0 else md
    r['bodyl'] = md.lower()
    r['titlel'] = r['제목'].lower()
rows.sort(key=lambda r: (r['날짜'], int(r['번호'])))
N = len(rows)
D0, D1 = rows[0]['날짜'], rows[-1]['날짜']

charts = collections.defaultdict(list)
for f in sorted(glob.glob(os.path.join(S, '차트', '*.json'))):
    d = json.load(io.open(f, encoding='utf-8'))
    charts[d['post']['url']].append(os.path.splitext(os.path.basename(f))[0])


def title_cell(r):
    # md2html 의 링크 정규식은 링크 글자 안의 ']' 를 못 넘긴다
    t = r['제목'].replace('[', '［').replace(']', '］')
    return f"[{t}]({r['원문URL']})"


def chart_cell(r):
    return ' · '.join(f"[{n}](차트/{n}.html)" for n in charts.get(r['원문URL'], []))


def period(lst):
    return f"{lst[0]['날짜']} ~ {lst[-1]['날짜']}" if len(lst) > 1 else lst[0]['날짜']


# ---------- 1) 게시판별 ----------
def build_boards():
    by_board = collections.defaultdict(list)
    for r in rows:
        by_board[r['게시판']].append(r)
    boards = []
    for no, name, index_name, parent in BOARDS:
        lst = by_board.pop(index_name, [])
        if not lst:
            continue
        sub = f' (「{parent}」 하위)' if parent else ''
        head = f'{no}. {name}{sub} — {len(lst)}편 ({period(lst)})'
        boards.append((no, name, sub, lst, head))
    if by_board:
        raise SystemExit(f'BOARDS 에 없는 게시판: {list(by_board)}')

    out = ['# 게시판별 정리 — 선배님 블로그(pillion21)\n',
           f'> 블로그의 게시판 순서와 이름 그대로, 글 {N}편({D0} ~ {D1})을 **게시판 → 연도 → 글** 순으로 늘어놓은 색인이다.',
           '> 요약·해석은 없다. 원문은 제목의 네이버 링크로 연다. logNo 는 내 생각 노트의 `post_id` 와 같은 글 번호다.',
           f'> `인덱스.csv` 에서 스크립트로 생성 ({TODAY}). 시세 대조 차트가 있는 글은 차트 열에 링크가 있다.',
           BRACKET_NOTE + '\n',
           '---\n', '## 게시판 한눈에\n', '| # | 게시판 | 편수 | 기간 |', '|---|---|---:|---|']
    for no, name, sub, lst, head in boards:
        out.append(f'| {no} | [{name}{sub}](#{slug(head)}) | {len(lst)} | {period(lst)} |')
    out += [f'\n합계 {N}편.\n', '---\n']
    for no, name, sub, lst, head in boards:
        out.append(f'# {head}\n')
        by_year = collections.OrderedDict()
        for r in lst:
            by_year.setdefault(r['날짜'][:4], []).append(r)
        for y, yl in by_year.items():
            out += [f'## {y} — {len(yl)}편\n', '| 날짜 | 제목 | 글자수 | logNo | 차트 |', '|---|---|---:|---|---|']
            for r in yl:
                out.append(f"| {r['날짜']} | {esc(title_cell(r))} | {r['글자수']} | {r['logNo']} | {chart_cell(r)} |")
            out.append('')
        out.append('---\n')
    out.append(f'*{TODAY} 생성 · 원문 {N}편 · 결손 이미지는 `선배님/결손목록.md`*')
    return '\n'.join(out) + '\n'


# ---------- 2·3) 주제어 색인 ----------
def count_hits(r, kws):
    return sum(r['bodyl'].count(k.lower()) for k in kws)


def in_title(r, kws):
    return any(k.lower() in r['titlel'] for k in kws)


def build_keyword_doc(cfg):
    groups = []
    n = 0
    for heading, rule, gs in cfg['sections']:
        for name, kws, mn, note in gs:
            n += 1
            hits = [(r, c) for r in rows for c in [count_hits(r, kws)] if c]
            listed = [(r, c) for r, c in hits if c >= mn or in_title(r, kws)]
            head = f'{n}. {name} — {len(hits)}편 (목록 {len(listed)}편)'
            crit = '1회 이상' if mn <= 1 else f'제목 또는 {mn}회 이상'
            groups.append(dict(n=n, name=name, kws=kws, note=note, hits=hits, listed=listed, head=head, crit=crit, heading=heading, rule=rule))

    out = [f"# {cfg['title']}\n"] + cfg['intro'] + ['', '---\n', '## 주제어 한눈에\n',
           '| # | 주제 | 표기 | 글 수 | 목록 기준 | 목록 | 첫 글 | 마지막 글 |', '|---|---|---|---:|---|---:|---|---|']
    for g in groups:
        first = g['hits'][0][0]['날짜'] if g['hits'] else '—'
        last = g['hits'][-1][0]['날짜'] if g['hits'] else '—'
        out.append(f"| {g['n']} | [{g['name']}](#{slug(g['head'])}) | {' · '.join(g['kws'])} | {len(g['hits'])} | {g['crit']} | {len(g['listed'])} | {first} | {last} |")
    out += ['', '---\n']
    cur = None
    for g in groups:
        if g['heading'] != cur:
            if cur is not None:
                out.append('---\n')
            cur = g['heading']
            out.append(f'# {cur}\n')
            if g['rule']:
                out.append(g['rule'] + '\n')
        out += [f"## {g['head']}\n", f"표기: {' · '.join('`' + k + '`' for k in g['kws'])} · 목록 기준: {g['crit']}\n"]
        if g['note']:
            out.append(f"> {g['note']}\n")
        if not g['listed']:
            out.append('(목록 기준에 드는 글 없음)\n')
            continue
        out += ['| 날짜 | 게시판 | 제목 | 언급 | logNo |', '|---|---|---|---:|---|']
        for r, c in g['listed']:
            out.append(f"| {r['날짜']} | {esc(r['게시판'])} | {esc(title_cell(r))} | {c} | {r['logNo']} |")
        out.append('')
    out += ['---\n', f'*{TODAY} 생성 · 본문 {N}편 전문 문자열 검색 · 같은 글이 여러 주제에 오를 수 있다*']
    return '\n'.join(out) + '\n'


if __name__ == '__main__':
    docs = {
        '게시판별정리.md': build_boards(),
        '투자철학정리.md': build_keyword_doc(PHILOSOPHY),
        '종목테마별정리.md': build_keyword_doc(THEMES),
    }
    for fn, txt in docs.items():
        io.open(os.path.join(S, fn), 'w', encoding='utf-8', newline='\n').write(txt)
        print(f'{fn} {len(txt.encode("utf-8")) // 1024} KB, {txt.count(chr(10))} lines')
