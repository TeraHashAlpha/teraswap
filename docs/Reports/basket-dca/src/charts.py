"""All report charts as standalone SVG (+ the CSV of exactly what is drawn, beside each)."""
import os, numpy as np, pandas as pd, datetime as dt
from svgcharts import Panel, svg, header, legend, bar_path, c, esc, fmt_num, nice_ticks
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'charts'); os.makedirs(OUT, exist_ok=True)
LEG_ROLE = ['s1', 's2', 's3']
def o(d): return pd.Timestamp(d).toordinal()
def save(name, s, df):
    open(os.path.join(OUT, name + '.svg'), 'w').write(s)
    df.to_csv(os.path.join(OUT, name + '.csv'), index=False)
    return name

def leg_names(meta):
    m = {'cbBTC': 'cbBTC', 'WBTC': 'WBTC', 'WBTC_mainnet': 'WBTC'}
    return ['ETH', m.get(meta['sources'][1], meta['sources'][1]), meta['sources'][2]]

# ------------------------------------------------------------------ T1 pediste vs recebeste
def t1_split_kept(d21):
    W, H = 920, 400; body = header('A divisão que pedes é a divisão que recebes',
        ['Parte do capital investida em cada perna no fim da posição · 112 posições das janelas de stress S1–S7 (2022–2026)',
         '● Basket DCA (regra 3 corrigida)   ○ alvo   ▲ regra 3 original (Julho), para comparação'], W)
    rows = []
    splits = ['25-25-50', '40-40-20', '33-33-33', '30-30-40']
    pw = (W - 80) / 4
    for k, sp in enumerate(splits):
        sub = d21[d21.split == sp]
        p = Panel(60 + k * pw, 90, pw - 30, 250, (-0.5, 2.5), (0, 70), ylabel='% do capital' if k == 0 else '',
                  yunit='%', xdates=False, xticks=[(0, 'ETH'), (1, 'BTC'), (2, 'Stable')])
        body += p.frame()
        body.append(f'<text x="{p.x0 + p.w/2:.0f}" y="{p.y0 + p.h + 36}" text-anchor="middle" font-size="12" font-weight="600" style="fill:{c("ink")}">{sp}</text>')
        tgt = [float(x) for x in sp.split('-')]
        tgt = [x * 100 / sum(tgt) for x in tgt]
        for j in range(3):
            a0 = sub[sub.strategy == 'A0'][f'spent_leg{j}'] / 10
            for v in a0:
                body += [f'<path d="M{p.X(j+0.18)-4:.1f},{p.Y(v)+3.5:.1f} L{p.X(j+0.18)+4:.1f},{p.Y(v)+3.5:.1f} L{p.X(j+0.18):.1f},{p.Y(v)-4:.1f} Z" style="fill:{c("neutral")}" opacity="0.55"><title>{esc(f"Regra 3 original · {sp} · perna {j+1}: {v:.1f}% (alvo {tgt[j]:.1f}%)")}</title></path>']
            a = sub[sub.strategy == 'A'][f'spent_leg{j}'] / 10
            body += p.dot(j - 0.12, tgt[j], LEG_ROLE[j], r=7, hollow=True, title=f'Alvo {tgt[j]:.1f}%')
            body += p.dot(j - 0.12, float(a.mean()), LEG_ROLE[j], r=4,
                          title=f'Basket DCA · {sp}: {len(a)} posições, todas em {a.min():.4f}–{a.max():.4f}% (alvo {tgt[j]:.4f}%)')
            rows.append(dict(split=sp, leg=j, target_pct=tgt[j], basket_min=a.min(), basket_max=a.max(),
                             rule3_original_min=a0.min(), rule3_original_max=a0.max(), n=len(a)))
    return save('T1-divisao-cumprida', svg(W, H, body, 'A divisão pedida é cumprida'), pd.DataFrame(rows))

# ------------------------------------------------------------------ T2 / N1 position anatomy
def position_story(name, title, sub, td, P, r, meta, thr=None, show_alloc=True):
    """Top: ETH price. Middle: USD bought per cycle by leg (stacked). Bottom: allocation path vs target."""
    W = 920; H = 640 if show_alloc else 470
    body = header(title, sub, W)
    xs = [o(d) for d in td]; xl = (xs[0] - 0.8, xs[-1] + 0.8)
    names = leg_names(meta)
    # panel 1 — price, indexed to entry (one axis, three legs) so the stress is visible
    rel = P / P[0] * 100 - 100
    lo = min(-5, np.floor(rel.min() / 10) * 10); hi = max(5, np.ceil(rel.max() / 10) * 10)
    p1 = Panel(70, 95, W - 110, 120, xl, (lo, hi), ylabel='Preço face à entrada (%)', yunit='%')
    body += p1.frame(show_x=False)
    if thr is not None:
        for j in range(3):
            prot = [t for (t, i) in r.protect_marks if i == j]
            for t in prot: body += p1.span(xs[t] - 0.5, xs[t] + 0.5, f'{names[j]} protegida (regra 9) em {td[t].date()}')
        body += p1.hline(-thr * 100, 'crit', f'limiar regra 9: −{thr*100:.0f}%')
    for j in range(3):
        body += p1.line(xs, rel[:, j], LEG_ROLE[j], names[j],
                        tip_fmt=lambda x, y, j=j: f'{dt.date.fromordinal(int(x))} · {names[j]} {y:+.1f}% face à entrada')
    # panel 2 — stacked USD bought per cycle
    per = np.zeros((len(td), 3)); kinds = {}
    for (t, i, u, k) in r.fills: per[t, i] += u; kinds.setdefault(t, set()).add(k)
    top = per.sum(axis=1).max()
    p2 = Panel(70, 250, W - 110, 150, xl, (0, top * 1.08), ylabel='Comprado em cada ciclo (USD, capital 1 000)', yunit='')
    body += p2.frame(show_x=not show_alloc)
    bw = max(2, min(24, (p2.X(xs[1]) - p2.X(xs[0])) * 0.7)) if len(xs) > 1 else 20
    for t, x in enumerate(xs):
        base = 0
        for j in range(3):
            v = per[t, j]
            if v <= 1e-9: continue
            y0 = p2.Y(base); y1 = p2.Y(base + v)
            gap = 2 if base > 0 else 0
            tip = f'{td[t].date()} · {names[j]}: {v:.2f} USD' + (' · liquidação final (regra 8)' if t == len(xs) - 1 else '')
            body.append(f'<path d="{bar_path(p2.X(x) - bw/2, y1, bw, y0 - gap, r=4 if j == max(jj for jj in range(3) if per[t,jj] > 1e-9) else 0)}" style="fill:{c(LEG_ROLE[j])}"><title>{esc(tip)}</title></path>')
            base += v
    if show_alloc:
        p3 = Panel(70, 440, W - 110, 150, xl, (0, 0.5 if max(r.weights) <= 0.5 else 0.7), ylabel='Parte do capital já investida em cada perna, % (alvo = linha fina)', yunit='')
        p3.yticks = [0, 0.1, 0.2, 0.3, 0.4, 0.5] if max(r.weights) <= 0.5 else [0, .2, .4, .6]
        p3.ytick_fmt = lambda t: f'{t*100:.0f}%'
        body += p3.frame()
        for j in range(3):
            body += [f'<line x1="{p3.x0}" x2="{p3.x0+p3.w}" y1="{p3.Y(r.weights[j]):.1f}" y2="{p3.Y(r.weights[j]):.1f}" style="stroke:{c(LEG_ROLE[j])}" stroke-width="1" opacity="0.6"/>']
            body += p3.line(xs, r.alloc_path[:, j], LEG_ROLE[j], names[j],
                            tip_fmt=lambda x, y, j=j: f'{dt.date.fromordinal(int(x))} · {names[j]}: {y*100:.1f}% do capital (alvo {r.weights[j]*100:.1f}%)')
        for (t, i) in r.cooldown_ticks:
            body.append(f'<path d="M{p3.X(xs[t])-4:.1f},{p3.Y(r.alloc_path[t, i])+9:.1f} h8" style="stroke:{c("ink2")}" stroke-width="2"><title>{esc(f"{td[t].date()} · {names[i]} em cooldown (regra 5)")}</title></path>')
        for (t, i) in r.lock_events:
            body += p3.dot(xs[t], r.alloc_path[t, i], LEG_ROLE[i], r=5, title=f'{td[t].date()} · {names[i]} atingiu o alvo e trancou (regra 6)')
        body += legend([(LEG_ROLE[j], names[j], 'line') for j in range(3)] + [('ink2', 'cooldown (regra 5) ▬', 'line'), ('s1', 'lock (regra 6) ●', 'dot')], 70, H - 14)
    else:
        body += legend([(LEG_ROLE[j], names[j], 'box') for j in range(3)], 70, H - 14)
    rows = pd.DataFrame({'date': [d.date() for d in td], **{f'price_rel_{names[j]}': rel[:, j] for j in range(3)},
                         **{f'usd_{names[j]}': per[:, j] for j in range(3)},
                         **{f'share_{names[j]}': r.alloc_path[:, j] for j in range(3)}})
    return save(name, svg(W, H, body, title), rows)

# ------------------------------------------------------------------ N2 box plot of final deviation
def n2_boxplot(frames):
    df = pd.concat(frames, ignore_index=True)
    df = df[df.strategy.isin(['A', 'A0', 'B'])]
    W, H = 920, 380; body = header('Desvio final face à repartição pedida, por estratégia',
        ['Todas as posições de 2.1 (stress), 2.2 (âncora de Julho) e 2.3 (Jul–Out 2026), sem regra 9 · pontos de percentagem',
         'C (só ETH) fica de fora: por construção desvia 100 − w(ETH) pp (50–80 pp)'], W)
    labs = {'A': 'A · Basket DCA (regra 3 corrigida)', 'A0': 'A0 · regra 3 original (Julho)', 'B': 'B · DCA fixo 3 pernas'}
    vmax = max(5, np.ceil(df.deviation_pp.max() / 5) * 5)
    p = Panel(70, 90, W - 110, 240, (-0.5, 2.5), (0, vmax), ylabel='Desvio máximo entre pernas (pp)', yunit=' pp', xdates=False,
              xticks=[(k, labs[s]) for k, s in enumerate(['A', 'A0', 'B'])])
    body += p.frame(); rows = []
    for k, s in enumerate(['A', 'A0', 'B']):
        v = df[df.strategy == s].deviation_pp.values; v = np.where(v < 1e-9, 0, v)
        q = np.percentile(v, [0, 25, 50, 75, 100]); n = len(v); pos = (v > 1e-6).mean() * 100
        X = p.X(k); bw = 46
        body.append(f'<line x1="{X:.1f}" x2="{X:.1f}" y1="{p.Y(q[0]):.1f}" y2="{p.Y(q[4]):.1f}" style="stroke:{c("ink2")}" stroke-width="1.5"/>')
        body.append(f'<rect x="{X-bw/2:.1f}" y="{p.Y(q[3]):.1f}" width="{bw}" height="{max(2, p.Y(q[1])-p.Y(q[3])):.1f}" rx="3" style="fill:{c("s1") if s=="A" else c("neutral")}" opacity="0.85"><title>{esc(f"{labs[s]} · n={n} · mín {q[0]:.2f} · Q1 {q[1]:.2f} · mediana {q[2]:.2f} · Q3 {q[3]:.2f} · máx {q[4]:.2f} pp · {pos:.0f}% das posições com desvio")}</title></rect>')
        body.append(f'<line x1="{X-bw/2:.1f}" x2="{X+bw/2:.1f}" y1="{p.Y(q[2]):.1f}" y2="{p.Y(q[2]):.1f}" style="stroke:{c("surface")}" stroke-width="2"/>')
        ylab = p.Y(q[4]) - 8 if q[4] > vmax * 0.1 else p.Y(0) - 10
        xlab = X + 8 if q[4] > vmax * 0.9 else X
        body.append(f'<text x="{xlab:.1f}" y="{max(p.y0 + 12, ylab):.1f}" text-anchor="{"start" if q[4] > vmax*0.9 else "middle"}" font-size="11" style="fill:{c("ink2")}">{"desvio 0 em todas" if pos == 0 else f"máx {q[4]:.1f} pp"} · {pos:.0f}% com desvio · n={n}</text>')
        rows.append(dict(strategy=s, n=n, min=q[0], q1=q[1], median=q[2], q3=q[3], max=q[4], pct_positions_with_deviation=pos))
    return save('N2-desvio-por-estrategia', svg(W, H, body, 'Desvio final por estratégia'), pd.DataFrame(rows))

# ------------------------------------------------------------------ N3 threshold x mode heatmaps
def n3_heatmap(d25):
    wins = sorted(d25.window.unique()); thrs = sorted(d25.dd_threshold.unique())
    W = 920; cw, ch = 64, 30; H = 150 + len(wins) * ch + 40
    body = header('Regra 9: o que cada limiar custa, por janela de stress',
        ['Mediana (máximo no tooltip) sobre 4 repartições × cadência diária/semanal × janela inteira/30 d após o pior dia',
         'Esquerda: capital que fica por investir no modo rígido · Direita: capital comprado no último ciclo acima de um ciclo normal (1/N), modo suave'], W)
    rows = []
    d25 = d25.assign(excess_final=d25.final_tick_share_pct - 100 / d25.n_ticks)
    blocks = [('rigid', 'uninvested_pct', 'Rígido · capital por investir'), ('soft', 'excess_final', 'Suave · comprado a mais no último ciclo')]
    seq = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b']
    for b, (mode, metric, lab) in enumerate(blocks):
        x0 = 120 + b * (len(thrs) * cw + 120); y0 = 110
        body.append(f'<text x="{x0}" y="{y0-14}" font-size="12" font-weight="600" style="fill:{c("ink")}">{esc(lab)}</text>')
        for jj, t in enumerate(thrs):
            body.append(f'<text x="{x0 + jj*cw + cw/2:.0f}" y="{y0 + len(wins)*ch + 16}" text-anchor="middle" font-size="11" style="fill:{c("muted")}">{t*100:.0f}%</text>')
        body.append(f'<text x="{x0 + len(thrs)*cw/2:.0f}" y="{y0 + len(wins)*ch + 32}" text-anchor="middle" font-size="11" style="fill:{c("ink2")}">limiar</text>')
        for ii, w in enumerate(wins):
            if b == 0: body.append(f'<text x="{x0-10}" y="{y0 + ii*ch + ch/2 + 4:.0f}" text-anchor="end" font-size="12" style="fill:{c("ink2")}">{w}</text>')
            for jj, t in enumerate(thrs):
                s = d25[(d25.window == w) & (d25.dd_threshold == t) & (d25.dd_mode == mode)]
                med = float(s[metric].median()); mx = float(s[metric].max())
                lvl = min(6, int(med / 10))
                fill = seq[lvl]; ink = '#ffffff' if lvl >= 3 else '#0b0b0b'
                body.append(f'<rect x="{x0 + jj*cw + 1}" y="{y0 + ii*ch + 1}" width="{cw-2}" height="{ch-2}" rx="3" fill="{fill}"><title>{esc(f"{w} · limiar {t*100:.0f}% · {lab}: mediana {med:.1f}% · máx {mx:.1f}% · desvio máx {s.deviation_pp.max():.1f} pp · n={len(s)}")}</title></rect>')
                body.append(f'<text x="{x0 + jj*cw + cw/2:.0f}" y="{y0 + ii*ch + ch/2 + 4:.0f}" text-anchor="middle" font-size="11" fill="{ink}" style="font-variant-numeric:tabular-nums" pointer-events="none">{med:.0f}%</text>')
                rows.append(dict(window=w, threshold=t, mode=mode, metric=metric, median=med, max=mx, max_deviation_pp=float(s.deviation_pp.max()), n=len(s)))
    return save('N3-limiar-x-modo', svg(W, H, body, 'Regra 9 limiar × modo'), pd.DataFrame(rows))

# ------------------------------------------------------------------ E1 choice vs cycles
def e1_cycles(d24):
    A = d24[d24.strategy == 'A']
    W, H = 920, 380
    body = header('Quanto do capital foi realmente escolhido pela regra 4, por nº de ciclos',
                  ['33-33-33 · posições a começar em cada dia de S5 (Fev–Abr 2025) e de Jul–Out 2026 · mediana, com o intervalo mín–máx',
                   'Restante = compras forçadas (só uma perna elegível) + liquidação final'], W)
    p = Panel(70, 90, W - 260, 240, (0, 56), (50, 100), ylabel='Capital com escolha real (≥ 2 pernas elegíveis)', yunit='%', xdates=False,
              xticks=[(n, f'{n}') for n in (6, 12, 26, 52)])
    body += p.frame(); rows = []
    for k, cad in enumerate((1, 3, 7)):
        s = A[A.cadence_d == cad].groupby('n_cycles').chosen_capital_pct.agg(['median', 'min', 'max']).reset_index()
        role = LEG_ROLE[k]; off = (k - 1) * 0.8
        for _, rr in s.iterrows():
            body.append(f'<line x1="{p.X(rr.n_cycles+off):.1f}" x2="{p.X(rr.n_cycles+off):.1f}" y1="{p.Y(rr["min"]):.1f}" y2="{p.Y(rr["max"]):.1f}" style="stroke:{c(role)}" stroke-width="2" opacity="0.45"/>')
        body += p.line(list(s.n_cycles + off), list(s['median']), role, f'{cad} d')
        for _, rr in s.iterrows():
            body += p.dot(rr.n_cycles + off, rr['median'], role, title=f'cadência {cad} d · {int(rr.n_cycles)} ciclos: mediana {rr["median"]:.1f}% (mín {rr["min"]:.1f}, máx {rr["max"]:.1f})')
            rows.append(dict(cadence_d=cad, n_cycles=int(rr.n_cycles), median=rr['median'], min=rr['min'], max=rr['max']))
        last = s.iloc[-1]
        body.append(f'<text x="{p.X(last.n_cycles+off)+10:.1f}" y="{p.Y(last["median"])+4:.1f}" font-size="12" style="fill:{c("ink2")}">cadência {cad} d</text>')
    body.append(f'<text x="{p.x0+p.w/2:.0f}" y="{p.y0+p.h+34}" text-anchor="middle" font-size="11" style="fill:{c("ink2")}">nº de ciclos da posição</text>')
    return save('E1-escolha-vs-ciclos', svg(W, H, body, 'Escolha real vs nº de ciclos'), pd.DataFrame(rows))

# ------------------------------------------------------------------ T4 what you paid (history, not promise)
def t4_avg_price(frames):
    df = pd.concat(frames, ignore_index=True)
    A = df[df.strategy == 'A'].reset_index(drop=True); B = df[df.strategy == 'B'].reset_index(drop=True)
    keys = ['section', 'window', 'duration', 'cadence_d', 'split', 'start_day', 'month', 'variant']
    keys = [k for k in keys if k in A.columns]
    m = A.merge(B, on=keys, suffixes=('_A', '_B'))
    W, H = 920, 360
    body = header('Preço médio pago: Basket DCA face ao DCA fixo, nas mesmas janelas',
                  ['Diferença do preço médio de compra de cada perna, A vs B (negativo = A pagou menos) · histórico real, não é promessa',
                   'Posições de 2.1 e 2.3, sem regra 9 · cada traço é uma posição'], W)
    p = Panel(70, 90, W - 110, 220, (-0.5, 2.5), (-12, 12), ylabel='A vs B (%)', yunit='%', xdates=False,
              xticks=[(0, 'ETH'), (1, 'BTC (cbBTC/WBTC)'), (2, 'Stable')])
    body += p.frame(); rows = []
    for j in range(3):
        d = (m[f'avg_price_leg{j}_A'] / m[f'avg_price_leg{j}_B'] - 1) * 100
        d = d.dropna().clip(-12, 12)
        for v in d.values:
            body.append(f'<line x1="{p.X(j)-14:.1f}" x2="{p.X(j)+14:.1f}" y1="{p.Y(v):.1f}" y2="{p.Y(v):.1f}" style="stroke:{c(LEG_ROLE[j])}" stroke-width="1" opacity="0.25"/>')
        q = np.percentile(d, [5, 50, 95])
        body.append(f'<line x1="{p.X(j)+24:.1f}" x2="{p.X(j)+24:.1f}" y1="{p.Y(q[0]):.1f}" y2="{p.Y(q[2]):.1f}" style="stroke:{c("ink2")}" stroke-width="2"/>')
        body += p.dot(j + 0.07, q[1], LEG_ROLE[j], r=5, title=f'perna {j+1}: mediana {q[1]:+.2f}% · P5 {q[0]:+.2f}% · P95 {q[2]:+.2f}% · {(d<0).mean()*100:.0f}% das posições A pagou menos · n={len(d)}')
        body.append(f'<text x="{p.X(j)+32:.1f}" y="{p.Y(q[1])+4:.1f}" font-size="11" style="fill:{c("ink2")}">mediana {q[1]:+.2f}%</text>')
        rows.append(dict(leg=j, n=len(d), p5=q[0], median=q[1], p95=q[2], pct_A_cheaper=(d < 0).mean() * 100))
    body.append(f'<line x1="{p.x0}" x2="{p.x0+p.w}" y1="{p.Y(0):.1f}" y2="{p.Y(0):.1f}" style="stroke:{c("axis")}" stroke-width="1.5"/>')
    return save('T4-preco-medio-A-vs-B', svg(W, H, body, 'Preço médio A vs B'), pd.DataFrame(rows))

# ------------------------------------------------------------------ E2 depeg
def e2_depeg(paths, d26):
    evs = [e for e in ['USDC-2023', 'USDT-2022', 'DAI-2023', 'UST-2022'] if (e, 'A', 'sem regra') in paths]
    W = 920; ph = 120; H = 100 + len(evs) * (ph + 150) + 20
    body = header('Depeg da perna stable: o que a regra 4 compra, e o que a banda de peg evita',
                  ['33-33-33 · cadência diária · posição de 30 d antes a 30 d depois do evento · barras: USD comprados da stable em cada ciclo',
                   'Cinzento = sem regra adicional · cor = com a banda proposta (|preço − 1| > 1% ⇒ inelegível, também na liquidação final)'], W)
    rows = []; y = 90
    for ev in evs:
        td, P, r0 = paths[(ev, 'A', 'sem regra')]
        r1 = paths.get((ev, 'A', 'banda 1% · fim rígido'), (None, None, None))[2]
        xs = [o(d) for d in td]; xl = (xs[0] - 1, xs[-1] + 1)
        stable = P[:, 2]
        lo = min(0.85, np.floor(stable.min() * 20) / 20) if stable.min() > 0.5 else 0
        p1 = Panel(70, y + 20, W - 110, ph, xl, (lo, 1.02), ylabel=f'{ev}: preço da stable no feed (tick 00:00 UTC)', yunit='')
        body += p1.frame(show_x=False)
        body += p1.hline(0.99, 'crit', 'banda −1%')
        body += p1.line(xs, stable, 's3', ev, tip_fmt=lambda x, yv: f'{dt.date.fromordinal(int(x))} · {yv:.4f}')
        per0 = np.zeros(len(td)); per1 = np.zeros(len(td))
        for (t, i, u, k) in r0.fills:
            if i == 2: per0[t] += u
        if r1 is not None:
            for (t, i, u, k) in r1.fills:
                if i == 2: per1[t] += u
        top = max(per0.max(), per1.max(), 1)
        p2 = Panel(70, y + ph + 50, W - 110, 60, xl, (0, top * 1.1), ylabel='USD comprados da stable', yunit='')
        body += p2.frame()
        bw = max(2, (p2.X(xs[1]) - p2.X(xs[0])) * 0.38)
        for t, x in enumerate(xs):
            if per0[t] > 0: body.append(f'<path d="{bar_path(p2.X(x)-bw-1, p2.Y(per0[t]), bw, p2.Y(0))}" style="fill:{c("neutral")}"><title>{esc(f"{td[t].date()} · sem regra: {per0[t]:.2f} USD a {stable[t]:.4f}")}</title></path>')
            if per1[t] > 0: body.append(f'<path d="{bar_path(p2.X(x)+1, p2.Y(per1[t]), bw, p2.Y(0))}" style="fill:{c("s3")}"><title>{esc(f"{td[t].date()} · com banda 1%: {per1[t]:.2f} USD a {stable[t]:.4f}")}</title></path>')
            rows.append(dict(event=ev, date=td[t].date(), stable_price=stable[t], usd_no_rule=per0[t], usd_band1=per1[t]))
        y += ph + 150
    return save('E2-depeg-stable', svg(W, H, body, 'Depeg da perna stable'), pd.DataFrame(rows))

# ------------------------------------------------------------------ E3 price quality
def e3_quality(al_aero, al_eth):
    W = 920; H = 560
    body = header('Fase 2: quanto o preço do quórum se afasta da referência, hora a hora',
                  ['Jul–Nov 2026 · DefiLlama (o que a fase 2 leria) face à Coinbase, em pontos base · faixa = tolerância do quórum do keeper (±300 bps)',
                   'AERO: token da Base sem feed registado no TeraSwap · ETH: calibração, onde o feed Chainlink existe'], W)
    rows = []
    for k, (tok, al) in enumerate([('AERO', al_aero), ('ETH', al_eth)]):
        x = al[['DefiLlama (fase 2)', 'Coinbase']].dropna()
        bps = (x.iloc[:, 0] / x.iloc[:, 1] - 1) * 1e4
        xs = [t.toordinal() + t.hour / 24 for t in bps.index]
        lim = 400 if bps.abs().max() < 400 else float(np.ceil(bps.abs().max() / 500) * 500)
        p = Panel(70, 100 + k * 230, W - 110, 170, (xs[0], xs[-1]), (-lim, lim), ylabel=f'{tok}: DefiLlama − Coinbase (bps)', yunit='')
        body += p.frame()
        body.append(f'<rect x="{p.x0}" y="{p.Y(300):.1f}" width="{p.w}" height="{p.Y(-300)-p.Y(300):.1f}" style="fill:{c("seq1")}" opacity="0.45"/>')
        body += p.line(xs, list(bps.values), 's1', tok, width=1.2)
        big = bps[bps.abs() > 100]
        for t, v in big.items():
            body += p.dot(t.toordinal() + t.hour / 24, v, 'crit', r=4, title=f'{t} UTC · {v:+.0f} bps')
        if len(big):
            t, v = big.abs().idxmax(), bps[big.abs().idxmax()]
            X = p.X(t.toordinal()+t.hour/24); right = X > p.x0 + p.w * 0.7
            body.append(f'<text x="{X + (-10 if right else 8):.1f}" y="{p.Y(v)+(16 if v<0 else -8):.1f}" text-anchor="{"end" if right else "start"}" font-size="11" style="fill:{c("ink2")}">{t.day}/{t.month} {t:%H:%M} UTC · {v:+.0f} bps</text>')
        rows += [dict(token=tok, utc=t, bps=v) for t, v in bps.items()]
    return save('E3-quorum-vs-referencia', svg(W, H, body, 'Fase 2: preço do quórum vs referência'), pd.DataFrame(rows))

# ------------------------------------------------------------------ E4 minimum capital
def e4_cost(d29):
    g = d29[(d29['mode'] == 'sem regra 9') & d29.strategy.isin(['A', 'B'])]
    col = 'Cmin_max · rota agregador · gas de mercado'; colc = 'Cmin_max · rota canónica · gas de mercado'
    cases = [(1, 6), (1, 12), (1, 30), (1, 60), (1, 90), (7, 6), (7, 12), (7, 26), (7, 52)]
    cases = [(cad, n) for cad, n in cases if not g[(g.cadence_d == cad) & (g.n_ticks == n)].empty]
    W = 920; rh = 34; H = 120 + len(cases) * rh + 50
    body = header('Capital mínimo para a fee (0,1%) cobrir o gas da posição',
                  ['Pior caso de fills observado × 0,016 USD por fill (rota agregador, gas de mercado na Base) · tooltip: rota canónica (0,003 USD)',
                   'Com o tier actual do keeper (1,5 gwei, 0,75–3,93 USD por fill) os valores multiplicam por ~47–245'], W)
    vmax = float(g[g.n_ticks.isin([n for _, n in cases])][col].max()) * 1.12
    x0, x1 = 190, W - 120; rows = []
    def X(v): return x0 + v / vmax * (x1 - x0)
    for t in nice_ticks(0, vmax, 5):
        if t > vmax: continue
        body.append(f'<line x1="{X(t):.1f}" x2="{X(t):.1f}" y1="96" y2="{100 + len(cases)*rh:.0f}" style="stroke:{c("grid")}"/>')
        body.append(f'<text x="{X(t):.1f}" y="{116 + len(cases)*rh:.0f}" text-anchor="middle" font-size="11" style="fill:{c("muted")}">{esc(fmt_num(t))}</text>')
    body.append(f'<text x="{(x0+x1)/2:.0f}" y="{134 + len(cases)*rh:.0f}" text-anchor="middle" font-size="11" style="fill:{c("ink2")}">USD</text>')
    for k, (cad, n) in enumerate(cases):
        y = 100 + k * rh
        lab = f'{n} ciclos · {"diária" if cad == 1 else "semanal"}'
        body.append(f'<text x="{x0-10}" y="{y + rh/2 + 4:.0f}" text-anchor="end" font-size="12" style="fill:{c("ink2")}">{esc(lab)}</text>')
        for jj, st in enumerate(['A', 'B']):
            s_ = g[(g.cadence_d == cad) & (g.n_ticks == n) & (g.strategy == st)]
            if s_.empty: continue
            v = float(s_[col].iloc[0]); vc = float(s_[colc].iloc[0]); yy = y + 5 + jj * 12
            nf = int(s_['max'].iloc[0])
            tip = f'{lab} · {st}: {fmt_num(v)} USD (agregador) · {fmt_num(vc)} USD (canónica) · {nf} fills'
            body.append(f'<path d="M{x0},{yy:.1f} H{X(v)-4:.1f} Q{X(v):.1f},{yy:.1f} {X(v):.1f},{yy+4:.1f} V{yy+6:.1f} Q{X(v):.1f},{yy+10:.1f} {X(v)-4:.1f},{yy+10:.1f} H{x0} Z" style="fill:{c("s1") if st=="A" else c("neutral")}"><title>{esc(tip)}</title></path>')
            if st == 'A': body.append(f'<text x="{X(v)+6:.1f}" y="{yy+9:.1f}" font-size="11" style="fill:{c("ink2")};font-variant-numeric:tabular-nums">{esc(fmt_num(v))}</text>')
            rows.append(dict(cadence_d=cad, n_cycles=n, strategy=st, cmin_aggregator_usd=v, cmin_canonical_usd=vc, fills_max=int(s_['max'].iloc[0])))
    body += legend([('s1', 'A · Basket DCA', 'box'), ('neutral', 'B · DCA fixo 3 pernas (3 fills por ciclo)', 'box')], 190, H - 12)
    return save('E4-capital-minimo', svg(W, H, body, 'Capital mínimo por posição'), pd.DataFrame(rows))

def build_all(out):
    import experiments as ex
    made = []
    made.append(t1_split_kept(out['2.1']))
    objs = out['2.1_objs']
    for key, name, title, sub in [
        (('S1', 'janela', 1, '33-33-33'), 'T2-para-onde-foi-cada-ciclo',
         'Para onde foi cada ciclo — Terra/Luna + Celsius', 'S1 · 5 Mai – 20 Jun 2022 · 33-33-33 · cadência diária · capital 1 000 USD · sem regra 9'),
    ]:
        (o_, meta) = objs[key]
        made.append(position_story(name, title, [sub], meta['dates'], meta['P'], o_['A'], meta, show_alloc=False))
    # N1 + T3: S1 with rule 9 (20%) in both modes
    from scenarios import ticks, run_position, SPLITS
    w = ex.stress_windows()['S1']
    td = ticks(w[0], 1, end=w[1])
    for mode, nm, ttl in [('soft', 'N1-caminho-da-reparticao-S1-suave', 'Caminho da repartição em stress — modo suave'),
                          ('rigid', 'T3-proteccao-S1-rigido', 'A protecção a funcionar — modo rígido')]:
        o_, meta = run_position(('ETH', 'BTC', 'USDC'), SPLITS['33-33-33'], td, 1, strategies=('A',), dd_threshold=0.20, dd_mode=mode)
        made.append(position_story(nm, ttl, [f'S1 · 5 Mai – 20 Jun 2022 · 33-33-33 · diária · regra 9 com limiar 20% (sombra = perna protegida)'],
                                   meta['dates'], meta['P'], o_['A'], meta, thr=0.20))
    made.append(t4_avg_price([out['2.1'], out['2.3']]))
    made.append(n2_boxplot([out['2.1'], out['2.2'], out['2.3']]))
    made.append(n3_heatmap(out['2.5']))
    made.append(e1_cycles(out['2.4']))
    made.append(e2_depeg(out['2.6_paths'], out['2.6']))
    made.append(e3_quality(out['al_aero'], out['al_eth']))
    made.append(e4_cost(out['2.9']))
    if '2.11' in out:
        made.append(e5_wins(out['2.11'], out['2.11_other']))
        made.append(e6_episode('E6'))
    return made

# ------------------------------------------------------------------ E5 who ended ahead
def e5_wins(d211, other):
    rows_in = []
    for _, r in d211.iterrows():
        if r.regime.startswith(('alta', 'normal')):
            dur = '30 d diária' if (r.duration == '30d') else ('90 d diária' if r.cadence_d == 1 else '90 d semanal')
            rows_in.append((f'Amostra 5 anos · {dur} · {"alta vol." if r.regime.startswith("alta") else "normal"}', r))
    for _, r in other.iterrows(): rows_in.append((r['sample'], r))
    W = 920; rh = 30; H = 130 + len(rows_in) * rh + 46
    body = header('Quantas vezes o Basket acabou com mais valor do que os outros dois DCAs',
                  ['Mesmo capital, janela e cadência · valor no último tick · empates (< 0,01% do capital) não contam como vitória · histórico, não é promessa',
                   '● A > B (DCA fixo, mesma divisão)   ● A > C (só ETH)   ● A > B e > C ao mesmo tempo'], W)
    x0, x1 = 380, W - 40
    def X(v): return x0 + v / 100 * (x1 - x0)
    for t in (0, 25, 50, 75, 100):
        body.append(f'<line x1="{X(t):.1f}" x2="{X(t):.1f}" y1="96" y2="{100+len(rows_in)*rh:.0f}" style="stroke:{c("axis") if t == 50 else c("grid")}" stroke-width="{1.5 if t == 50 else 1}"/>')
        body.append(f'<text x="{X(t):.1f}" y="{116+len(rows_in)*rh:.0f}" text-anchor="middle" font-size="11" style="fill:{c("muted")}">{t}%</text>')
    out = []
    for k, (lab, r) in enumerate(rows_in):
        y = 100 + k * rh + rh / 2
        body.append(f'<text x="{x0-12}" y="{y+4:.0f}" text-anchor="end" font-size="12" style="fill:{c("ink2")}">{esc(lab)} · n={int(r.n)}</text>')
        for col, role, nm in (('A_beats_both', 's3', 'A > B e > C'), ('A_beats_C', 's2', 'A > C'), ('A_beats_B', 's1', 'A > B')):
            v = float(r[col])
            body.append(f'<circle cx="{X(v):.1f}" cy="{y:.1f}" r="5" style="fill:{c(role)};stroke:{c("surface")}" stroke-width="2"><title>{esc(f"{lab}: {nm} em {v:.1f}% das posições (n={int(r.n)}) · mediana A−B {r.median_A_minus_B_pct:+.2f}% · mediana A−C {r.median_A_minus_C_pct:+.2f}%")}</title></circle>')
        out.append(dict(sample=lab, n=int(r.n), A_beats_B=r.A_beats_B, A_beats_C=r.A_beats_C, A_beats_both=r.A_beats_both,
                        median_A_minus_B_pct=r.median_A_minus_B_pct, median_A_minus_C_pct=r.median_A_minus_C_pct))
    body += legend([('s1', 'A > B', 'dot'), ('s2', 'A > C', 'dot'), ('s3', 'A > B e > C', 'dot')], x0, H - 14)
    return save('E5-quem-ficou-a-frente', svg(W, H, body, 'Vitórias do Basket face a B e C'), pd.DataFrame(out))

# ------------------------------------------------------------------ E6 hourly episode anatomy
def e6_episode(ep='E6'):
    import hourly_events as he
    from engine import run_basket
    from scenarios import SPLITS
    h = pd.Timestamp(he.EPISODES[ep][0]); fks = he.leg_feeds(ep); ser = [he.leg_series(fk) for fk in fks]
    td = [h + pd.Timedelta(hours=k) for k in range(-36, 36)]
    P = np.array([[s[t] for s in ser] for t in td]); p0 = np.array([s[td[0] - pd.Timedelta(hours=1)] for s in ser])
    r = run_basket(P, p0, SPLITS['33-33-33'], 1000, True)
    cx = pd.read_csv(os.path.join(ROOT, 'data', 'series', 'hourly_exchange', 'coinbase_ETH-USD.csv'))
    cx['t'] = pd.to_datetime(cx.ts, unit='s'); cx = cx.set_index('t')
    W, H = 920, 560
    body = header(f'Um movimento brusco visto hora a hora — {he.EPISODES[ep][2]}',
                  ['Posição 33-33-33 com cadência horária, 72 ciclos à volta do evento · linha = feed Chainlink ETH/USD (Arbitrum) lido à hora certa',
                   'Barra vertical cinzenta = mínimo e máximo da vela horária da Coinbase: o que a bolsa fez dentro da hora e o feed não mostrou'], W)
    xs = [t.toordinal() + t.hour / 24 for t in td]; xl = (xs[0] - 0.03, xs[-1] + 0.03)
    lo = min(P[:, 0].min(), cx.loc[td[0]:td[-1]].low.min()) * 0.98; hi = max(P[:, 0].max(), cx.loc[td[0]:td[-1]].high.max()) * 1.01
    p1 = Panel(70, 100, W - 110, 220, xl, (lo, hi), ylabel='ETH (USD)', yunit='')
    p1.xticks = [(t.toordinal() + t.hour / 24, f'{t.day} {["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"][t.month-1]} {t:%H}h') for t in td[::12]]
    body += p1.frame()
    for t, x in zip(td, xs):
        if t in cx.index:
            c_ = cx.loc[t]
            body.append(f'<line x1="{p1.X(x):.1f}" x2="{p1.X(x):.1f}" y1="{p1.Y(c_.high):.1f}" y2="{p1.Y(c_.low):.1f}" style="stroke:{c("neutral")}" stroke-width="3" opacity="0.45"><title>{esc(f"{t} UTC · Coinbase mín {c_.low:,.0f} · máx {c_.high:,.0f}".replace(",", " "))}</title></line>')
    body += p1.line(xs, list(P[:, 0]), 's1', 'ETH', tip_fmt=lambda x, y: f'feed às {int(round((x % 1) * 24)):02d}:00 · {y:,.0f} USD'.replace(',', ' '))
    per = np.zeros((len(td), 3))
    for (t, i, u, k) in r.fills: per[t, i] += u
    p2 = Panel(70, 370, W - 110, 130, xl, (0, per.sum(axis=1).max() * 1.1), ylabel='Comprado em cada ciclo horário (USD, capital 1 000)', yunit='')
    p2.xticks = p1.xticks; body += p2.frame()
    bw = max(2, (p2.X(xs[1]) - p2.X(xs[0])) * 0.7); names = ['ETH', 'cbBTC', 'USDC']
    for t, x in enumerate(xs):
        base = 0
        for j in range(3):
            v = per[t, j]
            if v <= 1e-9: continue
            body.append(f'<path d="{bar_path(p2.X(x)-bw/2, p2.Y(base+v), bw, p2.Y(base) - (2 if base > 0 else 0), r=2)}" style="fill:{c(LEG_ROLE[j])}"><title>{esc(f"{td[t]} UTC · {names[j]}: {v:.2f} USD")}</title></path>')
            base += v
    ev = h.toordinal() + h.hour / 24
    for p in (p1, p2):
        body.append(f'<line x1="{p.X(ev):.1f}" x2="{p.X(ev):.1f}" y1="{p.y0}" y2="{p.y0+p.h}" style="stroke:{c("crit")}" stroke-width="1"/>')
    body.append(f'<text x="{p1.X(ev)+6:.1f}" y="{p1.y0+12}" font-size="11" style="fill:{c("ink2")}">hora do evento</text>')
    body += legend([(LEG_ROLE[j], names[j], 'box') for j in range(3)], 70, H - 14)
    df = pd.DataFrame({'utc': td, 'eth_feed': P[:, 0], 'usd_eth': per[:, 0], 'usd_cbbtc': per[:, 1], 'usd_usdc': per[:, 2]})
    return save('E6-episodio-horario', svg(W, H, body, 'Episódio horário'), df)
