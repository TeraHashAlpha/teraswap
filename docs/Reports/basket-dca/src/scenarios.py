"""Scenario catalogue (§2 of the Architect's request) and the runner.

Every scenario is a concrete historical window with the prices the market actually made
(Chainlink round data read at 00:00 UTC). Nothing synthetic is generated anywhere.
"""
import os, sys, datetime as dt, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import series as S
from engine import run_basket, run_fixed, run_single

SPLITS = {'25-25-50': (.25, .25, .50), '40-40-20': (.40, .40, .20),
          '33-33-33': (1/3, 1/3, 1/3), '30-30-40': (.30, .30, .40)}
CAPITAL = 1000.0
DATA_END = pd.Timestamp('2026-11-06')   # last tick date allowed for a position (Architect §2.3)

STRESS = {   # id: (start, end, label)
    'S1': ('2022-05-05', '2022-06-20', 'Terra/Luna + Celsius'),
    'S2': ('2022-11-02', '2022-11-30', 'FTX'),
    'S3': ('2023-03-09', '2023-03-20', 'SVB / depeg USDC'),
    'S4': ('2024-07-29', '2024-08-15', 'Yen carry unwind'),
    'S5': ('2025-02-01', '2025-04-15', 'Correcção Q1 2025'),
}

def D(x): return pd.Timestamp(x)

def ticks(start, cadence, n=None, end=None):
    start = D(start)
    if n is None:
        n = int((D(end) - start).days // cadence) + 1
    return [start + pd.Timedelta(days=cadence * k) for k in range(n)]

def run_position(legs, weights, tick_dates, cadence, strategies=('A', 'A0', 'B', 'C'), **kw):
    """legs: logical leg names e.g. ('ETH','BTC','USDC'). Returns (records, objects)."""
    prev0 = tick_dates[0] - pd.Timedelta(days=cadence)
    need = [prev0] + list(tick_dates)
    srcs, cols = [], []
    for leg in legs:
        src, s = S.resolve(leg, need)
        if src is None: return None, None
        srcs.append(src); cols.append(s)
    P = np.array([[c[d] for c in cols] for d in tick_dates])
    p0 = np.array([c[prev0] for c in cols])
    out = {}
    if 'A' in strategies: out['A'] = run_basket(P, p0, weights, CAPITAL, True, **kw)
    if 'A0' in strategies: out['A0'] = run_basket(P, p0, weights, CAPITAL, False, **kw)
    if 'B' in strategies: out['B'] = run_fixed(P, weights, CAPITAL)
    if 'C' in strategies: out['C'] = run_single(P[:, 0], CAPITAL)
    meta = {'sources': srcs, 'P': P, 'p0': p0, 'dates': tick_dates}
    return out, meta

def record(base, strat, r, meta):
    P = meta['P']; p_end = P[-1] if strat != 'C' else P[-1, :1]
    rec = dict(base)
    rec.update({
        'strategy': strat,
        'start': meta['dates'][0].date().isoformat(), 'end': meta['dates'][-1].date().isoformat(),
        'n_ticks': len(meta['dates']),
        'sources': ' | '.join(S.SOURCE_LABEL.get(x, x) for x in meta['sources']),
        'deviation_pp': r.deviation_pp if strat != 'C' else np.nan,
        'deviation_invested_pp': r.deviation_invested_pp,
        'uninvested_pct': r.uninvested_pct,
        'final_value': r.final_value(p_end),
        'max_drawdown_pct': r.max_drawdown_pct,
        'n_fills': r.n_fills,
        'final_tick_share_pct': 100 * sum(u for t, i, u, k in r.fills if t == len(meta['dates']) - 1) / CAPITAL,
    })
    if strat != 'C':
        ap = r.avg_price
        for j in range(3):
            rec[f'avg_price_leg{j}'] = ap[j]
            rec[f'spent_leg{j}'] = r.spent[j]
            rec[f'lock_tick_leg{j}'] = r.lock_tick[j]
            rec[f'lock_via_final_leg{j}'] = r.lock_via_final[j]
            rec[f'protect_events_leg{j}'] = r.protect_events.get(j, 0) if r.protect_events else 0
            rec[f'protect_ticks_leg{j}'] = r.protect_ticks.get(j, 0) if r.protect_ticks else 0
        rec['n_roll_fills'] = sum(1 for f in r.fills if f[3] == 'roll')
        if r.cand:
            rec['chosen_capital_pct'] = 100 * sum(f[2] for f, n in zip(r.fills, r.cand) if n >= 2) / CAPITAL
            rec['forced_capital_pct'] = 100 - rec['chosen_capital_pct']
        rolls = [f[2] for f in r.fills if f[3] == 'roll']
        rec['min_roll_fill_usd'] = min(rolls) if rolls else np.nan
        rec['stable_block_ticks'] = r.stable_block_ticks
    return rec

def eth_daily():
    return S.raw('ETH')

def worst_day(start, end):
    e = eth_daily(); r = (e / e.shift(1) - 1).loc[D(start):D(end)]
    return r.idxmin(), float(r.min())

def find_s6(a='2025-05-01', b='2026-11-06'):
    """Largest ETH peak-to-trough decline with the trough at most 30 days after the peak,
    peak in [a, b]. Window = peak day .. peak + 30 days."""
    e = eth_daily().loc[D(a):D(b) + pd.Timedelta(days=30)]
    best = (0, None, None)
    idx = e.index
    for i, d in enumerate(idx):
        if d > D(b): break
        w = e.loc[d:d + pd.Timedelta(days=30)]
        dd = 1 - w.min() / e[d]
        if dd > best[0]: best = (dd, d, w.idxmin())
    return best

def rolling_vol30(a='2022-01-01', b='2026-11-06'):
    e = eth_daily(); lr = np.log(e / e.shift(1))
    v = lr.rolling(30).std() * np.sqrt(365) * 100
    return v.loc[D(a):D(b)]
