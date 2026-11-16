"""v3 · the three-volatile basket (owner §0.1) — T8, and the three-volatile halves of T3 and T6.

Main basket  : ETH + cbBTC + X, X in {VIRTUAL, COMP, AERO} (choice and reasons in fetch_v3_x.py).
Second basket: ETH + cbBTC + USDC (v2), run through the same code so every table can show both.

Same real windows as v2 (2.1 S1-S7, 2.2 July anchor months, 2.3 Jul-Oct 2026, 2.11 rolling sample from
31 Mar 2022, 2.10 hourly episodes). A window enters a basket only if every leg has a Chainlink series for
the whole position (X coverage: COMP from Dec 2021 via Ethereum, AERO from Apr 2024, VIRTUAL from Jan 2025);
the rest goes to 'not measured'. Prices: fills at the Chainlink feed (as in v2); decisions with switch P.
"""
import os, sys, itertools, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import series as S, scenarios as sc, experiments as ex, hourly_events as he, prices_v3 as pv, experiments_v3 as e3
from scenarios import SPLITS, ticks
from engine_plus import run_plus
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V3 = pv.V3

BASKETS = {'ETH+cbBTC+VIRTUAL': ('ETH', 'BTC', 'VIRTUAL'), 'ETH+cbBTC+COMP': ('ETH', 'BTC', 'COMP'),
           'ETH+cbBTC+AERO': ('ETH', 'BTC', 'AERO'), 'ETH+cbBTC+USDC': ('ETH', 'BTC', 'USDC')}
VOL3 = [b for b in BASKETS if not b.endswith('USDC')]; STABLE = 'ETH+cbBTC+USDC'
PHASE2_SRC = {'AERO_base'}
RETRY = 3            # owner, 7 Nov 2026: the last cycle waits up to 3 cycles for a usable price, then closes

# ------------------------------------------------------------------ per-source daily tables (fast path)
_tab = {}
def src_table(src):
    """Daily 00:00 UTC: execution price (Chainlink), decision price (switch P) and its source code."""
    if src in _tab: return _tab[src]
    try:
        if src in pv.XLABEL:
            pe, age = pv.x_daily(src)
            if src in PHASE2_SRC: age = pd.Series(np.inf, index=pe.index)
        else:
            pe = S.raw(src); age = pv.daily_age(src).reindex(pe.index)
    except FileNotFoundError:
        _tab[src] = None; return None
    dk = pv.DL_KEY.get(src)
    ok = (age.values <= pv.MAX_AGE)
    pdv = np.where(ok, pe.values, np.nan); code = np.where(ok, 0, 2)
    for i in np.where(~ok)[0]:
        x = pv.dl_at(dk, pe.index[i]) if dk else np.nan
        if x == x: pdv[i] = x; code[i] = 1
    _tab[src] = pd.DataFrame(dict(pe=pe.values, pd=pdv, code=code), index=pe.index)
    return _tab[src]

def candidates(leg): return pv.XSRC.get(leg) or S.PRIORITY.get(leg, [leg])

def mats(legs, td, cad):
    need = [td[0] - pd.Timedelta(days=cad)] + list(td)
    srcs, cols = [], []
    for leg in legs:
        got = None
        for src in candidates(leg):
            t = src_table(src)
            if t is None: continue
            x = t.reindex(need)
            if x.pe.notna().all(): got = (src, x); break
        if got is None: return None
        srcs.append(got[0]); cols.append(got[1])
    M = np.column_stack([c.pe.values for c in cols]); D = np.column_stack([c.pd.values for c in cols])
    C = np.column_stack([c.code.values for c in cols]).astype(int)
    extra = [td[-1] + pd.Timedelta(days=cad * k) for k in range(1, RETRY + 1)]
    R = [src_table(sv).reindex(extra) for sv in srcs]
    rPe = np.column_stack([x.pe.values for x in R]); rPd = np.column_stack([x.pd.values for x in R])
    rPe = np.where(np.isnan(rPe), rPd, rPe)
    return dict(Pe=M[1:], p0=M[0], Pd=D[1:], pd0=D[0], code=C[1:], sources=srcs, dates=list(td), rPe=rPe, rPd=rPd,
                retry_beyond_data=bool(extra[-1] > sc.DATA_END))

# ------------------------------------------------------------------ position sets (meta, ticks, cadence)
def set_22():
    for (y, mo, vol) in ex.volatile_months():
        a, b = ex._month_bounds(y, mo)
        for sp in SPLITS:
            yield dict(set='2.2', month=f'{y}-{mo:02d}', duration='mês', cadence_d=1, split=sp), ticks(a, 1, end=b), 1
        s0 = a
        while s0 + pd.Timedelta(days=4) <= b:
            for sp in SPLITS:
                yield dict(set='2.2', month=f'{y}-{mo:02d}', duration='5 ciclos', cadence_d=1, split=sp, start_day=s0.date().isoformat()), ticks(s0, 1, n=5), 1
            s0 += pd.Timedelta(days=5)

def daily_positions(legs, sets):
    for gen in sets:
        for meta, td, cad in gen:
            m = mats(legs, td, cad)
            if m is not None: yield meta, m

# hourly episodes -----------------------------------------------------
_xh = {}
def x_hourly(src):
    if src not in _xh:
        p = os.path.join(V3, f'cl_hourly_ep_{src}.csv')
        if not os.path.exists(p): _xh[src] = None
        else:
            d = pd.read_csv(p).dropna(subset=['price']); ix = pd.to_datetime(d.utc).dt.tz_convert(None)
            _xh[src] = (pd.Series(d.price.values, index=ix).astype(float), pd.Series(d.age_s.values, index=ix).astype(float))
    return _xh[src]

def set_210x(legs):
    """ETH and the BTC feed exactly as in v2 §2.10; third leg = X read hour by hour (or v2's stable leg)."""
    for ep, (h, asset, label, _legs, strict) in he.EPISODES.items():
        fks = he.leg_feeds(ep)
        ser = [he.leg_series(fk) for fk in fks[:2]]; ages = [e3.hourly_age(fk) for fk in fks[:2]]; dls = [e3.HDL[fk] for fk in fks[:2]]
        srcs = [fks[0][0], fks[1][0]]
        for cad_h, n, s0 in he.position_plan(ep):
            td = [s0 + pd.Timedelta(hours=cad_h * k) for k in range(n)]; need = [s0 - pd.Timedelta(hours=cad_h)] + td
            if legs[2] == 'USDC':
                fk3 = fks[2]; s3 = he.leg_series(fk3); a3 = e3.hourly_age(fk3); d3 = e3.HDL[fk3]; src3 = fk3[0]
            else:
                src3 = None
                for src in pv.XSRC[legs[2]]:
                    xh = x_hourly(src)
                    if xh is None: continue
                    if all(t in xh[0].index for t in need): src3 = src; s3, a3 = xh; break
                if src3 is None: continue
                d3 = pv.DL_KEY[src3]
                if src3 in PHASE2_SRC: a3 = pd.Series(np.inf, index=s3.index)
            S3 = ser + [s3]; A3 = ages + [a3]; D3 = dls + [d3]
            try: M = np.array([[s[t] for s in S3] for t in need])
            except KeyError: continue
            Pd = np.full(M.shape, np.nan); code = np.full(M.shape, 2, int)
            for j in range(3):
                for i, t in enumerate(need):
                    a = A3[j].get(t, np.nan)
                    if a == a and a <= pv.MAX_AGE: Pd[i, j] = M[i, j]; code[i, j] = 0
                    else:
                        x = pv.dl_at(D3[j], t)
                        if x == x: Pd[i, j] = x; code[i, j] = 1
            # retry rows (owner's 3-cycle rule): decision price at the next 3 cycles; execution at the feed if we hold
            # that hour, else at the decision price (declared approximation, only used when the last cycle had no price)
            extra = [td[-1] + pd.Timedelta(hours=cad_h * k) for k in range(1, RETRY + 1)]
            rPd = np.full((RETRY, 3), np.nan); rPe = np.full((RETRY, 3), np.nan)
            for j in range(3):
                for i, t in enumerate(extra):
                    a = A3[j].get(t, np.nan)
                    if a == a and a <= pv.MAX_AGE and t in S3[j].index: rPd[i, j] = S3[j][t]
                    else:
                        x = pv.dl_at(D3[j], t)
                        if x == x: rPd[i, j] = x
                    rPe[i, j] = S3[j][t] if t in S3[j].index else rPd[i, j]
            m = dict(Pe=M[1:], p0=M[0], Pd=Pd[1:], pd0=Pd[0], code=code[1:], sources=srcs + [src3], dates=td, rPe=rPe, rPd=rPd,
                     retry_beyond_data=False)
            for sp in SPLITS:
                yield dict(set='2.10', episode=ep, cadence_h=cad_h, n_ticks=n, start=str(s0), split=sp), m

# ------------------------------------------------------------------ T3 (three volatile first, then the stable basket)
def t3x():
    rows = []
    for bname, legs in BASKETS.items():
        pos = list(daily_positions(legs, [(x for x in e3.set_21())])) + list(set_210x(legs))
        for meta, m in pos:
            w = SPLITS[meta['split']]; N = len(m['dates'])
            for thr in e3.THRS:
                base = None
                for k, cap in itertools.product(e3.KS, e3.CAPS):
                    r = run_plus(m['Pe'], w, p0=m['p0'], dd=thr, mode='soft', k=k, cap=cap)
                    if k == 1 and cap is None: base = r
                    prot_legs = [i for i in range(3) if r.protect_ticks.get(i, 0) > 0]
                    apx = r.avg_price
                    nofill = N - len({f[0] for f in r.fills})
                    rows.append(dict(meta, basket=bname, x=legs[2], src3=m['sources'][2], n_ticks=N, threshold=thr, k=k, cap=cap if cap else 0.0,
                                     max_fill_pct=r.max_fill_pct, dev_pp=r.deviation_pp, unin_pct=r.uninvested_pct,
                                     protected=bool(prot_legs), n_prot_legs=len(prot_legs), n_fills=r.n_fills,
                                     all_prot_ticks=r.all_protected_ticks, all_prot_maxrun=r.all_protected_maxrun,
                                     ticks_without_fill=nofill,
                                     final_tick_share_pct=100 * sum(f[2] for f in r.fills if f[0] == N - 1) / r.capital,
                                     deferred_px_vs_k1_pct=float(np.mean([(apx[i] / base.avg_price[i] - 1) * 100 for i in prot_legs])) if prot_legs and base is not None and (k > 1 or cap) else np.nan,
                                     val=e3.value(r, m['Pe'])))
    return pd.DataFrame(rows)

def t3_recommend_x(d, min_ticks=6):
    """Simplest combination (no cap before cap, then smallest k) with max fill <= 20% and deviation 0 in every
    window of EVERY basket. Positions with fewer than 6 cycles are excluded (one normal cycle is already C/N > 16.7%)."""
    out = []
    for thr in e3.THRS:
        x = d[(d.threshold == thr) & (d.n_ticks >= min_ticks)]
        g = x.groupby(['k', 'cap']).agg(max_fill=('max_fill_pct', 'max'), dev=('dev_pp', 'max'), unin=('unin_pct', 'max')).reset_index()
        g['ok'] = (g.max_fill <= 20 + 1e-9) & (g.dev < 1e-6)
        g['order'] = g.apply(lambda r: (0 if r.cap == 0 else 1, r.k, -r.cap if r.cap else 0), axis=1)
        g = g.sort_values('order'); best = g[g.ok].head(1)
        out.append(dict(threshold=thr, min_ticks=min_ticks, k=int(best.k.iloc[0]) if len(best) else None,
                        cap=float(best.cap.iloc[0]) if len(best) else None, max_fill=float(best.max_fill.iloc[0]) if len(best) else None,
                        best_nocap_k=int(g[g.cap == 0].sort_values('max_fill').k.iloc[0]), best_nocap_max_fill=float(g[g.cap == 0].max_fill.min())))
    return pd.DataFrame(out)

# ------------------------------------------------------------------ T6 + T8: A+ vs B+ vs ETH-only, both baskets
def maxrun(flags):
    b = r_ = 0
    for f in flags:
        r_ = r_ + 1 if f else 0; b = max(b, r_)
    return b

def strategies(m, w, stable, rec, min_fill, thr):
    kw = dict(Pd=m['Pd'], pd0=m['pd0'], dd=thr, mode='soft', k=rec['k'], cap=rec['cap'], min_fill=min_fill, final_retry=True,
              retry_Pe=m['rPe'], retry_Pd=m['rPd'])
    if stable: kw.update(stable_idx=2, band=0.01)
    out = {'A+': run_plus(m['Pe'], w, **kw), 'B+': run_plus(m['Pe'], w, **kw, select=False),
           'A+ rotação': run_plus(m['Pe'], w, **kw, signal='rotacao')}
    kw_noP = {k_: v_ for k_, v_ in kw.items() if k_ not in ('Pd', 'pd0', 'retry_Pe', 'retry_Pd')}
    out['A+ sem P'] = run_plus(m['Pe'], w, p0=m['p0'], **kw_noP)
    out['C'] = run_plus(m['Pe'][:, :1], [1.0], p0=m['p0'][:1], select=False)
    return out

def rotation(m, rA):
    """Ticks where two legs rose and one fell (decision prices, P on): which leg the cycle bought."""
    Pd = m['Pd']; prev = np.vstack([m['pd0'], Pd[:-1]]); v = Pd / prev - 1; N = len(Pd)
    t21 = [t for t in range(N - 1) if not np.isnan(v[t]).any() and (v[t] > 0).sum() == 2 and (v[t] < 0).sum() == 1]
    pick = [rA.primary.get(t) for t in t21]
    down = [int(np.argmin(v[t])) for t in t21]
    hit = sum(1 for p, d in zip(pick, down) if p == d); bought = sum(1 for p in pick if p is not None)
    return len(t21), hit, bought

def t68x(rec, min_fill=e3.MINFILL['agregador'], thr=0.25, baskets=None):
    rows = []
    for bname in (baskets or BASKETS):
        legs = BASKETS[bname]; stable = bname == STABLE
        gens = [('2.1', lambda: daily_positions(legs, [e3.set_21()])), ('2.2', lambda: daily_positions(legs, [set_22()])),
                ('2.3', lambda: daily_positions(legs, [e3.set_23()])), ('2.11', lambda: daily_positions(legs, [e3.set_211()])),
                ('2.10', lambda: set_210x(legs))]
        for sname, g in gens:
            for meta, m in g():
                w = np.asarray(SPLITS[meta['split']]); N = len(m['dates'])
                out = strategies(m, w, stable, rec, min_fill, thr)
                a, b_, c = out['A+'], out['B+'], out['C']
                n21, hit, bought = rotation(m, a)
                n21r, hitr, _ = rotation(m, out['A+ rotação'])
                changedP = sum(1 for t in range(N - 1) if a.primary.get(t) != out['A+ sem P'].primary.get(t))
                code = m['code']
                for st, r in out.items():
                    if st == 'A+ sem P': continue
                    rec_ = dict(meta, basket=bname, x=legs[2], src3=m['sources'][2], strategy=st, n_ticks=N,
                                val=float((r.qty * (m['Pe'][-1] if st != 'C' else m['Pe'][-1, :1])).sum() + r.cash_left),
                                mdd_pct=r.max_drawdown_pct, n_fills=r.n_fills, unin_pct=r.uninvested_pct,
                                max_fill_pct=r.max_fill_pct)
                    if st != 'C':
                        lock_early = sum(1 for i in range(3) if r.lock_tick[i] is not None and not r.lock_via_final[i])
                        prot_t = {t for t, i in r.prot_marks}
                        rec_.update(dev_pp=r.deviation_pp, px0=r.avg_price[0], px1=r.avg_price[1], px2=r.avg_price[2],
                                    units_vs_Bplus_pct=float(np.sum(w * (b_.avg_price / r.avg_price - 1)) * 100) if st != 'B+' else 0.0,
                                    gas_can=r.n_fills * e3.GAS['canónica'], gas_agg=r.n_fills * e3.GAS['agregador'],
                                    final_tick_share_pct=100 * sum(f[2] for f in r.fills if f[0] == N - 1) / r.capital,
                                    n_cooldown=len(r.cooldown_ticks),
                                    locks_early=lock_early, prot_ticks_any=len(prot_t), all_prot_ticks=r.all_protected_ticks,
                                    all_prot_maxrun=r.all_protected_maxrun, skipped_all=r.skipped_all, band_ticks=r.stable_block_ticks,
                                    final_retry_legs=r.final_unusable_legs, retry_waited_max=max(r.retry_waited.values(), default=0),
                                    unbought_usd=r.unbought_usd, unbought_why=' | '.join(sorted({w_ for w_, _ in r.unbought.values()})),
                                    retry_beyond_data=m.get('retry_beyond_data', False))
                    if st == 'A+':
                        rec_.update(ticks_2up1down=n21, picked_down_leg=hit, picked_any=bought, decisions_changed_by_P=changedP,
                                    decision_ticks=N - 1, cl3=int((code[:, 2] == 0).sum()), dl3=int((code[:, 2] == 1).sum()),
                                    none3=int((code[:, 2] == 2).sum()), none_any=int((code == 2).any(axis=1).sum()))
                    if st == 'A+ rotação':
                        rec_.update(ticks_2up1down=n21r, picked_down_leg=hitr)
                    rows.append(rec_)
    return pd.DataFrame(rows)

# ------------------------------------------------------------------ T8 · X without a feed (phase 2): quorum vs reference
def _hourly_open(path, ts_col='ts'):
    d = pd.read_csv(path); return pd.Series(d.open.values, index=pd.to_datetime(d[ts_col], unit='s')).sort_index()

def t8_phase2():
    """AERO as the keeper would price it in phase 2 (no Chainlink leg): quorum approximated by DefiLlama
    (declared; CoinGecko serves no history without a key). Reference = Coinbase AERO-USD (open of the hour)."""
    out = {}
    cb = _hourly_open(os.path.join(V3, 'coinbase_AERO-USD_hourly.csv'))
    dl = pv.dl_series('AERO')
    # 1) availability and agreement, daily 00:00 and hourly, over the whole common history
    rows = []
    for scope, freq in (('diário 00:00', 'D'), ('horário', 'h')):
        g = pd.date_range(max(cb.index.min(), dl.index.min()).ceil('D'), '2026-11-06', freq=freq)
        q = np.array([pv.dl_at('AERO', t) for t in g]); ref = cb.reindex(g).values
        has = ~np.isnan(q); both = has & ~np.isnan(ref)
        bps = np.abs(q[both] / ref[both] - 1) * 1e4
        rows.append(dict(scope=scope, from_=str(g[0].date()), ticks=len(g), no_quorum=int((~has).sum()), no_quorum_pct=float((~has).mean() * 100),
                         compared=int(both.sum()), median_bps=float(np.median(bps)), p95_bps=float(np.percentile(bps, 95)), max_bps=float(bps.max()),
                         over_300bps=int((bps > 300).sum()), over_300bps_pct=float((bps > 300).mean() * 100)))
    out['availability'] = pd.DataFrame(rows)
    # 2) decisions: rule 4 with AERO from the quorum vs from the reference (ETH/cbBTC identical in both runs)
    legs = BASKETS['ETH+cbBTC+AERO']; drows = []
    cbd = cb.copy()
    for sname, gen in (('2.1', e3.set_21()), ('2.3', e3.set_23()), ('2.11', e3.set_211())):
        for meta, td, cad in gen:
            m = mats(legs, td, cad)
            if m is None: continue
            need = [td[0] - pd.Timedelta(days=cad)] + list(td)
            ref = cbd.reindex(need).values
            if np.isnan(ref).any(): continue
            Pr = m['Pd'].copy(); Pr[:, 2] = ref[1:]; pr0 = m['pd0'].copy(); pr0[2] = ref[0]
            w = SPLITS[meta['split']]; N = len(td)
            rq = run_plus(m['Pe'], w, Pd=m['Pd'], pd0=m['pd0']); rr = run_plus(m['Pe'], w, Pd=Pr, pd0=pr0)
            ch = sum(1 for t in range(N - 1) if rq.primary.get(t) != rr.primary.get(t))
            drows.append(dict(meta, n_ticks=N, changed=ch, decision_ticks=N - 1, skipped_leg=int(np.isnan(m['Pd'][:, 2]).sum()),
                              dev_pp=rq.deviation_pp))
    # hourly, Jul-Oct 2026: every leg at the exchange (isolates AERO) and 'as the keeper' (Base feeds + quorum)
    idx = pd.date_range('2026-06-30', '2026-11-06 23:00', freq='h')
    exch = [_hourly_open(os.path.join(S.SER, 'coinbase_ETH_hourly.csv')).reindex(idx),
            _hourly_open(os.path.join(S.SER, 'hourly_exchange', 'coinbase_BTC-USD.csv')).reindex(idx), cb.reindex(idx)]
    def clh(path):
        d = pd.read_csv(path); return pd.Series(d.price.values, index=pd.to_datetime(d.utc).dt.tz_convert(None)).reindex(idx)
    feed = [clh(os.path.join(S.SER, 'cl_hourly_ETH_base.csv')), clh(os.path.join(V3, 'cl_hourly_cbBTC.csv'))]
    q = pd.Series([pv.dl_at('AERO', t) for t in idx], index=idx)
    for s0, sp in itertools.product(pd.date_range('2026-07-01', '2026-11-03', freq='12h'), SPLITS):
        td = [s0 + pd.Timedelta(hours=i) for i in range(72)]; need = [s0 - pd.Timedelta(hours=1)] + td
        X = np.column_stack([c.reindex(need).values for c in exch])
        if np.isnan(X).any(): continue
        rx = run_plus(X[1:], SPLITS[sp], p0=X[0])
        for vname, cols in (('só AERO pelo quórum', [exch[0], exch[1], q]), ('como a keeper (feeds Base + quórum AERO)', [feed[0], feed[1], q])):
            D = np.column_stack([c.reindex(need).values for c in cols])
            rf = run_plus(X[1:], SPLITS[sp], Pd=D[1:], pd0=D[0])
            ch = sum(1 for t in range(71) if rx.primary.get(t) != rf.primary.get(t))
            drows.append(dict(set='horário Jul–Out 2026', variant=vname, start=str(s0), split=sp, n_ticks=72, changed=ch, decision_ticks=71,
                              skipped_leg=int(np.isnan(D[1:, 2]).sum()), dev_pp=rf.deviation_pp))
    out['decisions'] = pd.DataFrame(drows)
    return out

# ------------------------------------------------------------------ coverage (for 'not measured')
def coverage():
    rows = []
    for bname, legs in BASKETS.items():
        src = candidates(legs[2])
        first = min(src_table(s).index.min() for s in src if src_table(s) is not None)
        rows.append(dict(basket=bname, third_leg_sources=' → '.join(pv.XLABEL.get(s, S.SOURCE_LABEL.get(s, s)) for s in src), from_=str(first.date())))
    return pd.DataFrame(rows)
