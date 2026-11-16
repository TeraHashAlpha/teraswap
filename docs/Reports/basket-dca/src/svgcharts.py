"""Tiny dependency-free SVG chart kit (dataviz method: thin marks, hairline solid grid,
2px lines, >=8px markers, 4px rounded bar ends, one y-axis per panel, native <title>
tooltips on every mark, colours as CSS custom properties with light-mode fallbacks so the
same SVG works standalone (repo / GitHub) and inline in the HTML report (dark mode)."""
import math, html, datetime as dt
PT_M = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
import numpy as np

COL = {  # role -> (css var, light fallback)  validated: validate_palette.js (light+dark, all-pairs, 3 slots)
    's1': ('--s1', '#2a78d6'), 's2': ('--s2', '#eb6834'), 's3': ('--s3', '#1baf7a'),
    's4': ('--s4', '#6250d6'), 'ink': ('--ink', '#0b0b0b'), 'ink2': ('--ink2', '#52514e'),
    'muted': ('--muted', '#898781'), 'grid': ('--grid', '#e1e0d9'), 'axis': ('--axis', '#c3c2b7'),
    'surface': ('--surface', '#fcfcfb'), 'neutral': ('--neutral', '#898781'),
    'seq1': ('--seq1', '#cde2fb'), 'seq7': ('--seq7', '#0d366b'), 'crit': ('--crit', '#d03b3b'),
    'shade': ('--shade', 'rgba(208,59,59,0.10)'),
}
def c(role): v, f = COL[role]; return f'var({v},{f})'
def esc(s): return html.escape(str(s), quote=True)
FONT = 'system-ui,-apple-system,Segoe UI,sans-serif'

def nice_ticks(lo, hi, n=5):
    if hi == lo: hi = lo + 1
    span = hi - lo; step = 10 ** math.floor(math.log10(span / n))
    for m in (1, 2, 2.5, 5, 10):
        if span / (step * m) <= n: step *= m; break
    a = math.floor(lo / step) * step; b = math.ceil(hi / step) * step
    t = []; x = a
    while x <= b + step * 1e-9: t.append(round(x, 10)); x += step
    return t

def fmt_num(v, unit=''):
    return _fmt_num(v, unit).replace('.', ',').replace('-', '−')
def _fmt_num(v, unit=''):
    if abs(v) >= 10000: s = f'{v/1000:,.0f}K'
    elif abs(v) >= 1000: s = f'{v:,.0f}'
    elif abs(v) >= 100: s = f'{v:,.0f}'
    elif abs(v) >= 1: s = f'{v:,.2f}'.rstrip('0').rstrip('.')
    else: s = f'{v:.3f}'.rstrip('0').rstrip('.')
    return (s + unit).replace(',', ' ')

class Panel:
    """One plot area with one y-axis. x is numeric (dates converted to ordinal days)."""
    def __init__(self, x0, y0, w, h, xlim, ylim, ylabel='', yunit='', xdates=True, yticks=None, xticks=None):
        self.x0, self.y0, self.w, self.h = x0, y0, w, h
        self.xlim, self.ylim = xlim, ylim; self.ylabel = ylabel; self.yunit = yunit
        self.xdates = xdates; self.items = []; self.yticks = yticks; self.xticks = xticks
    def X(self, x): return self.x0 + (x - self.xlim[0]) / (self.xlim[1] - self.xlim[0] or 1) * self.w
    def Y(self, y): return self.y0 + self.h - (y - self.ylim[0]) / (self.ylim[1] - self.ylim[0] or 1) * self.h
    def frame(self, show_x=True):
        o = []
        yt = self.yticks or nice_ticks(*self.ylim)
        for t in yt:
            if t < self.ylim[0] - 1e-9 or t > self.ylim[1] + 1e-9: continue
            y = self.Y(t)
            o.append(f'<line x1="{self.x0}" x2="{self.x0+self.w}" y1="{y:.1f}" y2="{y:.1f}" style="stroke:{c("grid")}" stroke-width="1"/>')
            lab = self.ytick_fmt(t) if getattr(self, 'ytick_fmt', None) else fmt_num(t, self.yunit)
            o.append(f'<text x="{self.x0-8}" y="{y+4:.1f}" text-anchor="end" font-size="11" style="fill:{c("muted")};font-variant-numeric:tabular-nums">{esc(lab)}</text>')
        o.append(f'<line x1="{self.x0}" x2="{self.x0+self.w}" y1="{self.y0+self.h}" y2="{self.y0+self.h}" style="stroke:{c("axis")}" stroke-width="1"/>')
        if self.ylabel:
            o.append(f'<text x="{self.x0}" y="{self.y0-8}" font-size="11" style="fill:{c("ink2")}">{esc(self.ylabel)}</text>')
        if show_x:
            xt = self.xticks if self.xticks is not None else self._auto_xticks()
            for x, lab in xt:
                X = self.X(x)
                o.append(f'<line x1="{X:.1f}" x2="{X:.1f}" y1="{self.y0+self.h}" y2="{self.y0+self.h+4}" style="stroke:{c("axis")}"/>')
                o.append(f'<text x="{X:.1f}" y="{self.y0+self.h+17}" text-anchor="middle" font-size="11" style="fill:{c("muted")}">{esc(lab)}</text>')
        return o
    def _auto_xticks(self):
        a, b = self.xlim
        if not self.xdates:
            return [(t, fmt_num(t)) for t in nice_ticks(a, b, 6) if a <= t <= b]
        span = b - a; out = []
        d0 = dt.date.fromordinal(int(a)); d1 = dt.date.fromordinal(int(b))
        step = 1 if span <= 14 else 7 if span <= 60 else 14 if span <= 120 else 30 if span <= 400 else 90
        if step >= 30:
            d = dt.date(d0.year, d0.month, 1)
            while d <= d1:
                if d >= d0: out.append((d.toordinal(), f'{PT_M[d.month-1]} {d.year % 100:02d}'))
                m = d.month - 1 + (step // 30); d = dt.date(d.year + m // 12, m % 12 + 1, 1)
        else:
            d = d0
            while d <= d1:
                out.append((d.toordinal(), f'{d.day} {PT_M[d.month-1]}')); d += dt.timedelta(days=step)
        return out
    def line(self, xs, ys, role, name, width=2, tip_fmt=None, dash=None, opacity=1):
        pts = [(self.X(x), self.Y(y)) for x, y in zip(xs, ys) if y is not None and not (isinstance(y, float) and math.isnan(y))]
        if not pts: return []
        d = 'M' + ' L'.join(f'{a:.1f},{b:.1f}' for a, b in pts)
        o = [f'<path d="{d}" fill="none" style="stroke:{c(role)}" stroke-width="{width}" stroke-linejoin="round" stroke-linecap="round" opacity="{opacity}"/>']
        if tip_fmt:   # invisible hit targets carrying the tooltip (>= 24px wide band)
            for x, y in zip(xs, ys):
                if y is None or (isinstance(y, float) and math.isnan(y)): continue
                o.append(f'<circle cx="{self.X(x):.1f}" cy="{self.Y(y):.1f}" r="7" fill="transparent"><title>{esc(tip_fmt(x, y))}</title></circle>')
        return o
    def hline(self, y, role='crit', label=None):
        Y = self.Y(y)
        o = [f'<line x1="{self.x0}" x2="{self.x0+self.w}" y1="{Y:.1f}" y2="{Y:.1f}" style="stroke:{c(role)}" stroke-width="1.5"/>']
        if label:
            ly = Y + 14 if Y - self.y0 < 18 else Y - 5
            o.append(f'<text x="{self.x0+self.w}" y="{ly:.1f}" text-anchor="end" font-size="11" style="fill:{c("ink2")}">{esc(label)}</text>')
        return o
    def span(self, xa, xb, title=None):
        return [f'<rect x="{self.X(xa):.1f}" y="{self.y0}" width="{max(1,self.X(xb)-self.X(xa)):.1f}" height="{self.h}" style="fill:{c("shade")}">' + (f'<title>{esc(title)}</title>' if title else '') + '</rect>']
    def dot(self, x, y, role, r=4.5, title=None, hollow=False):
        fill = c('surface') if hollow else c(role)
        return [f'<circle cx="{self.X(x):.1f}" cy="{self.Y(y):.1f}" r="{r}" style="fill:{fill};stroke:{c("surface") if not hollow else c(role)}" stroke-width="2">' + (f'<title>{esc(title)}</title>' if title else '') + '</circle>']

def bar_path(x, y_top, w, y_base, r=4):
    """Column with a 4px rounded data-end, square at the baseline (grows up or down)."""
    h = y_base - y_top
    if abs(h) < 0.5: return ''
    r = min(r, abs(h), w / 2)
    if h > 0:
        return (f'M{x:.1f},{y_base:.1f} L{x:.1f},{y_top+r:.1f} Q{x:.1f},{y_top:.1f} {x+r:.1f},{y_top:.1f} '
                f'L{x+w-r:.1f},{y_top:.1f} Q{x+w:.1f},{y_top:.1f} {x+w:.1f},{y_top+r:.1f} L{x+w:.1f},{y_base:.1f} Z')
    return f'M{x:.1f},{y_base:.1f} L{x+w:.1f},{y_base:.1f} L{x+w:.1f},{y_top:.1f} L{x:.1f},{y_top:.1f} Z'

def legend(items, x, y):
    """items: [(role, label, kind)] kind in line|dot|box"""
    o = []; cx = x
    for role, label, kind in items:
        if kind == 'line':
            o.append(f'<line x1="{cx}" x2="{cx+16}" y1="{y}" y2="{y}" style="stroke:{c(role)}" stroke-width="2.5" stroke-linecap="round"/>'); dx = 22
        elif kind == 'hollow':
            o.append(f'<circle cx="{cx+5}" cy="{y}" r="4.5" style="fill:{c("surface")};stroke:{c(role)}" stroke-width="2"/>'); dx = 15
        else:
            o.append(f'<rect x="{cx}" y="{y-5}" width="10" height="10" rx="2" style="fill:{c(role)}"/>'); dx = 15
        o.append(f'<text x="{cx+dx}" y="{y+4}" font-size="12" style="fill:{c("ink2")}">{esc(label)}</text>')
        cx += dx + 8 + 6.6 * len(label) + 14
    return o

def svg(w, h, body, title, desc=''):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" '
            f'font-family="{FONT}" style="max-width:100%;height:auto;background:{c("surface")}">'
            f'<title>{esc(title)}</title><desc>{esc(desc)}</desc>' + ''.join(body) + '</svg>')

def header(title, subtitle, w):
    o = [f'<text x="16" y="24" font-size="15" font-weight="600" style="fill:{c("ink")}">{esc(title)}</text>']
    if subtitle:
        for k, line in enumerate(subtitle if isinstance(subtitle, list) else [subtitle]):
            o.append(f'<text x="16" y="{44 + 16*k}" font-size="12" style="fill:{c("ink2")}">{esc(line)}</text>')
    return o
