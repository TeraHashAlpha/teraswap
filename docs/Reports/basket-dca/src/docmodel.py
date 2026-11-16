"""Minimal document model rendered to Markdown (repo) and HTML (report page)."""
import re, html, pandas as pd, numpy as np

class Doc:
    def __init__(self): self.blocks = []
    def h1(self, t): self.blocks.append(('h1', t))
    def h2(self, t, anchor=None): self.blocks.append(('h2', t, anchor))
    def h3(self, t): self.blocks.append(('h3', t))
    def p(self, t): self.blocks.append(('p', t))
    def ul(self, items): self.blocks.append(('ul', items))
    def ol(self, items): self.blocks.append(('ol', items))
    def callout(self, t, kind='note'): self.blocks.append(('callout', t, kind))
    def table(self, headers, rows, caption=None, num_cols=None): self.blocks.append(('table', headers, rows, caption, num_cols))
    def chart(self, name, caption): self.blocks.append(('chart', name, caption))
    def answers(self, items): self.blocks.append(('answers', items))
    def code(self, t): self.blocks.append(('code', t))
    def hr(self): self.blocks.append(('hr',))

def md_inline(t): return t
def html_inline(t):
    t = html.escape(t, quote=False)
    t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'`([^`]+)`', r'<code>\1</code>', t)
    t = re.sub(r'\[([^\]]+)\]\(#([^)]+)\)', r'<a href="#\2">\1</a>', t)
    t = re.sub(r'\[([^\]]+)\]\((https?://[^)]+)\)', r'<a href="\2" target="_blank" rel="noopener">\1</a>', t)
    return t

def to_md(doc, chart_dir='charts'):
    out = []
    for b in doc.blocks:
        k = b[0]
        if k == 'h1': out.append(f'# {b[1]}\n')
        elif k == 'h2': out.append(f'\n## {b[1]}\n')
        elif k == 'h3': out.append(f'\n### {b[1]}\n')
        elif k == 'p': out.append(b[1] + '\n')
        elif k == 'ul': out.append('\n'.join(f'- {x}' for x in b[1]) + '\n')
        elif k == 'ol': out.append('\n'.join(f'{i+1}. {x}' for i, x in enumerate(b[1])) + '\n')
        elif k == 'callout': out.append('\n'.join('> ' + l for l in b[1].split('\n')) + '\n')
        elif k == 'code': out.append('```\n' + b[1] + '\n```\n')
        elif k == 'hr': out.append('---\n')
        elif k == 'chart': out.append(f'![{b[2]}]({chart_dir}/{b[1]}.svg)\n\n*{b[2]}* — dados: [`{chart_dir}/{b[1]}.csv`]({chart_dir}/{b[1]}.csv)\n')
        elif k == 'answers':
            for i, it in enumerate(b[1]):
                if len(it) == 3: n_, q, a = it; out.append(f'**{n_} — {q}**\n\n{a}\n'); continue
                q, a = it
                out.append(f'**({["i","ii","iii","iv","v","vi","vii","viii"][i]}) {q}**\n\n{a}\n')
        elif k == 'table':
            _, headers, rows, cap, _n = b
            if cap: out.append(f'*{cap}*\n')
            out.append('| ' + ' | '.join(headers) + ' |')
            out.append('|' + '|'.join('---' for _ in headers) + '|')
            for r in rows: out.append('| ' + ' | '.join(str(x).replace('|', '/') for x in r) + ' |')
            out.append('')
    return '\n'.join(out)

def to_html_body(doc, svgs):
    out = []; toc = []
    for b in doc.blocks:
        k = b[0]
        if k == 'h1': continue
        elif k == 'h2':
            a = b[2] or re.sub(r'[^a-z0-9]+', '-', b[1].lower()).strip('-')
            toc.append((a, b[1])); out.append(f'<h2 id="{a}">{html_inline(b[1])}</h2>')
        elif k == 'h3': out.append(f'<h3>{html_inline(b[1])}</h3>')
        elif k == 'p': out.append(f'<p>{html_inline(b[1])}</p>')
        elif k == 'ul': out.append('<ul>' + ''.join(f'<li>{html_inline(x)}</li>' for x in b[1]) + '</ul>')
        elif k == 'ol': out.append('<ol>' + ''.join(f'<li>{html_inline(x)}</li>' for x in b[1]) + '</ol>')
        elif k == 'callout': out.append(f'<aside class="callout {b[2]}">' + ''.join(f'<p>{html_inline(l)}</p>' for l in b[1].split('\n') if l.strip()) + '</aside>')
        elif k == 'code': out.append(f'<pre><code>{html.escape(b[1])}</code></pre>')
        elif k == 'hr': out.append('<hr>')
        elif k == 'chart':
            out.append(f'<figure class="chart">{svgs.get(b[1], "")}<figcaption>{html_inline(b[2])} <span class="src">Dados: charts/{b[1]}.csv</span></figcaption></figure>')
        elif k == 'answers':
            out.append('<div class="answers">')
            for i, it in enumerate(b[1]):
                n_, q, a = it if len(it) == 3 else (["i","ii","iii","iv","v","vi","vii","viii"][i],) + tuple(it)
                out.append(f'<section class="answer"><div class="num">{n_}</div><div class="ans-body"><h3>{html_inline(q)}</h3><p>{html_inline(a)}</p></div></section>')
            out.append('</div>')
        elif k == 'table':
            _, headers, rows, cap, num = b
            num = set(num or [])
            t = ['<div class="tablewrap"><table>']
            if cap: t.append(f'<caption>{html_inline(cap)}</caption>')
            t.append('<thead><tr>' + ''.join(f'<th class="{"num" if i in num else ""}">{html_inline(str(h))}</th>' for i, h in enumerate(headers)) + '</tr></thead><tbody>')
            for r in rows:
                t.append('<tr>' + ''.join(f'<td class="{"num" if i in num else ""}">{html_inline(str(x))}</td>' for i, x in enumerate(r)) + '</tr>')
            t.append('</tbody></table></div>'); out.append(''.join(t))
    return '\n'.join(out), toc
