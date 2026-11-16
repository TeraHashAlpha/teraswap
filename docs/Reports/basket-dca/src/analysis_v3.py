"""v3 · summaries for the report (T3, T6, T8) from the raw run files in results/v3. Pure pandas, no simulation."""
import os, numpy as np, pandas as pd
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R3 = os.path.join(ROOT, 'results', 'v3')
B3 = ('ETH+cbBTC+VIRTUAL', 'ETH+cbBTC+COMP', 'ETH+cbBTC+AERO'); BS = 'ETH+cbBTC+USDC'; BASKETS = B3 + (BS,)
POOL = '3 voláteis (VIRTUAL, COMP, AERO)'
DT = {'set': str, 'episode': str, 'window': str, 'month': str, 'start': str, 'start_day': str, 'duration': str}
KEYS = {'2.1': ['window', 'duration', 'cadence_d', 'split'], '2.2': ['month', 'duration', 'start_day', 'split'],
        '2.3': ['start_day', 'duration', 'cadence_d', 'split'], '2.11': ['start_day', 'duration', 'cadence_d', 'split'],
        '2.10': ['episode', 'cadence_h', 'n_ticks', 'start', 'split']}
SETLAB = {'2.1': 'S1–S7 (stress)', '2.2': 'âncora de Julho (meses voláteis)', '2.3': 'Jul–Out 2026', '2.11': 'amostra de 5 anos', '2.10': 'episódios horários'}
TIE = 0.1      # USD on 1 000 USD = 0,01%

def load_t68():
    d = pd.concat([pd.read_csv(os.path.join(R3, f't68x_{b}.csv.gz'), dtype=DT, low_memory=False) for b in BASKETS], ignore_index=True)
    for k in set(sum(KEYS.values(), [])):
        if k in d: d[k] = d[k].fillna('-')
    return d

def load_t3():
    return pd.read_csv(os.path.join(R3, 't3x_staged.csv.gz'), dtype=DT, low_memory=False)

def wide(d, basket, st, value='val', strategies=('A+', 'B+', 'C', 'A+ rotação')):
    g = d[(d.basket == basket) & (d.set == st) & d.strategy.isin(strategies)]
    return g.pivot_table(index=KEYS[st], columns='strategy', values=value, aggfunc='first')

def guarantee(d):
    rows = []
    for b in BASKETS:
        for st in ('2.1', '2.2', '2.3', '2.11', '2.10'):
            g = d[(d.basket == b) & (d.set == st)]
            A, Bp = g[g.strategy == 'A+'], g[g.strategy == 'B+']
            rows.append(dict(basket=b, set=st, n=len(A), dev_A=A.dev_pp.max(), dev_B=Bp.dev_pp.max(), unin_A=A.unin_pct.max(), unin_B=Bp.unin_pct.max(),
                             pos_dev_A=int((A.dev_pp > 1e-6).sum()), pos_dev_B=int((Bp.dev_pp > 1e-6).sum()),
                             band_pos_A=int(((A.dev_pp > 1e-6) & (A.band_ticks > 0)).sum()),
                             retry_A=int((A.final_retry_legs > 0).sum()), retry_B=int((Bp.final_retry_legs > 0).sum()),
                             unb_A=int(((A.unbought_usd > 0.005) & A.unbought_why.fillna('').str.contains('sem preço')).sum()),
                             unb_B=int(((Bp.unbought_usd > 0.005) & Bp.unbought_why.fillna('').str.contains('sem preço')).sum()),
                             dev_other_A=int(((A.dev_pp > 1e-6) & (A.band_ticks <= 0) & (A.get('unbought_usd', 0) <= 0.005)).sum())))
    return pd.DataFrame(rows)

def _wins(v):
    ab = v['A+'] - v['B+']; ac = v['A+'] - v['C']
    out = dict(n=len(v), A_B=100 * (ab > TIE).mean(), B_A=100 * (ab < -TIE).mean(), A_C=100 * (ac > TIE).mean(),
               both=100 * ((ab > TIE) & (ac > TIE)).mean(), med=ab.median() / 10, p5=ab.quantile(.05) / 10, p95=ab.quantile(.95) / 10,
               mn=ab.min() / 10, mx=ab.max() / 10, med_AC=ac.median() / 10)
    if 'A+ rotação' in v:
        rb = v['A+ rotação'] - v['B+']; out.update(rot_B=100 * (rb > TIE).mean(), rot_med=rb.median() / 10, A_rot=100 * ((v['A+'] - v['A+ rotação']) > TIE).mean())
    return out

def versus(d):
    rows = []
    for b in BASKETS:
        for st in ('2.1', '2.2', '2.3', '2.11', '2.10'):
            v = wide(d, b, st)
            if len(v): rows.append(dict(basket=b, set=st, **_wins(v)))
    allv = []
    for st in ('2.1', '2.2', '2.3', '2.11', '2.10'):
        v = pd.concat([wide(d, b, st) for b in B3]); rows.append(dict(basket=POOL, set=st, **_wins(v)))
    return pd.DataFrame(rows)

def regimes(d, pooled=True):
    """§2.11-style: per (duration, cadence), the 25% most volatile ETH windows vs the rest, quartile set within each basket."""
    rows, groups = [], []
    x = d[d.set == '2.11']
    for b in BASKETS:
        for (dur, cad), g in x[x.basket == b].groupby(['duration', 'cadence_d']):
            v = g.pivot_table(index=['start_day', 'split'], columns='strategy', values='val', aggfunc='first')
            vol = g[g.strategy == 'A+'].set_index(['start_day', 'split']).eth_vol_pct.reindex(v.index)
            p75 = vol.quantile(.75)
            for lab, m in (('alta volatilidade', vol >= p75), ('normal', vol < p75)):
                vv = v[m.values]; rows.append(dict(basket=b, duration=dur, cadence_d=cad, regime=lab, p75=p75, **_wins(vv)))
                groups.append((b, dur, cad, lab, ((vv['A+'] - vv['B+']) / 10).values))
    r = pd.DataFrame(rows)
    if pooled:
        add = []
        for (dur, cad, lab), gg in pd.DataFrame([(g[1], g[2], g[3], g[4]) for g in groups if g[0] in B3], columns=['d', 'c', 'l', 'v']).groupby(['d', 'c', 'l']):
            vals = np.concatenate(gg.v.values)
            add.append(dict(basket=POOL, duration=dur, cadence_d=cad, regime=lab, n=len(vals), A_B=100 * (vals > TIE / 10).mean(), med=np.median(vals),
                            p5=np.percentile(vals, 5), p95=np.percentile(vals, 95)))
        # pooled A+ vs C and both need the raw wide tables
        for a in add:
            vs = []
            for b in B3:
                g = x[(x.basket == b) & (x.duration == a['duration']) & (x.cadence_d == a['cadence_d'])]
                v = g.pivot_table(index=['start_day', 'split'], columns='strategy', values='val', aggfunc='first')
                vol = g[g.strategy == 'A+'].set_index(['start_day', 'split']).eth_vol_pct.reindex(v.index); p75 = vol.quantile(.75)
                vs.append(v[(vol >= p75).values] if a['regime'].startswith('alta') else v[(vol < p75).values])
            vv = pd.concat(vs); w = _wins(vv); a.update(A_C=w['A_C'], both=w['both'], B_A=w['B_A'], med_AC=w['med_AC'])
        r = pd.concat([r, pd.DataFrame(add)], ignore_index=True)
    return r, groups

def rotation(d):
    rows = []
    for b in BASKETS + (POOL,):
        bs = B3 if b == POOL else (b,)
        A = d[d.basket.isin(bs) & (d.strategy == 'A+')]; R = d[d.basket.isin(bs) & (d.strategy == 'A+ rotação')]
        uA = d[d.basket.isin(bs) & (d.strategy == 'A+')].units_vs_Bplus_pct; uR = R.units_vs_Bplus_pct
        rows.append(dict(basket=b, ticks=int(A.ticks_2up1down.sum()), bought=int(A.picked_any.sum()), down=int(A.picked_down_leg.sum()),
                         down_pct_of_bought=100 * A.picked_down_leg.sum() / max(1, A.picked_any.sum()),
                         rot_down_pct=100 * R.picked_down_leg.sum() / max(1, R.ticks_2up1down.sum()),
                         A_down_pct_ticks=100 * A.picked_down_leg.sum() / max(1, A.ticks_2up1down.sum()),
                         uA_med=uA.median(), uA_p5=uA.quantile(.05), uA_p95=uA.quantile(.95), uA_pos=100 * (uA > 0.01).mean(),
                         uR_med=uR.median(), uR_p5=uR.quantile(.05), uR_p95=uR.quantile(.95), uR_pos=100 * (uR > 0.01).mean(), n=len(uA)))
    return pd.DataFrame(rows)

def drawdown_pairs(d):
    rows = []
    for b in B3:
        for st in ('2.1', '2.2', '2.3', '2.11', '2.10'):
            x = wide(d, b, st, 'mdd_pct', ('A+',)); s = wide(d, BS, st, 'mdd_pct', ('A+',))
            j = x.join(s, lsuffix='_x', rsuffix='_s', how='inner').dropna()
            if j.empty: continue
            diff = j['A+_x'] - j['A+_s']
            rows.append(dict(basket=b, set=st, n=len(j), mdd_x_med=j['A+_x'].median(), mdd_x_max=j['A+_x'].max(), mdd_s_med=j['A+_s'].median(),
                             mdd_s_max=j['A+_s'].max(), deeper_pct=100 * (diff > 0.01).mean(), diff_med=diff.median(), diff_p95=diff.quantile(.95)))
    return pd.DataFrame(rows)

def rules(d):
    rows = []
    for b in BASKETS + (POOL,):
        bs = B3 if b == POOL else (b,)
        A = d[d.basket.isin(bs) & (d.strategy == 'A+') & (d.n_ticks >= 6)]
        rows.append(dict(basket=b, n=len(A), cooldown_per_cycle=100 * A.n_cooldown.sum() / A.n_ticks.sum(), locks_early=A.locks_early.mean(),
                         prot_pos=100 * (A.prot_ticks_any > 0).mean(), prot_cycles=100 * A.prot_ticks_any.sum() / A.n_ticks.sum(),
                         all3_pos=100 * (A.all_prot_ticks > 0).mean(), all3_cycles=100 * A.all_prot_ticks.sum() / A.n_ticks.sum(),
                         all3_run_max=int(A.all_prot_maxrun.max()), final_med=A.final_tick_share_pct.median(), final_p95=A.final_tick_share_pct.quantile(.95),
                         final_max=A.final_tick_share_pct.max(), maxfill_max=A.max_fill_pct.max(), maxfill_p95=A.max_fill_pct.quantile(.95),
                         mdd_med=A.mdd_pct.median()))
    return pd.DataFrame(rows)

def p_effect(d):
    rows = []
    for b in BASKETS:
        for st in ('2.1', '2.3', '2.11', '2.10'):
            A = d[(d.basket == b) & (d.set == st) & (d.strategy == 'A+')]
            if A.empty: continue
            pc = 100 * A.decisions_changed_by_P / A.decision_ticks.clip(lower=1)
            cells = A.cl3.sum() + A.dl3.sum() + A.none3.sum()
            rows.append(dict(basket=b, set=st, n=len(A), med=pc.median(), mean=pc.mean(), mx=pc.max(), cl3=100 * A.cl3.sum() / cells, dl3=100 * A.dl3.sum() / cells,
                             none3=100 * A.none3.sum() / cells, skipped_all=int(A.skipped_all.sum())))
    return pd.DataFrame(rows)

def t3_tables(t3):
    t3 = t3.copy(); t3['group'] = np.where(t3.basket == BS, BS, POOL)
    rows = []
    for (grp, thr, k, cap), g in t3.groupby(['group', 'threshold', 'k', 'cap']):
        g6, g8 = g[g.n_ticks >= 6], g[g.n_ticks >= 8]
        rows.append(dict(group=grp, threshold=thr, k=k, cap=cap, mf6=g6.max_fill_pct.max(), mf8=g8.max_fill_pct.max(), dev=g6.dev_pp.max(), unin=g6.unin_pct.max(),
                         n6=len(g6), arg6=_where(g6.loc[g6.max_fill_pct.idxmax()]) if len(g6) else ''))
    base = t3[(t3.k == 1) & (t3.cap == 0)]
    sim = base.groupby(['basket', 'threshold']).agg(n=('n_ticks', 'size'), prot=('protected', 'mean'), all3_pos=('all_prot_ticks', lambda s: int((s > 0).sum())),
                                                    all3_max=('all_prot_ticks', 'max'), run_max=('all_prot_maxrun', 'max'),
                                                    final_med=('final_tick_share_pct', 'median'), final_max=('final_tick_share_pct', 'max'),
                                                    nofill_max=('ticks_without_fill', 'max')).reset_index()
    return pd.DataFrame(rows), sim

def _where(r):
    if r.get('set') == '2.1': return f"{r.basket.split('+')[-1]} · {r.window} {r.duration} {'semanal' if r.cadence_d == 7 else 'diária'} · {int(r.n_ticks)} ciclos · {r.split}"
    return f"{r.basket.split('+')[-1]} · {r.episode} · {int(r.n_ticks)} ciclos de {int(r.cadence_h)} h · {r.split}"

def retry_table(d):
    """Owner's rule: the last cycle waits up to 3 cycles for a usable price, else closes with the leg unbought."""
    x = d[d.strategy.isin(['A+', 'B+'])].copy()
    x['cad'] = np.where(x.set == '2.10', x.cadence_h.astype(str).str.replace('.0', '', regex=False) + ' h',
                        np.where(x.cadence_d.astype(str).isin(['7', '7.0']), 'semanal', 'diária'))
    rows = []
    for (b, cad, st), g in x.groupby([np.where(x.basket.isin(B3), POOL, x.basket), 'cad', 'strategy']):
        need = g[g.final_retry_legs > 0]
        rows.append(dict(basket=b, cadence=cad, strategy=st, n=len(g), need=len(need),
                         w1=int((need.retry_waited_max == 1).sum()), w2=int((need.retry_waited_max == 2).sum()), w3=int((need.retry_waited_max == 3).sum()),
                         closed=int((need.unbought_usd > 0.005).sum()), max_unbought_pct=float(need.unbought_usd.max() / 10) if len(need) else 0.0,
                         closed_noprice=int(((need.unbought_usd > 0.005) & need.unbought_why.fillna('').str.contains('sem preço')).sum()),
                         closed_band=int(((need.unbought_usd > 0.005) & need.unbought_why.fillna('').str.contains('banda')).sum()),
                         beyond=int(need.retry_beyond_data.astype(str).str.lower().eq('true').sum()) if 'retry_beyond_data' in need else 0))
    return pd.DataFrame(rows)
