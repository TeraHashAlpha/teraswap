"""v3 — measuring the Architect's improvements (A+) before they go into the spec. Real windows only:
the same position sets as v2 (2.1, 2.3, 2.11/2.12 and the 2.10 hourly episodes)."""
import os, sys, json, itertools, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import series as S, scenarios as sc, experiments as ex, hourly_events as he, prices_v3 as pv
from scenarios import SPLITS, ticks
from engine_plus import run_plus
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAS = {'canónica': 0.003, 'agregador': 0.016}; FEE = 0.001
MINFILL = {'canónica': 3.0, 'agregador': 16.0}           # max(1 USD, gas / 0.001)

# ------------------------------------------------------------------ position sets
def set_21():
    for k, (a, b, lab) in ex.stress_windows().items():
        for dname, s0, e0 in ex._durations(k, a, b):
            for cad in (1, 7):
                for sp in SPLITS:
                    yield dict(set='2.1', window=k, duration=dname, cadence_d=cad, split=sp), ticks(s0, cad, end=e0), cad

def set_23():
    for s0, dur, cad, sp in itertools.product(pd.date_range('2026-07-01', '2026-10-15', freq='D'), (30, 60, 90), (1, 7), SPLITS):
        e0 = s0 + pd.Timedelta(days=dur - 1)
        if e0 <= sc.DATA_END:
            yield dict(set='2.3', start_day=s0.date().isoformat(), duration=f'{dur}d', cadence_d=cad, split=sp), ticks(s0, cad, end=e0), cad

def set_211():
    e = S.raw('ETH'); lr = np.log(e / e.shift(1))
    for dur, cad in ((30, 1), (90, 1), (90, 7)):
        for s0 in pd.date_range('2022-03-31', '2026-10-06', freq='D'):
            e0 = s0 + pd.Timedelta(days=dur - 1)
            if e0 > sc.DATA_END: continue
            vol = float(lr.loc[s0 + pd.Timedelta(days=1):e0].std() * np.sqrt(365) * 100)
            for sp in SPLITS:
                yield dict(set='2.11', start_day=s0.date().isoformat(), duration=f'{dur}d', cadence_d=cad, split=sp, eth_vol_pct=vol), ticks(s0, cad, end=e0), cad

_mcache = {}
def daily_m(legs, td, cad):
    key = (legs, td[0], td[-1], cad, len(td))
    if key not in _mcache: _mcache[key] = pv.daily_matrices(legs, td, cad)
    return _mcache[key]

# hourly episodes ------------------------------------------------------
HDL = {('ETH',): 'ETH', ('cbBTC',): 'cbBTC', ('WBTC',): 'WBTC', ('WBTC_BTC_mainnet', 'BTC_mainnet'): 'WBTC',
       ('BTC_mainnet',): 'BTC', ('USDC',): 'USDC', ('UST_ETH', 'ETH_mainnet'): 'UST'}
_hage = {}
def hourly_age(fk):
    if fk not in _hage:
        ages = []
        for k in fk:
            d = pd.read_csv(os.path.join(he.HF, f'cl_{k}.csv')).dropna(subset=['price'])
            ages.append(pd.Series(d.age_s.values, index=pd.to_datetime(d.utc).dt.tz_convert(None)).astype(float))
        _hage[fk] = pd.concat(ages, axis=1).max(axis=1)
    return _hage[fk]

def set_210():
    for ep, (h, asset, label, legs, strict) in he.EPISODES.items():
        fks = he.leg_feeds(ep); ser = [he.leg_series(fk) for fk in fks]
        for cad_h, n, s0 in he.position_plan(ep):
            td = [s0 + pd.Timedelta(hours=cad_h * k) for k in range(n)]; need = [s0 - pd.Timedelta(hours=cad_h)] + td
            try: M = np.array([[s[t] for s in ser] for t in need])
            except KeyError: continue
            Pd = np.full(M.shape, np.nan)
            for j, fk in enumerate(fks):
                ag = hourly_age(fk)
                for i, t in enumerate(need):
                    a = ag.get(t, np.nan)
                    if a == a and a <= pv.MAX_AGE: Pd[i, j] = M[i, j]
                    else: Pd[i, j] = pv.dl_at(HDL[fk], t)
            m = dict(Pe=M[1:], p0=M[0], Pd=Pd[1:], pd0=Pd[0], sources=[f[0] for f in fks], dates=td)
            for sp in SPLITS:
                yield dict(set='2.10', episode=ep, cadence_h=cad_h, n_ticks=n, start=str(s0), split=sp), m

def iter_daily(sets):
    for gen in sets:
        for meta, td, cad in gen:
            m = daily_m(('ETH', 'BTC', 'USDC'), td, cad)
            if m is not None: yield meta, m

def value(r, Pe): return float((r.qty * Pe[-1]).sum() + r.cash_left)
def dev_usd(r): return float(np.max(np.abs(r.spent - r.weights * r.capital)))

# ------------------------------------------------------------------ T1  single price
def t1():
    rows = []
    for meta, m in iter_daily([set_21(), set_23(), set_211()]):
        w = SPLITS[meta['split']]; N = len(m['dates'])
        a = run_plus(m['Pe'], w, p0=m['p0'])
        ap = run_plus(m['Pe'], w, Pd=m['Pd'], pd0=m['pd0'])
        bb = run_plus(m['Pe'], w, p0=m['p0'], select=False)
        changed = sum(1 for t in range(N - 1) if a.primary.get(t) != ap.primary.get(t))
        code = m['code']
        rec = dict(meta, n_ticks=N, decisions_changed=changed, decision_ticks=N - 1,
                   dev_v2=a.deviation_pp, dev_P=ap.deviation_pp, unin_P=ap.uninvested_pct, skipped_all=ap.skipped_all,
                   val_v2=value(a, m['Pe']), val_P=value(ap, m['Pe']), val_B=value(bb, m['Pe']),
                   src_btc=m['sources'][1])
        for j, leg in enumerate(('eth', 'btc', 'usdc')):
            rec[f'cl_{leg}'] = int((code[:, j] == 0).sum()); rec[f'dl_{leg}'] = int((code[:, j] == 1).sum()); rec[f'none_{leg}'] = int((code[:, j] == 2).sum())
        rows.append(rec)
    return pd.DataFrame(rows)

# ------------------------------------------------------------------ T2  minimum fill
def t2():
    rows = []
    for meta, m in iter_daily([set_21(), set_23()]):
        w = SPLITS[meta['split']]
        for C in (100, 250, 1000):
            base = run_plus(m['Pe'], w, C, p0=m['p0'])
            for route, mf in MINFILL.items():
                r = run_plus(m['Pe'], w, C, p0=m['p0'], min_fill=mf)
                N = len(m['dates'])
                nonfinal = [f[2] for f in r.fills if f[0] < N - 1]; fin = [f[2] for f in r.fills if f[0] == N - 1]
                rows.append(dict(meta, capital=C, route=route, min_fill=mf, n_ticks=N, fills_base=base.n_fills, fills_M=r.n_fills,
                                 min_fill_nonfinal=min(nonfinal) if nonfinal else np.nan, min_fill_final=min(fin) if fin else np.nan,
                                 min_fill_base=min(f[2] for f in base.fills), dev_usd=dev_usd(r), dev_pp=r.deviation_pp,
                                 unin_usd=r.cash_left, gas_base=base.n_fills * GAS[route], gas_M=r.n_fills * GAS[route], fee=C * FEE))
    return pd.DataFrame(rows)

# ------------------------------------------------------------------ T3  staged catch-up
KS, CAPS, THRS = (1, 3, 5, 10), (None, 0.10, 0.20, 0.33), (0.20, 0.25, 0.30)   # run in experiments_v3x.t3x (both baskets)

# ------------------------------------------------------------------ T4  Base feeds
V3D = os.path.join(ROOT, 'data', 'series', 'v3')
def to_epoch(ix): return ((pd.DatetimeIndex(ix) - pd.Timestamp('1970-01-01')) // pd.Timedelta('1s')).to_numpy()

def _rounds(key):
    d = pd.read_csv(os.path.join(V3D, f'rounds_{key}.csv')).sort_values('updatedAt')
    return d

def sample_rounds(d, ts):
    """latestRoundData() at each timestamp, from a complete/consecutive round list."""
    u = d.updatedAt.values; p = d.price.values
    idx = np.searchsorted(u, ts, side='right') - 1
    ok = idx >= 0
    return np.where(ok, p[np.clip(idx, 0, None)], np.nan), np.where(ok, ts - u[np.clip(idx, 0, None)], np.nan)

def t4():
    out = {}
    reg = json.load(open(os.path.join(V3D, 'executor_registry_base.json')))
    cfg = json.load(open(os.path.join(V3D, 'base_feeds.json')))
    rr = json.load(open(os.path.join(ROOT, '_inputs', 'dca-feed-registrations.json')))['chains']['8453']['rows']
    for t in reg['tokens']:
        r = [x for x in rr if x['token'].lower() == t['token'].lower()]
        t['repo_feed_equal'] = bool(r and r[0]['feed'].lower() == t['feed'].lower())
        t['repo_enabled'] = bool(r and r[0]['enabled'])
    out['registry'] = reg
    ver = pd.read_csv(os.path.join(V3D, 'base_feed_verification.csv'))
    out['verification'] = ver
    # USDC Base: freshness + band calibration from the complete round list
    u = _rounds('USDC_base'); first = pd.to_datetime(u.updatedAt.min(), unit='s')
    rows_f, rows_b = [], []
    for scope, freq in (('diário 00:00', 'D'), ('horário', 'h')):
        g = pd.date_range(first.ceil('D'), '2026-11-07', freq=freq)
        ts = to_epoch(g)
        p, age = sample_rounds(u, ts)
        rows_f.append(dict(feed='USDC/USD · Base', scope=scope, from_=str(g[0].date()), n=len(g), median_age_s=float(np.nanmedian(age)),
                           p90_age_s=float(np.nanpercentile(age, 90)), max_age_h=float(np.nanmax(age) / 3600), pct_over_600=float((age > 600).mean() * 100)))
        for band in (0.005, 0.01, 0.02):
            m = np.abs(p - 1) > band
            when = g[m]
            rows_b.append(dict(scope=scope, n=len(g), band_pct=band * 100, outside=int(m.sum()),
                               min_price=float(np.nanmin(p)), when=', '.join(sorted({str(x.date()) for x in when})[:10])))
        if freq == 'D':
            for k in ('USDC',):
                pass
    out['usdc_fresh'] = pd.DataFrame(rows_f); out['usdc_band'] = pd.DataFrame(rows_b)
    # deviation threshold / heartbeat: directory (where listed) + empirical from consecutive rounds
    dirb = json.load(open(os.path.join(ROOT, 'data', 'raw', 'feeds-ethereum-mainnet-base-1.json')))
    rows = []
    for key, lab in (('ETH_base', 'ETH/USD · Base'), ('cbBTC', 'cbBTC/USD · Base'), ('USDC_base', 'USDC/USD · Base')):
        d = _rounds(key); prox = cfg[key]['proxy'].lower()
        dd = [x for x in dirb if x['proxyAddress'].lower() == prox]
        gap = np.diff(d.updatedAt.values); step = np.abs(np.diff(d.price.values) / d.price.values[:-1]) * 100
        hb = cfg[key]['heartbeat_registry']
        dev_rounds = step[gap < 0.9 * hb]
        rows.append(dict(feed=lab, directory_threshold_pct=(dd[0].get('threshold') if dd else None), directory_heartbeat_s=(dd[0].get('heartbeat') if dd else None),
                         registry_heartbeat_s=hb, rounds_used=len(d), median_gap_s=float(np.median(gap)),
                         share_heartbeat_updates_pct=float((gap >= 0.9 * hb).mean() * 100),
                         empirical_min_step_pct=float(np.percentile(dev_rounds, 5)) if len(dev_rounds) else np.nan,
                         empirical_median_step_pct=float(np.median(dev_rounds)) if len(dev_rounds) else np.nan))
    out['params'] = pd.DataFrame(rows)
    # rule-4 decisions: Base feeds vs exchange, Jul-Oct 2026
    idx = pd.date_range('2026-06-30', '2026-11-06 23:00', freq='h')
    ts = to_epoch(idx)
    def cl_hourly(path):
        d = pd.read_csv(path); return pd.Series(d.price.values, index=pd.to_datetime(d.utc).dt.tz_convert(None)).reindex(idx)
    feed = {'ETH': cl_hourly(os.path.join(S.SER, 'cl_hourly_ETH_base.csv')), 'cbBTC': cl_hourly(os.path.join(V3D, 'cl_hourly_cbBTC.csv')),
            'USDC': pd.Series(sample_rounds(u, ts)[0], index=idx)}
    def ex_open(path):
        d = pd.read_csv(path); return pd.Series(d.open.values, index=pd.to_datetime(d.ts, unit='s')).reindex(idx)
    exch = {'ETH': ex_open(os.path.join(S.SER, 'coinbase_ETH_hourly.csv')),
            'cbBTC': ex_open(os.path.join(S.SER, 'hourly_exchange', 'coinbase_BTC-USD.csv')),
            'USDC': ex_open(os.path.join(S.SER, 'hourly_exchange', 'bitstamp_usdcusd.csv'))}
    legs = ['ETH', 'cbBTC', 'USDC']
    qrows = []
    for j, l in enumerate(legs):
        a, b = feed[l], exch[l]; m = a.notna() & b.notna()
        bps = (a[m] / b[m] - 1) * 1e4
        fa = a[m].diff().abs() < 1e-12
        qrows.append(dict(leg=l, hours=int(m.sum()), median_abs_bps=float(bps.abs().median()), p95_abs_bps=float(bps.abs().quantile(.95)),
                          max_abs_bps=float(bps.abs().max()), feed_unchanged_hour_pct=float(fa.mean() * 100)))
    out['quality'] = pd.DataFrame(qrows)
    def decide(cols, td, cad):
        need = [td[0] - pd.Timedelta(hours=cad)] + td
        M = np.column_stack([c.reindex(need).values for c in cols])
        if np.isnan(M).any(): return None
        return M
    variants = {'só ETH do feed': [0], 'só cbBTC do feed': [1], 'só USDC do feed': [2], 'as três do feed': [0, 1, 2]}
    drows = []
    plans = []
    for s0, dur, cad, sp in itertools.product(pd.date_range('2026-07-01', '2026-10-15', freq='D'), (30, 60, 90), (24, 168), SPLITS):
        e0 = s0 + pd.Timedelta(days=dur - 1)
        if e0 <= sc.DATA_END: plans.append(('diário 00:00' if cad == 24 else 'semanal 00:00', s0, int((e0 - s0) / pd.Timedelta(hours=cad)) + 1, cad, sp))
    for s0, sp in itertools.product(pd.date_range('2026-07-01', '2026-11-03', freq='12h'), SPLITS):
        plans.append(('horário (72 ciclos)', s0, 72, 1, sp))
    for lab, s0, n, cad, sp in plans:
        td = [s0 + pd.Timedelta(hours=cad * i) for i in range(n)]
        if td[-1] > idx[-1]: continue
        Mx = decide([exch[l] for l in legs], td, cad)
        if Mx is None: continue
        rx = run_plus(Mx[1:], SPLITS[sp], p0=Mx[0])
        for vname, js in variants.items():
            cols = [feed[l] if j in js else exch[l] for j, l in enumerate(legs)]
            Mf = decide(cols, td, cad)
            if Mf is None: continue
            rf = run_plus(Mx[1:], SPLITS[sp], Pd=Mf[1:], pd0=Mf[0])
            ch = sum(1 for t in range(n - 1) if rx.primary.get(t) != rf.primary.get(t))
            drows.append(dict(plan=lab, start=str(s0), n_ticks=n, split=sp, variant=vname, changed=ch, decision_ticks=n - 1, dev_pp=rf.deviation_pp))
    out['decisions'] = pd.DataFrame(drows)
    return out

# T6 and T8 run in experiments_v3x.t68x (three-volatile basket first, stable basket second).
