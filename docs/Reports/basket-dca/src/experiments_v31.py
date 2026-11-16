"""v3.1 · runs: A+ discreto (L = 1, 2; suave, rígido) against A+ contínuo and B+ on the same real positions, both baskets
(three-volatile first); the Architect's peg-band rule on the T7 events; the warning table X -> (N, R)."""
import os, sys, json, itertools, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import experiments_v3 as e3, experiments_v3x as xx, prices_v3 as pv, t7_stables as T7
from scenarios import SPLITS
from engine_plus import run_plus
from engine_discrete import run_discrete, choose_n
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R31 = os.path.join(ROOT, 'results', 'v31'); os.makedirs(R31, exist_ok=True)
GZ = {'method': 'gzip', 'mtime': 0}
THR, KSOFT, MINFILL = 0.25, 10, 16.0           # rule 9 at 25%, E k = 10 (v3 T3), minFill of the aggregator route
LEG = ('eth', 'btc', 'x3')

def positions(legs):
    for st, gen in (('2.1', lambda: xx.daily_positions(legs, [e3.set_21()])), ('2.3', lambda: xx.daily_positions(legs, [e3.set_23()])),
                    ('2.11', lambda: xx.daily_positions(legs, [e3.set_211()])), ('2.10', lambda: xx.set_210x(legs))):
        for meta, m in gen(): yield meta, m

def runs_for(bname):
    legs = xx.BASKETS[bname]; stable = bname == xx.STABLE
    sb = dict(stable_idx=2, band=0.01) if stable else {}
    rows = []
    for meta, m in positions(legs):
        w = np.asarray(SPLITS[meta['split']]); N = len(m['dates'])
        base = dict(meta, basket=bname, n_ticks=N)
        for mode in ('soft', 'rigid'):
            ml = 'suave' if mode == 'soft' else 'rígido'
            kw = dict(Pd=m['Pd'], pd0=m['pd0'], dd=THR, mode=mode, k=KSOFT if mode == 'soft' else 1, cap=None, min_fill=MINFILL,
                      final_retry=True, retry_Pe=m['rPe'], retry_Pd=m['rPd'], **sb)
            for name, sel_ in (('A+ contínuo', True), ('B+', False)):
                r = run_plus(m['Pe'], w, **kw, select=sel_)
                rec = dict(base, strategy=name, mode=ml, L=np.nan, val=float((r.qty * m['Pe'][-1]).sum() + r.cash_left), dev_pp=r.deviation_pp,
                           unbought_pct=100 * r.cash_left / r.capital, pending_chunks=np.nan, n_fills=r.n_fills, max_fill_pct=r.max_fill_pct,
                           max_cycle_pct=r.max_fill_pct, extra_vs_N=np.nan, fills_in_grace=np.nan)
                for j, lg in enumerate(LEG): rec[f'px_{lg}'] = r.avg_price[j]
                rows.append(rec)
            for L in (1, 2):
                r = run_discrete(m['Pe'], w, n=None, min_fill=MINFILL, L=L, Pd=m['Pd'], pd0=m['pd0'], rPe=m['rPe'], rPd=m['rPd'],
                                 dd=THR, mode=mode, k_soft=KSOFT, **sb)
                rec = dict(base, strategy='A+ discreto', mode=ml, L=L, val=r.value_end, dev_pp=r.deviation_pp, unbought_pct=100 * r.unbought_usd / r.capital,
                           pending_chunks=r.pending_chunks, n_fills=r.n_fills, max_fill_pct=r.max_fill_pct, max_cycle_pct=r.max_cycle_pct,
                           extra_vs_N=r.extra_vs_N, fills_in_grace=r.fills_in_grace, n_chunks=int(r.n.sum()),
                           exact_chunks=bool(all(abs(r.spent[i] - r.done[i] * r.chunk[i]) < 1e-6 for i in range(3))))
                for k, c in r.idle_counts.items(): rec[f'idle_{k}'] = c
                for j, lg in enumerate(LEG): rec[f'px_{lg}'] = r.avg_price[j]; rec[f'pend_{lg}'] = int(r.n[j] - r.done[j])
                rows.append(rec)
    return pd.DataFrame(rows)

def run_all_baskets():
    from multiprocessing import Pool
    with Pool(2) as p:
        out = p.map(runs_for, list(xx.BASKETS))
    for b, d in zip(xx.BASKETS, out):
        d.to_csv(os.path.join(R31, f'discreto_{b}.csv.gz'), index=False, compression=GZ)

# ------------------------------------------------------------------ §3.3 the Architect's peg-band rule on the T7 events
BANDS = (0.01, 0.02, 0.05, 0.10)
def _cl_with_age(sym, idx):
    ST = T7.ST; p = os.path.join(ST, f'cl_rounds_{sym}.csv')
    ts = ((idx - pd.Timestamp('1970-01-01')) // pd.Timedelta('1s')).to_numpy()
    if os.path.exists(p):
        r = pd.read_csv(p).sort_values('updatedAt'); r = r[r.updatedAt > 0]
        i = np.searchsorted(r.updatedAt.values, ts, side='right') - 1; ok = i >= 0
        price = np.where(ok, r.price.values[np.clip(i, 0, None)], np.nan); age = np.where(ok, ts - r.updatedAt.values[np.clip(i, 0, None)], np.nan)
        return price, age, 'todas as rondas'
    p = os.path.join(ST, f'cl_hourly_ev_{sym}.csv')
    if os.path.exists(p):
        d = pd.read_csv(p); s = pd.Series(d.price.values, index=pd.to_datetime(d.utc).dt.tz_convert(None)); a = pd.Series(d.age_s.values, index=s.index)
        return s.reindex(idx).values, a.reindex(idx).values, 'amostra horária'
    return None, None, None

def band_rule():
    cfg = json.load(open(os.path.join(T7.ST, 'stable_feeds.json')))
    ev = pd.read_csv(os.path.join(ROOT, 'results', 'v3', 't7_events.csv'), parse_dates=['start', 'recovered_at'])
    ev = ev[(ev.hourly_confirmed != False) & ev.keeper_series.str.startswith('Chainlink (Ethereum)') & (ev.confirmed == True)]
    rows, detail = [], []
    def decide(p_cl, age, p_dl, band, thr, max_age, arch):
        if arch and thr < band and age == age and age <= max_age and p_cl == p_cl:
            return 'não compra' if abs(p_cl - 1) + thr > band else 'compra', 'feed'
        if (not arch) and age == age and age <= pv.MAX_AGE and p_cl == p_cl:
            return ('não compra' if abs(p_cl - 1) > band else 'compra'), 'feed'
        if p_dl == p_dl: return ('não compra' if abs(p_dl - 1) > band else 'compra'), 'quórum'
        return 'salta', '—'
    cases = [(e.symbol, e.start, e.recovered_at, cfg[e.symbol]) for _, e in ev.iterrows() if e.symbol in cfg]
    base_cfg = json.load(open(os.path.join(ROOT, 'data', 'series', 'v31', 'executor_registry_base_v31.json')))
    for sym, start, rec_at, c in cases:
        a = start.floor('h') - pd.Timedelta(days=3); b = (rec_at if pd.notna(rec_at) else start + pd.Timedelta(days=10)) + pd.Timedelta(days=3)
        b = min(b, a + pd.Timedelta(days=45)); idx = pd.date_range(a, b, freq='h')
        pc, ag, how = _cl_with_age(sym, idx)
        if pc is None: continue
        dl, _ = T7.dl_hourly(T7.CURATED[sym]); dl = dl[~dl.index.duplicated()].sort_index()
        pdl = dl.reindex(idx, method='nearest', tolerance=pd.Timedelta('1h')).values
        thr = float(c['threshold']) / 100; hb = float(c['heartbeat']); max_age = hb * 90000 / 86400       # Base executor ratio (90 000 s for a 24 h feed)
        for band in BANDS:
            d600 = [decide(pc[i], ag[i], pdl[i], band, thr, max_age, False) for i in range(len(idx))]
            darc = [decide(pc[i], ag[i], pdl[i], band, thr, max_age, True) for i in range(len(idx))]
            ch = [i for i in range(len(idx)) if d600[i][0] != darc[i][0]]
            out600 = [idx[i] for i in range(len(idx)) if d600[i][0] == 'não compra']; outarc = [idx[i] for i in range(len(idx)) if darc[i][0] == 'não compra']
            rows.append(dict(event=f'{sym} · {start.strftime("%b %Y")}', feed=f'Chainlink {sym}/USD · Ethereum ({how})', threshold_pct=thr * 100, heartbeat_s=hb,
                             max_staleness_s=max_age, band_pct=band * 100, hours=len(idx), changed=len(ch),
                             arch_stricter=sum(1 for i in ch if darc[i][0] == 'não compra'), arch_looser=sum(1 for i in ch if d600[i][0] == 'não compra'),
                             out_600=len(out600), out_arch=len(outarc), first_out_600=str(out600[0]) if out600 else '', first_out_arch=str(outarc[0]) if outarc else '',
                             feed_used_600=sum(1 for x in d600 if x[1] == 'feed'), feed_used_arch=sum(1 for x in darc if x[1] == 'feed'),
                             skipped_600=sum(1 for x in d600 if x[0] == 'salta'), skipped_arch=sum(1 for x in darc if x[0] == 'salta'),
                             thr_fits=thr < band))
    # the Base USDC/USD feed itself, every hour since it exists
    u = e3._rounds('USDC_base'); first = pd.to_datetime(u.updatedAt.min(), unit='s').ceil('h')
    idx = pd.date_range(first, '2026-11-06 23:00', freq='h'); ts = e3.to_epoch(idx)
    p, age = e3.sample_rounds(u, ts)
    tok = [t for t in base_cfg['tokens'] if t['symbol'] == 'USDC'][0]
    thr = float(tok['directory_threshold_pct']) / 100; max_age = float(tok['maxStaleness'])
    dls = pv.dl_series('USDC'); pdl = dls.reindex(idx, method='nearest', tolerance=pd.Timedelta('1h')).values
    for band in BANDS:
        d600 = [decide(p[i], age[i], pdl[i], band, thr, max_age, False) for i in range(len(idx))]
        darc = [decide(p[i], age[i], pdl[i], band, thr, max_age, True) for i in range(len(idx))]
        ch = [i for i in range(len(idx)) if d600[i][0] != darc[i][0]]
        rows.append(dict(event=f'USDC na Base · {idx[0].strftime("%b %Y")} – Nov 2026 (sem descolamento)', feed='Chainlink USDC/USD · Base (todas as rondas)', threshold_pct=thr * 100,
                         heartbeat_s=86400, max_staleness_s=max_age, band_pct=band * 100, hours=len(idx), changed=len(ch),
                         arch_stricter=sum(1 for i in ch if darc[i][0] == 'não compra'), arch_looser=sum(1 for i in ch if d600[i][0] == 'não compra'),
                         out_600=sum(1 for x in d600 if x[0] == 'não compra'), out_arch=sum(1 for x in darc if x[0] == 'não compra'),
                         first_out_600='', first_out_arch='', feed_used_600=sum(1 for x in d600 if x[1] == 'feed'), feed_used_arch=sum(1 for x in darc if x[1] == 'feed'),
                         skipped_600=sum(1 for x in d600 if x[0] == 'salta'), skipped_arch=sum(1 for x in darc if x[0] == 'salta'), thr_fits=thr < band))
    return pd.DataFrame(rows)

# ------------------------------------------------------------------ §1 the warning table X -> (N, R)
def warning_table():
    ev = pd.read_csv(os.path.join(ROOT, 'results', 'v3', 't7_events.csv'), parse_dates=['start'])
    daily = pd.read_csv(os.path.join(T7.ST, 'dl_daily_all_usd.csv'))
    u0 = pd.to_datetime(daily.date.min(), unit='s').normalize()             # the whole universe is covered from here
    D = int((T7.DATA_END.normalize() - u0).days)
    ok = ev[(ev.hourly_confirmed != False) & (ev.confirmed != False) & (ev.start >= u0)]
    rec80 = int(ok[(ok.max_drop_pct >= 80) & ok.recovered].gecko_id.nunique())
    rows = []
    for X in range(10, 101, 5):
        e = ok[ok.max_drop_pct > X]
        N = int(e.gecko_id.nunique()); R = int(e[e.recovered].gecko_id.nunique())
        if N == 0: s1 = ''
        elif R == 0: s1 = f'Das {N} stables que caíram mais de {X}%, nenhuma recuperou.'
        else: s1 = f'Das {N} stables que caíram mais de {X}%, só {R} recuperou.' if R == 1 else f'Das {N} stables que caíram mais de {X}%, só {R} recuperaram.'
        s2 = f'Nenhuma stable, nos últimos {D} dias, recuperou de uma queda de 80%.'
        txt = ' '.join(x for x in (s1, s2, 'Ainda assim, quer avançar?') if x)
        problems = []
        if N == 0: problems.append('ninguém caiu tanto: a 1.ª frase não se pode dizer')
        if N and R and R >= N: problems.append('«só» seria falso')
        if rec80: problems.append('a 2.ª frase seria falsa')
        rows.append(dict(band_pct=X, N_stables=N, R_stables=R, N_events=len(e), R_events=int(e.recovered.sum()), days=D, universe_from=str(u0.date()),
                         text=txt, problems='; '.join(problems)))
    return pd.DataFrame(rows)

if __name__ == '__main__':
    warning_table().to_csv(os.path.join(R31, 'aviso_banda.csv'), index=False)
    print(pd.read_csv(os.path.join(R31, 'aviso_banda.csv')).to_string())
