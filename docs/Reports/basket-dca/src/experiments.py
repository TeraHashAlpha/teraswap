"""One function per section of the Architect's request (§2.1-2.9). Each writes results/*.csv."""
import os, sys, itertools, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scenarios as sc, series as S
from scenarios import SPLITS, D, ticks, run_position, record
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'results'); os.makedirs(RES, exist_ok=True)

def stress_windows():
    w = {k: (D(a), D(b), l) for k, (a, b, l) in sc.STRESS.items()}
    dd, peak, trough = sc.find_s6()
    w['S6'] = (peak, peak + pd.Timedelta(days=30),
               f'Pior queda de 30 d do ETH em 2025-26 (−{dd*100:.1f}% entre {peak.day}/{peak.month} e {trough.day}/{trough.month}/{trough.year})'.replace('.', ','))
    w['S7'] = (D('2022-06-29'), D('2022-07-28'),
               'Maior volatilidade de 30 d fora de S1–S6 (subida pós-Celsius)')
    return w

def _durations(k, a, b):
    """'janela' = whole window; '30d-pior-dia' = 30 days from the worst ETH day in the window."""
    wd, _ = sc.worst_day(a, b)
    return [('janela', a, b), ('30d-pior-dia', wd, wd + pd.Timedelta(days=29))]

def sec_2_1(dd=None, mode='soft', tag='2.1'):
    rows, objs = [], {}
    for k, (a, b, label) in stress_windows().items():
        for dname, s0, e0 in _durations(k, a, b):
            for cad in (1, 7):
                td = ticks(s0, cad, end=e0)
                for sp, w in SPLITS.items():
                    out, meta = run_position(('ETH', 'BTC', 'USDC'), w, td, cad,
                                             dd_threshold=dd, dd_mode=mode)
                    if out is None: continue
                    base = dict(section=tag, window=k, window_label=label, duration=dname,
                                cadence_d=cad, split=sp, legs='ETH+BTC+USDC',
                                dd_threshold=dd, dd_mode=mode if dd else None)
                    for st, r in out.items():
                        rows.append(record(base, st, r, meta))
                    objs[(k, dname, cad, sp)] = (out, meta)
    df = pd.DataFrame(rows)
    return df, objs

def volatile_months():
    e = S.raw('ETH'); lr = np.log(e / e.shift(1)).loc['2022-01-01':'2025-12-31']
    m = lr.groupby([lr.index.year, lr.index.month]).std() * np.sqrt(365) * 100
    out = []
    for y in (2022, 2023, 2024, 2025):
        for mo, vol in m.loc[y].sort_values(ascending=False).head(3).items():
            out.append((y, mo, float(vol)))
    return out

def _month_bounds(y, mo):
    a = D(f'{y}-{mo:02d}-01'); b = a + pd.offsets.MonthEnd(0)
    return a, b

def sec_2_2():
    rows = []
    months = volatile_months()
    variants = [('base', ('ETH', 'BTC', 'USDC')), ('USDT', ('ETH', 'BTC', 'USDT')),
                ('SOL', ('ETH', 'SOL', 'USDC')), ('XRP', ('ETH', 'XRP', 'USDC')), ('CRV', ('ETH', 'CRV', 'USDC'))]
    for (y, mo, vol), (vname, legs), (sp, w) in itertools.product(months, variants, SPLITS.items()):
        a, b = _month_bounds(y, mo)
        out, meta = run_position(legs, w, ticks(a, 1, end=b), 1)
        if out is None:
            rows.append(dict(section='2.2', variant=vname, month=f'{y}-{mo:02d}', split=sp, missing=True)); continue
        base = dict(section='2.2', variant=vname, month=f'{y}-{mo:02d}', month_vol=vol, split=sp,
                    cadence_d=1, legs='+'.join(legs), duration='mês')
        for st, r in out.items(): rows.append(record(base, st, r, meta))
    # short cycles: consecutive 5-tick daily positions tiled through each volatile month
    for (y, mo, vol), (sp, w) in itertools.product(months, SPLITS.items()):
        a, b = _month_bounds(y, mo); s0 = a
        while s0 + pd.Timedelta(days=4) <= b:
            out, meta = run_position(('ETH', 'BTC', 'USDC'), w, ticks(s0, 1, n=5), 1)
            if out is not None:
                base = dict(section='2.2', variant='ciclos-curtos-5', month=f'{y}-{mo:02d}', month_vol=vol,
                            split=sp, cadence_d=1, legs='ETH+BTC+USDC', duration='5 ciclos')
                for st, r in out.items(): rows.append(record(base, st, r, meta))
            s0 += pd.Timedelta(days=5)
    return pd.DataFrame(rows), months

def sec_2_3():
    rows = []
    starts = pd.date_range('2026-07-01', '2026-10-15', freq='D')
    for s0, dur, cad, (sp, w) in itertools.product(starts, (30, 60, 90), (1, 7), SPLITS.items()):
        e0 = s0 + pd.Timedelta(days=dur - 1)
        if e0 > sc.DATA_END: continue
        out, meta = run_position(('ETH', 'BTC', 'USDC'), w, ticks(s0, cad, end=e0), cad)
        if out is None: continue
        base = dict(section='2.3', start_day=s0.date().isoformat(), duration=f'{dur}d', cadence_d=cad,
                    split=sp, legs='ETH+BTC+USDC')
        for st, r in out.items(): rows.append(record(base, st, r, meta))
    return pd.DataFrame(rows)

def sec_2_4():
    """33-33-33; cadence 1/3/7 d; N = 6/12/26/52 cycles; starts every day inside S5 and inside 2.3."""
    rows = []; w = SPLITS['33-33-33']
    ranges = {'S5': pd.date_range('2025-02-01', '2025-04-15', freq='D'),
              '2.3': pd.date_range('2026-07-01', '2026-10-15', freq='D')}
    for (rname, starts), cad, n in itertools.product(ranges.items(), (1, 3, 7), (6, 12, 26, 52)):
        for s0 in starts:
            td = ticks(s0, cad, n=n)
            if td[-1] > sc.DATA_END: continue
            out, meta = run_position(('ETH', 'BTC', 'USDC'), w, td, cad, strategies=('A', 'B'))
            if out is None: continue
            r = out['A']
            nontrivial = 0
            # ticks (before the last) where >= 2 legs were eligible, i.e. rule 4 actually chose
            for t in range(n - 1):
                pass
            base = dict(section='2.4', range=rname, cadence_d=cad, n_cycles=n, split='33-33-33',
                        start_day=s0.date().isoformat(), legs='ETH+BTC+USDC')
            for st, rr in out.items(): rows.append(record(base, st, rr, meta))
    return pd.DataFrame(rows)

def sec_2_5():
    rows = []
    for thr, mode in itertools.product((0.10, 0.15, 0.20, 0.25, 0.30), ('soft', 'rigid')):
        df, _ = sec_2_1(dd=thr, mode=mode, tag='2.5')
        rows.append(df[df.strategy == 'A'])
    return pd.concat(rows, ignore_index=True)

# ----------------------------------------------------------------------------------- 2.6
DEPEG_EVENTS = {   # id: (stable leg, event start, event end, label)
    'USDC-2023': ('USDC', '2023-03-09', '2023-03-13', 'USDC · SVB (9–13 Mar 2023)'),
    'DAI-2023':  ('DAI',  '2023-03-11', '2023-03-13', 'DAI · exposição a USDC (11–13 Mar 2023)'),
    'USDT-2022': ('USDT', '2022-05-12', '2022-05-12', 'USDT · contágio Terra (12 Mai 2022)'),
    'UST-2022':  ('UST',  '2022-05-07', '2022-05-13', 'UST · Terra, o peg nunca voltou (7–13 Mai 2022)'),
}

def _event_ticks(td, a, b):
    a, b = D(a), D(b) + pd.Timedelta(days=1)   # tick at 00:00 of b+1 still reads the event day
    return [t for t, d in enumerate(td) if a <= d <= b]

def sec_2_6():
    rows, paths = [], {}
    rules = [('sem regra', None, 'soft'), ('banda 1% · fim suave', 0.01, 'soft'), ('banda 2% · fim suave', 0.02, 'soft'),
             ('banda 1% · fim rígido', 0.01, 'rigid'), ('banda 2% · fim rígido', 0.02, 'rigid')]
    for ev, (stable, a, b, label) in DEPEG_EVENTS.items():
        variants = [('±30 d', D(a) - pd.Timedelta(days=30), D(b) + pd.Timedelta(days=30))]
        # same real event, position that ENDS on the worst tick (final-liquidation test)
        s = S.resolve(stable, [D(a) - pd.Timedelta(days=31), D(b) + pd.Timedelta(days=1)])[1]
        if s is None: continue
        worst = s.loc[D(a):D(b) + pd.Timedelta(days=1)].idxmin()
        variants.append(('termina no pior tick', worst - pd.Timedelta(days=30), worst))
        for (vname, s0, e0), (sp, w), (rname, band, sfinal), dd in itertools.product(
                variants, SPLITS.items(), rules, (None, 0.10, 0.20)):
            td = ticks(s0, 1, end=e0)
            out, meta = run_position(('ETH', 'BTC', stable), w, td, 1, strategies=('A', 'B'),
                                     dd_threshold=dd, dd_mode='soft', stable_idx=2 if band else None,
                                     stable_band=band, stable_final=sfinal)
            if out is None: continue
            evt = _event_ticks(td, a, b)
            P = meta['P']
            for st, r in out.items():
                if st == 'B' and (band or dd): continue
                rec = record(dict(section='2.6', event=ev, event_label=label, variant=vname, split=sp,
                                  stable_rule=rname, dd_threshold=dd, legs=f'ETH+BTC+{stable}'), st, r, meta)
                buys = [(t, i, u) for t, i, u, k in r.fills]
                rec['stable_bought_in_event_usd'] = sum(u for t, i, u in buys if i == 2 and t in evt)
                rec['stable_bought_total_usd'] = sum(u for t, i, u in buys if i == 2)
                rec['stable_min_tick_price'] = float(P[:, 2].min())
                rec['stable_price_at_end'] = float(P[-1, 2])
                rec['stable_avg_price'] = rec['avg_price_leg2']
                rec['event_ticks'] = len(evt)
                rec['stable_wins_in_event'] = sum(1 for t, i, u, k in r.fills if i == 2 and t in evt and k == 'select')
                rows.append(rec)
                if vname == '±30 d' and sp == '33-33-33' and dd is None and rname in ('sem regra', 'banda 1% · fim rígido'):
                    paths[(ev, st, rname)] = (td, P, r)
    return pd.DataFrame(rows), paths

def ust_after(days=30):
    """Value, 30 days after the position ended, of the UST bought — the cost of a peg that never came back."""
    u = S.raw('UST'); return u

# ----------------------------------------------------------------------------------- 2.8
def sec_2_8():
    rows = []
    w = SPLITS['33-33-33']; ws = stress_windows()
    a, b, _ = ws['S2']
    cases = [('S2 janela', a, b), ('S2 30d-pior-dia', *_durations('S2', a, b)[1][1:])]
    starts = pd.date_range('2026-07-01', '2026-10-15', freq='7D')
    for s0 in starts:
        for dur in (30, 60, 90):
            e0 = s0 + pd.Timedelta(days=dur - 1)
            if e0 <= sc.DATA_END: cases.append((f'2.3 {dur}d', s0, e0))
    for (cname, s0, e0), cad, (lname, legs) in itertools.product(
            cases, (1, 7), [('3 voláteis', ('ETH', 'BTC', 'SOL')), ('com stable', ('ETH', 'BTC', 'USDC'))]):
        td = ticks(s0, cad, end=e0)
        out, meta = run_position(legs, w, td, cad, strategies=('A', 'B'))
        if out is None: continue
        P = meta['P']; prev = np.vstack([meta['p0'], P[:-1]]); v = P / prev - 1
        rA = out['A']
        sel = [(t, i) for t, i, u, k in rA.fills if k == 'select']
        up_both = [t for t in range(len(td) - 1) if v[t, 0] > 0 and v[t, 1] > 0]
        sel_up = [i for t, i in sel if t in up_both]
        for st, r in out.items():
            rec = record(dict(section='2.8', case=cname, cadence_d=cad, basket=lname, split='33-33-33',
                              legs='+'.join(legs)), st, r, meta)
            if st == 'A':
                rec['ticks_up_both'] = len(up_both)
                rec['leg2_bought_when_both_up_pct'] = 100 * (sum(1 for i in sel_up if i == 2) / len(sel_up)) if sel_up else np.nan
                rec['winner_was_worst_mover_pct'] = 100 * np.mean([i == int(np.argmin(v[t])) for t, i in sel]) if sel else np.nan
                for j in range(3): rec[f'wins_leg{j}'] = sum(1 for t, i in sel if i == j)
            rows.append(rec)
    return pd.DataFrame(rows)

# ----------------------------------------------------------------------------------- 2.9
GAS_PER_FILL = {   # USD per fill, from docs/Reports/FILL-ECONOMICS-CALIBRATION.md (2026-07-22, Base)
    'rota canónica · gas de mercado': 0.003,
    'rota agregador · gas de mercado': 0.016,
    'rota canónica · tier actual do keeper (1,5 gwei)': 0.75,
    'rota agregador · tier actual do keeper (1,5 gwei)': 3.93,
}
FEE = 0.001   # FEE_BPS = 10 (TeraSwapOrderExecutorV3.sol)

def sec_2_9(frames):
    df = pd.concat(frames, ignore_index=True)
    df = df[df.strategy.isin(['A', 'B', 'C'])].copy()
    df['mode'] = df.get('dd_mode').fillna('sem regra 9') if 'dd_mode' in df else 'sem regra 9'
    g = df.groupby(['strategy', 'mode', 'cadence_d', 'n_ticks'])['n_fills'].agg(['size', 'min', 'median', 'max']).reset_index()
    for name, gas in GAS_PER_FILL.items():
        g[f'Cmin_med · {name}'] = g['median'] * gas / FEE
        g[f'Cmin_max · {name}'] = g['max'] * gas / FEE
    return g

# ----------------------------------------------------------------------------------- 2.7
def _hourly(src, key):
    if src == 'chainlink':
        df = pd.read_csv(os.path.join(S.SER, f'cl_hourly_{key}.csv'))
        s = pd.Series(df.price.values, index=pd.to_datetime(df.utc).dt.tz_convert(None))
    elif src == 'defillama':
        df = pd.read_csv(os.path.join(S.SER, f'defillama_{key}_hourly.csv'))
        t = pd.to_datetime(df.ts, unit='s')
        # snap each DefiLlama point to the nearest hour, keep only points within 10 min of it
        h = t.dt.round('h'); ok = (t - h).abs() <= pd.Timedelta(minutes=10)
        s = pd.Series(df.price.values[ok], index=h[ok]).groupby(level=0).last()
    elif src == 'coinbase':
        df = pd.read_csv(os.path.join(S.SER, f'coinbase_{key}_hourly.csv'))
        s = pd.Series(df.open.values, index=pd.to_datetime(df.ts, unit='s'))   # candle open = price at :00
    return s.sort_index().astype(float)

def price_quality(key, cl_key):
    """Real differences between the sources a phase-2 leg would read and the best references."""
    ss = {'DefiLlama (fase 2)': _hourly('defillama', key), 'Coinbase': _hourly('coinbase', key),
          'Chainlink': _hourly('chainlink', cl_key)}
    idx = pd.date_range('2026-07-01', '2026-11-06 23:00', freq='h')
    al = pd.DataFrame({k: v.reindex(idx) for k, v in ss.items()})
    out = []
    for a, b in [('DefiLlama (fase 2)', 'Coinbase'), ('DefiLlama (fase 2)', 'Chainlink'), ('Chainlink', 'Coinbase')]:
        x = al[[a, b]].dropna(); bps = (x[a] / x[b] - 1) * 1e4; ab = bps.abs()
        ra = np.log(al[a]).diff(); rb = np.log(al[b]).diff()
        lags = {L: ra.corr(rb.shift(L)) for L in range(-3, 4)}
        best = max(lags, key=lambda L: lags[L])
        out.append(dict(token=key, a=a, b=b, hours=len(x), missing_a=int(al[a].isna().sum()),
                        median_bps=float(ab.median()), p95_bps=float(ab.quantile(.95)), p99_bps=float(ab.quantile(.99)),
                        max_bps=float(ab.max()), worst_at=str(ab.idxmax()), signed_median_bps=float(bps.median()),
                        n_over_100=int((ab > 100).sum()), n_over_300=int((ab > 300).sum()),
                        best_lag_h=best, corr_lag0=float(lags[0]), corr_best=float(lags[best])))
    return pd.DataFrame(out), al

def _daily_from_hourly(s, dates):
    return np.array([s.get(d, np.nan) for d in dates])

def sec_2_7():
    from engine import run_basket
    q_aero, al_aero = price_quality('AERO', 'AERO')
    q_eth, al_eth = price_quality('ETH', 'ETH_base')
    rows = []
    # rule 4 with each series. Basket ETH + <leg> + USDC; the leg under test is priced by each source
    # for the DECISION; fills are always valued at the reference (Coinbase) price.
    cases = [('AERO', al_aero, ['DefiLlama (fase 2)', 'Chainlink', 'Coinbase'], 'Coinbase'),
             ('ETH', al_eth, ['DefiLlama (fase 2)', 'Chainlink', 'Coinbase'], 'Chainlink')]
    starts = pd.date_range('2026-07-01', '2026-10-15', freq='D')
    for (tok, al, srcs, ref), s0, dur, cad, (sp, w) in itertools.product(cases, starts, (30, 60, 90), (1, 7), SPLITS.items()):
        e0 = s0 + pd.Timedelta(days=dur - 1)
        if e0 > sc.DATA_END: continue
        td = ticks(s0, cad, end=e0); prev0 = td[0] - pd.Timedelta(days=cad); need = [prev0] + td
        if tok == 'AERO':
            other = [S.resolve('ETH', need)[1], S.resolve('USDC', need)[1]]
            legs_desc = 'ETH + AERO + USDC'; pos = 1
        else:
            other = [S.resolve('BTC', need)[1], S.resolve('USDC', need)[1]]
            legs_desc = 'ETH + cbBTC + USDC'; pos = 0
        runs = {}
        for src in srcs:
            leg = _daily_from_hourly(al[src], need)
            if np.isnan(leg).any(): runs[src] = None; continue
            cols = [o.reindex(need).values for o in other]
            cols.insert(pos, leg)
            M = np.column_stack(cols)
            runs[src] = run_basket(M[1:], M[0], w, sc.CAPITAL, True)
        if runs.get(ref) is None: continue
        refleg = _daily_from_hourly(al[ref], need)[1:]
        rsel = {t: i for t, i, u, k in runs[ref].fills if k == 'select'}
        for src, r in runs.items():
            if r is None:
                rows.append(dict(section='2.7', token=tok, source=src, start_day=s0.date().isoformat(), duration=f'{dur}d',
                                 cadence_d=cad, split=sp, missing=True)); continue
            sel = {t: i for t, i, u, k in r.fills if k == 'select'}
            changed = sum(1 for t in set(sel) | set(rsel) if sel.get(t) != rsel.get(t))
            fills_leg = [(t, u) for t, i, u, k in r.fills if i == pos]
            usd = sum(u for t, u in fills_leg); qty = sum(u / refleg[t] for t, u in fills_leg)
            rows.append(dict(section='2.7', token=tok, legs=legs_desc, source=src, reference=ref,
                             start_day=s0.date().isoformat(), duration=f'{dur}d', cadence_d=cad, split=sp,
                             n_ticks=len(td), decisions_changed=changed, decision_ticks=len(td) - 1,
                             deviation_pp=r.deviation_pp, leg_avg_price_at_ref=usd / qty if qty else np.nan))
    return pd.DataFrame(rows), pd.concat([q_aero, q_eth]), al_aero, al_eth

# ----------------------------------------------------------------------------------- extras
def stable_band_calibration():
    """How often each stable's feed sits outside a ±band around 1, on every daily tick 2022-2026
    (false-trigger rate of the proposed rule) and hour by hour inside the real depeg windows."""
    rows = []
    for k in ('USDC', 'USDT', 'DAI'):
        try: s = S.raw(k)
        except FileNotFoundError: continue
        dev = (s - 1).abs()
        for band in (0.005, 0.01, 0.02):
            rows.append(dict(stable=k, scope=f'ticks diários {s.index.min().date()}–{s.index.max().date()}', n=len(s),
                             band_pct=band * 100, ticks_outside=int((dev > band).sum()),
                             dates_outside=', '.join(d.date().isoformat() for d in dev[dev > band].index[:12])))
        p = os.path.join(S.SER, f'cl_hourly_{k}.csv')
        if os.path.exists(p):
            h = pd.read_csv(p).dropna(); dh = (h.price - 1).abs()
            for band in (0.005, 0.01, 0.02, 0.10):
                rows.append(dict(stable=k, scope=f'horário {h.utc.iloc[0][:10]}–{h.utc.iloc[-1][:10]}', n=len(h),
                                 band_pct=band * 100, ticks_outside=int((dh > band).sum()),
                                 dates_outside=f'mín {h.price.min():.4f} às {h.loc[h.price.idxmin(), "utc"][:16]}'))
    return pd.DataFrame(rows)

def feed_staleness():
    """Age of the round the keeper would read at each daily tick, vs ADR-024 MAX_PRICE_AGE_SEC=600."""
    rows = []
    for k in ('ETH', 'ETH_base', 'cbBTC', 'WBTC', 'USDC', 'USDT', 'AERO'):
        p = os.path.join(S.SER, f'cl_daily_{k}.csv')
        if not os.path.exists(p): continue
        d = pd.read_csv(p, parse_dates=['date']).dropna()
        for label, sub in [('todo o período', d), ('desde 1 Jul 2026', d[d.date >= '2026-07-01'])]:
            if sub.empty: continue
            a = sub.age_s
            rows.append(dict(feed=S.SOURCE_LABEL.get(k, k), scope=label, ticks=len(sub), median_age_s=float(a.median()),
                             p90_age_s=float(a.quantile(.9)), max_age_h=float(a.max() / 3600),
                             pct_over_600s=float((a > 600).mean() * 100)))
    return pd.DataFrame(rows)

def fill_sizes(frames):
    """Distribution of individual fill sizes relative to the cycle budget b = C/N (A only)."""
    df = pd.concat(frames, ignore_index=True); A = df[df.strategy == 'A']
    return A[['section', 'n_ticks', 'n_fills', 'n_roll_fills', 'min_roll_fill_usd']].copy()


# ----------------------------------------------------------------------------------- 2.10 / 2.11
def sec_2_10():
    import hourly_events as he
    summary, hits = he.scan()
    return summary, hits, he.feed_view(), he.run_episodes()

def win_summary(frames_keys):
    """frames_keys: list of (label, df, keys, regime_col or None)."""
    import winrates as wr
    rows = []
    for label, df, keys in frames_keys:
        v = wr.pivot_values(df[df.strategy.isin(['A', 'B', 'C'])], keys)
        rows.append(dict(sample=label, **wr.win_table(v)))
    return pd.DataFrame(rows)

def sec_2_11():
    import winrates as wr
    d = wr.rolling_sample()
    keys = ['start_day', 'duration', 'cadence_d', 'split']
    v = wr.pivot_values(d, keys).reset_index()
    meta = d[d.strategy == 'A'][keys + ['eth_vol_pct', 'eth_return_pct']]
    v = v.merge(meta, on=keys)
    rows = []
    for (dur, cad), g in v.groupby(['duration', 'cadence_d']):
        p75 = g.eth_vol_pct.quantile(.75); q = g.eth_vol_pct.quantile([.25, .5, .75]).values
        groups = [('alta volatilidade (25% mais voláteis)', g.eth_vol_pct >= p75), ('normal (restantes 75%)', g.eth_vol_pct < p75),
                  ('ETH caiu na posição', g.eth_return_pct < 0), ('ETH subiu na posição', g.eth_return_pct >= 0)]
        for lab, m in groups:
            t = wr.win_table(g[m].set_index(keys)[['A', 'B', 'C']])
            rows.append(dict(duration=dur, cadence_d=cad, regime=lab, vol_p75=p75, vol_q1=q[0], vol_q2=q[1], **t))
    return d, pd.DataFrame(rows), v
