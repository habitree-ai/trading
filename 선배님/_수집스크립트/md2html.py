# -*- coding: utf-8 -*-
"""마크다운 → HTML 변환기 (이 아카이브의 문서 형식에 맞춘 최소 구현)"""
import re, html as H

def _inline(s):
    s = H.escape(s, quote=False)
    s = re.sub(r'`([^`]+)`', lambda m: '<code>'+m.group(1)+'</code>', s)
    s = re.sub(r'\[([^\]]+)\]\(([^)\s]+)\)', r'<a href="\2" target="_blank" rel="noopener">\1</a>', s)
    s = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', s)
    s = re.sub(r'(?<![\w*])\*([^*\n]+)\*(?![\w*])', r'<em>\1</em>', s)
    return s

def _slug(t, used):
    s = re.sub(r'[^\w가-힣]+', '-', t).strip('-').lower() or 'h'
    b, i = s, 2
    while s in used:
        s = f'{b}-{i}'; i += 1
    used.add(s); return s

def convert(md):
    lines = md.split('\n')
    out, toc, used = [], [], set()
    i, n = 0, len(lines)
    para = []
    def flush():
        if para:
            out.append('<p>' + '<br>'.join(_inline(x) for x in para) + '</p>')
            para.clear()
    while i < n:
        ln = lines[i]
        st = ln.strip()
        # 코드펜스
        if st.startswith('```'):
            flush(); i += 1; buf = []
            while i < n and not lines[i].strip().startswith('```'):
                buf.append(H.escape(lines[i])); i += 1
            i += 1
            out.append('<pre><code>' + '\n'.join(buf) + '</code></pre>')
            continue
        # 헤딩
        m = re.match(r'^(#{1,4})\s+(.*)$', st)
        if m:
            flush()
            lv = len(m.group(1)); txt = m.group(2).strip()
            sid = _slug(txt, used)
            out.append(f'<h{lv} id="{sid}">{_inline(txt)}</h{lv}>')
            if lv <= 3: toc.append((lv, txt, sid))
            i += 1; continue
        # 구분선
        if re.match(r'^(-{3,}|\*{3,})$', st):
            flush(); out.append('<hr>'); i += 1; continue
        # 표
        if st.startswith('|') and i + 1 < n and re.match(r'^\|[\s:\-\|]+\|$', lines[i+1].strip()):
            flush()
            def cells(r): return [c.strip() for c in r.strip().strip('|').split('|')]
            head = cells(ln)
            aligns = []
            for c in cells(lines[i+1]):
                aligns.append('right' if c.endswith(':') and not c.startswith(':')
                              else 'center' if c.startswith(':') and c.endswith(':') else 'left')
            i += 2; rows = []
            while i < n and lines[i].strip().startswith('|'):
                rows.append(cells(lines[i])); i += 1
            t = ['<div class="tw"><table><thead><tr>']
            for j, c in enumerate(head):
                a = aligns[j] if j < len(aligns) else 'left'
                t.append(f'<th style="text-align:{a}">{_inline(c)}</th>')
            t.append('</tr></thead><tbody>')
            for r in rows:
                t.append('<tr>')
                for j, c in enumerate(r):
                    a = aligns[j] if j < len(aligns) else 'left'
                    t.append(f'<td style="text-align:{a}">{_inline(c)}</td>')
                t.append('</tr>')
            t.append('</tbody></table></div>')
            out.append(''.join(t)); continue
        # 인용
        if st.startswith('>'):
            flush(); buf = []
            while i < n and lines[i].strip().startswith('>'):
                buf.append(lines[i].strip().lstrip('>').strip()); i += 1
            out.append('<blockquote>' + '<br>'.join(_inline(x) for x in buf if x) + '</blockquote>')
            continue
        # 리스트
        m = re.match(r'^(\s*)([-*]|\d+\.)\s+(.*)$', ln)
        if m:
            flush()
            ordered = bool(re.match(r'^\d+\.$', m.group(2)))
            tag = 'ol' if ordered else 'ul'
            items = []
            while i < n:
                mm = re.match(r'^(\s*)([-*]|\d+\.)\s+(.*)$', lines[i])
                if not mm: break
                items.append(mm.group(3)); i += 1
                # 이어지는 들여쓴 줄은 같은 항목에 붙임
                while i < n and lines[i].strip() and not re.match(r'^(\s*)([-*]|\d+\.)\s+', lines[i]) \
                      and lines[i].startswith('  ') and not lines[i].strip().startswith('|'):
                    items[-1] += ' ' + lines[i].strip(); i += 1
            out.append(f'<{tag}>' + ''.join('<li>' + _inline(x) + '</li>' for x in items) + f'</{tag}>')
            continue
        # 빈 줄 / 본문
        if not st:
            flush(); i += 1; continue
        para.append(st); i += 1
    flush()
    return '\n'.join(out), toc
