"""Execution prices (Chainlink, as in v2) and ADR-024 decision prices (switch P) for any tick grid.

Decision price per leg and tick = Chainlink if the round read at the tick is <= 600 s old, else the
DefiLlama point nearest the tick within one hour (declared approximation of the quorum: CoinGecko serves no
history without a key), else no usable price."""
import os, numpy as np, pandas as pd
import series as S
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V3 = os.path.join(ROOT, 'data', 'series', 'v3')
MAX_AGE = 600
DL_KEY = {'ETH': 'ETH', 'cbBTC': 'cbBTC', 'WBTC': 'WBTC', 'WBTC_mainnet': 'WBTC', 'BTC_mainnet': 'BTC',
          'USDC': 'USDC', 'UST': 'UST', 'USDT': None, 'DAI': None}
COMPONENTS = {'WBTC_mainnet': ['WBTC_BTC_mainnet', 'BTC_mainnet'], 'UST': ['UST_ETH', 'ETH_mainnet']}
_age, _dl = {}, {}

def daily_age(src):
    if src not in _age:
        parts = COMPONENTS.get(src, [src]); ages = []
        for k in parts:
            d = pd.read_csv(os.path.join(S.SER, f'cl_daily_{k}.csv'), parse_dates=['date']).dropna(subset=['price'])
            ages.append(d.set_index('date')['age_s'].astype(float))
        _age[src] = pd.concat(ages, axis=1).max(axis=1)
    return _age[src]

def dl_series(key):
    if key not in _dl:
        p = os.path.join(V3, f'defillama_{key}_hourly.csv')
        if not os.path.exists(p): _dl[key] = None
        else:
            d = pd.read_csv(p); _dl[key] = pd.Series(d.price.values, index=pd.to_datetime(d.ts, unit='s')).sort_index()
    return _dl[key]

def dl_at(key, t, tol=3600):
    s = dl_series(key)
    if s is None or s.empty: return np.nan
    i = s.index.searchsorted(t)
    best = np.nan; bd = tol + 1
    for j in (i - 1, i):
        if 0 <= j < len(s):
            dd = abs((s.index[j] - t).total_seconds())
            if dd < bd: bd, best = dd, s.iloc[j]
    return float(best) if bd <= tol else np.nan

def decision_matrix(srcs, dates, Pe, age_fn):
    """age_fn(src, t) -> seconds or nan. Returns Pd and a per-cell code: 0 chainlink, 1 defillama, 2 none."""
    Pd = np.full(Pe.shape, np.nan); code = np.full(Pe.shape, 2, int)
    for j, src in enumerate(srcs):
        for i, t in enumerate(dates):
            a = age_fn(src, t)
            if a == a and a <= MAX_AGE: Pd[i, j] = Pe[i, j]; code[i, j] = 0
            else:
                k = DL_KEY.get(src)
                x = dl_at(k, t) if k else np.nan
                if x == x: Pd[i, j] = x; code[i, j] = 1
    return Pd, code

def daily_matrices(legs, tick_dates, cadence_days):
    prev0 = tick_dates[0] - pd.Timedelta(days=cadence_days); need = [prev0] + list(tick_dates)
    srcs, cols = [], []
    for leg in legs:
        src, s = S.resolve(leg, need)
        if src is None: return None
        srcs.append(src); cols.append(s)
    M = np.array([[c[d] for c in cols] for d in need])
    def age_fn(src, t):
        a = daily_age(src); return float(a.get(t, np.nan))
    Pd, code = decision_matrix(srcs, need, M, age_fn)
    return dict(Pe=M[1:], p0=M[0], Pd=Pd[1:], pd0=Pd[0], code=code[1:], sources=srcs, dates=list(tick_dates))

# ------------------------------------------------------------------ X legs (three-volatile basket, v3 §0.1)
XSRC = {'VIRTUAL': ['VIRTUAL_base'], 'COMP': ['COMP_base', 'COMP_mainnet'], 'AERO': ['AERO_base']}
PHASE2 = {'AERO'}            # not registered in the executor: the keeper has no Chainlink leg -> quorum (DefiLlama here)
XLABEL = {'VIRTUAL_base': 'Chainlink VIRTUAL/USD · Base', 'COMP_base': 'Chainlink COMP/USD · Base', 'COMP_mainnet': 'Chainlink COMP/USD · Ethereum',
          'AERO_base': 'Chainlink AERO/USD · Base'}
DL_KEY.update({'VIRTUAL_base': 'VIRTUAL', 'COMP_base': 'COMP', 'COMP_mainnet': 'COMP', 'AERO_base': 'AERO'})
_x = {}
def x_daily(key):
    if key not in _x:
        d = pd.read_csv(os.path.join(V3, f'cl_daily_{key}.csv'), parse_dates=['date']).dropna(subset=['price']).set_index('date')
        _x[key] = (d.price.astype(float), d.age_s.astype(float))
    return _x[key]

def resolve_leg(leg, need):
    if leg in XSRC:
        for k in XSRC[leg]:
            p = os.path.join(V3, f'cl_daily_{k}.csv')
            if not os.path.exists(p): continue
            s, _ = x_daily(k)
            if all(d in s.index for d in need): return k, s
        return None, None
    return S.resolve(leg, need)

def daily_matrices_x(legs, tick_dates, cadence_days):
    prev0 = tick_dates[0] - pd.Timedelta(days=cadence_days); need = [prev0] + list(tick_dates)
    srcs, cols = [], []
    for leg in legs:
        src, s = resolve_leg(leg, need)
        if src is None: return None
        srcs.append(src); cols.append(s)
    M = np.array([[c[d] for c in cols] for d in need])
    def age_fn(src, t):
        if src in XLABEL:
            if src.startswith('AERO'): return np.inf          # phase 2: never the Chainlink leg
            return float(x_daily(src)[1].get(t, np.nan))
        a = daily_age(src); return float(a.get(t, np.nan))
    Pd, code = decision_matrix(srcs, need, M, age_fn)
    return dict(Pe=M[1:], p0=M[0], Pd=Pd[1:], pd0=Pd[0], code=code[1:], sources=srcs, dates=list(tick_dates))
