"""v3 charts G1-G3 (same kit and palette as v2; CSV of exactly what is drawn beside each SVG)."""
import os, numpy as np, pandas as pd, datetime as dt
from svgcharts import Panel, svg, header, legend, bar_path, c, esc, fmt_num, nice_ticks
from charts import save, LEG_ROLE, o

def g1_k_cap(panels, thr=0.25):
    """panels: list of (label, t3 rows) — one k x cap grid per basket group, stacked."""
    ks, caps = [1, 3, 5, 10], [0.0, 0.10, 0.20, 0.33]
    W, cw, ch = 920, 150, 46; block = 40 + len(ks) * ch + 24
    H = 120 + len(panels) * block + 20
    body = header('Maior compra única no modo suave, por k × tecto (regra 9 a 25%)',
                  ['S1–S7 e os 7 episódios horários, posições com 6 ou mais ciclos · célula = maior compra de uma perna num ciclo, em % do capital',
                   'Por baixo: desvio máximo face à divisão pedida. Azul-escuro = cumpre ≤ 20% e desvio 0 · o tecto, quando trava, deixa capital por investir'], W)
    x0 = 200; rows = []
    for pi, (plab, d3) in enumerate(panels):
        x = d3[(d3.threshold == thr) & (d3.n_ticks >= 6)]
        y0 = 120 + pi * block + 34
        body.append(f'<text x="{x0 - 180}" y="{y0 - 26}" font-size="13" font-weight="600" style="fill:{c("ink")}">{esc(plab)}</text>')
        for jj, cap in enumerate(caps):
            body.append(f'<text x="{x0 + jj*cw + cw/2:.0f}" y="{y0-8}" text-anchor="middle" font-size="12" font-weight="600" style="fill:{c("ink2")}">{"sem tecto" if cap == 0 else f"tecto {cap*100:.0f}%"}</text>')
        for ii, k in enumerate(ks):
            body.append(f'<text x="{x0-14}" y="{y0 + ii*ch + ch/2 + 4:.0f}" text-anchor="end" font-size="12" style="fill:{c("ink2")}">k = {k}{" (v2)" if k == 1 else ""}</text>')
            for jj, cap in enumerate(caps):
                s_ = x[(x.k == k) & (x.cap == cap)]
                mf, dv, un = float(s_.max_fill_pct.max()), float(s_.dev_pp.max()), float(s_.unin_pct.max())
                ok = mf <= 20 + 1e-9 and dv < 1e-6; near = mf <= 21 and dv < 1e-6
                fill = '#0d366b' if ok else ('#3987e5' if near else ('#cde2fb' if dv < 1e-6 else '#e1e0d9'))
                ink = '#ffffff' if (ok or near) else '#0b0b0b'
                body.append(f'<rect x="{x0 + jj*cw + 2}" y="{y0 + ii*ch + 2}" width="{cw-4}" height="{ch-4}" rx="4" fill="{fill}"><title>{esc(f"{plab} · k={k}, tecto {cap*100:.0f}%: maior compra {mf:.1f}% · desvio máx {dv:.1f} pp · por investir máx {un:.1f}% · n={len(s_)}")}</title></rect>')
                body.append(f'<text x="{x0 + jj*cw + cw/2:.0f}" y="{y0 + ii*ch + 20:.0f}" text-anchor="middle" font-size="13" font-weight="600" fill="{ink}" pointer-events="none">{mf:.1f}%</text>')
                body.append(f'<text x="{x0 + jj*cw + cw/2:.0f}" y="{y0 + ii*ch + 35:.0f}" text-anchor="middle" font-size="10.5" fill="{ink}" pointer-events="none">{"desvio 0" if dv < 1e-6 else (f"desvio {dv:.1f} pp" if dv < 10 else f"desvio {dv:.0f} pp")}</text>')
                rows.append(dict(basket=plab, threshold=thr, k=k, cap=cap, max_fill_pct=mf, max_dev_pp=dv, max_uninvested_pct=un, n=len(s_)))
    return save('G1-maior-compra-k-tecto', svg(W, H, body, 'Maior compra única por k × tecto'), pd.DataFrame(rows))

def g2_s1(m, r1, r5, thr=0.25, k=10, names=('ETH', 'WBTC', 'COMP'), basket='ETH + WBTC + COMP'):
    td = m['dates']; P = m['Pe']; names = list(names)
    W, H = 920, 640; xs = [o(d) for d in td]; xl = (xs[0] - 0.8, xs[-1] + 0.8)
    body = header(f'Liquidação no modo suave: tudo no último ciclo (k = 1) ou repartida (k = {k})',
                  [f'S1 · Terra/Luna + Celsius, 5 Mai – 20 Jun 2022 · {basket} · 33-33-33 · cadência diária · regra 9 a 25% · capital 1 000 USD',
                   'A divisão final é a mesma nos dois casos (desvio 0); muda o tamanho da maior compra'], W)
    rel = P / P[0] * 100 - 100
    p1 = Panel(70, 95, W - 110, 120, xl, (np.floor(rel.min() / 10) * 10, 10), ylabel='Preço face à entrada (%)', yunit='%')
    body += p1.frame(show_x=False)
    body += p1.hline(-thr * 100, 'crit', f'limiar −{thr*100:.0f}%')
    for j in range(3): body += p1.line(xs, rel[:, j], LEG_ROLE[j], names[j], tip_fmt=lambda x, y, j=j: f'{dt.date.fromordinal(int(x))} · {names[j]} {y:+.1f}%')
    rows = []
    def bars(r, y0, lab):
        per = np.zeros((len(td), 3))
        for (t, i, u, k) in r.fills: per[t, i] += u
        top = max(560, per.sum(axis=1).max() * 1.05)
        p = Panel(70, y0, W - 110, 140, xl, (0, top), ylabel=lab, yunit='')
        bw = max(2, min(24, (p.X(xs[1]) - p.X(xs[0])) * 0.7))
        out = p.frame(show_x=(y0 > 400))
        for t, x in enumerate(xs):
            base = 0
            for j in range(3):
                v = per[t, j]
                if v <= 1e-9: continue
                out.append(f'<path d="{bar_path(p.X(x)-bw/2, p.Y(base+v), bw, p.Y(base)-(2 if base > 0 else 0), r=3)}" style="fill:{c(LEG_ROLE[j])}"><title>{esc(f"{td[t].date()} · {names[j]}: {v:.1f} USD ({v/10:.1f}% do capital)")}</title></path>')
                base += v
        big = per.max(); tb = int(np.argmax(per.max(axis=1)))
        out.append(f'<text x="{p.X(xs[tb])-8:.1f}" y="{p.Y(per[tb].sum())-6:.1f}" text-anchor="end" font-size="11" style="fill:{c("ink2")}">maior compra: {big/10:.1f}% do capital</text>')
        return out, per
    b1, per1 = bars(r1, 250, 'k = 1 (v2): comprado em cada ciclo (USD)')
    b5, per5 = bars(r5, 440, f'k = {k}: comprado em cada ciclo (USD)')
    body += b1 + b5
    body += legend([(LEG_ROLE[j], names[j], 'box') for j in range(3)], 70, H - 14)
    df = pd.DataFrame({'date': [d.date() for d in td], **{f'k1_{n}': per1[:, j] for j, n in enumerate(names)}, **{f'k{k}_{n}': per5[:, j] for j, n in enumerate(names)}})
    return save('G2-liquidacao-k1-vs-kN-S1', svg(W, H, body, f'Liquidação k=1 vs k={k}'), df)

def g3_aplus_bplus(groups, k=10):
    """groups: list of (label, np.array of A+ minus B+ value in % of capital); v=None draws a section label."""
    W = 920; rh = 30; H = 130 + len(groups) * rh + 50
    allv = np.concatenate([g for _, g in groups if g is not None])
    lim = float(np.ceil(max(abs(np.percentile(allv, 2)), abs(np.percentile(allv, 98))))) or 1
    body = header('A+ face a B+: diferença de valor no fim da posição, por amostra e regime',
                  [f'A+ = Basket com P, M (16 USD), E (k = {k}, sem tecto) e regra 9 a 25% (+ banda de peg 1% no cesto com stable)',
                   'B+ = DCA fixo de 3 pernas com as mesmas protecções · caixa = P25–P75, traço = mediana, linha = P5–P95 · % do capital · histórico'], W)
    x0, x1 = 330, W - 60
    def X(v): return x0 + (v + lim) / (2 * lim) * (x1 - x0)
    for t in nice_ticks(-lim, lim, 6):
        if abs(t) > lim: continue
        body.append(f'<line x1="{X(t):.1f}" x2="{X(t):.1f}" y1="96" y2="{100+len(groups)*rh:.0f}" style="stroke:{c("axis") if t == 0 else c("grid")}" stroke-width="{1.5 if t == 0 else 1}"/>')
        body.append(f'<text x="{X(t):.1f}" y="{116+len(groups)*rh:.0f}" text-anchor="middle" font-size="11" style="fill:{c("muted")}">{fmt_num(t)}%</text>')
    body.append(f'<text x="{X(lim):.0f}" y="{134+len(groups)*rh:.0f}" text-anchor="end" font-size="11" style="fill:{c("ink2")}">A+ à frente →</text>')
    body.append(f'<text x="{X(-lim):.0f}" y="{134+len(groups)*rh:.0f}" text-anchor="start" font-size="11" style="fill:{c("ink2")}">← B+ à frente</text>')
    rows = []
    for k, (lab, v) in enumerate(groups):
        y = 100 + k * rh + rh / 2
        if v is None:
            body.append(f'<text x="20" y="{y+5:.0f}" font-size="12.5" font-weight="600" style="fill:{c("ink")}">{esc(lab)}</text>'); continue
        q = np.percentile(v, [5, 25, 50, 75, 95]); win = (v > 0.01).mean() * 100
        body.append(f'<text x="{x0-12}" y="{y+4:.0f}" text-anchor="end" font-size="12" style="fill:{c("ink2")}">{esc(lab)} · n={len(v)}</text>')
        body.append(f'<line x1="{X(max(q[0],-lim)):.1f}" x2="{X(min(q[4],lim)):.1f}" y1="{y:.1f}" y2="{y:.1f}" style="stroke:{c("ink2")}" stroke-width="1.5"/>')
        body.append(f'<rect x="{X(q[1]):.1f}" y="{y-8:.1f}" width="{max(2, X(q[3])-X(q[1])):.1f}" height="16" rx="3" style="fill:{c("s1")}" opacity="0.85"><title>{esc(f"{lab}: mediana {q[2]:+.2f}% · P25 {q[1]:+.2f} · P75 {q[3]:+.2f} · P5 {q[0]:+.2f} · P95 {q[4]:+.2f} · A+ à frente em {win:.0f}%")}</title></rect>')
        body.append(f'<line x1="{X(q[2]):.1f}" x2="{X(q[2]):.1f}" y1="{y-8:.1f}" y2="{y+8:.1f}" style="stroke:{c("surface")}" stroke-width="2"/>')
        body.append(f'<text x="{x1+6}" y="{y+4:.0f}" font-size="11" style="fill:{c("ink2")}">{win:.0f}%</text>')
        rows.append(dict(sample=lab, n=len(v), p5=q[0], p25=q[1], median=q[2], p75=q[3], p95=q[4], aplus_ahead_pct=win))
    body.append(f'<text x="{W-6}" y="92" text-anchor="end" font-size="10.5" style="fill:{c("muted")}">A+ à frente</text>')
    return save('G3-aplus-vs-bplus', svg(W, H, body, 'A+ vs B+'), pd.DataFrame(rows))
