"""§2.11 — how often the Basket (A) ended with more value than B (fixed 3-leg DCA) and C (ETH-only DCA).

'Venceu' = higher position value at the last tick (holdings at that tick's feed price + any uninvested
cash), same capital, same window, same cadence. A difference below 0,01% of capital is a tie.
This is history (b), never a promise: it documents behaviour in real windows.
"""
import os, sys, itertools, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scenarios as sc, series as S
from scenarios import SPLITS, ticks, run_position, record
TIE = 0.1   # USD on a 1 000 USD position = 0,01%

def rolling_sample():
    rows = []
    e = S.raw('ETH'); lr = np.log(e / e.shift(1))
    starts = pd.date_range('2022-01-01', '2026-10-06', freq='D')
    for dur, cad in ((30, 1), (90, 1), (90, 7)):
        for s0 in starts:
            e0 = s0 + pd.Timedelta(days=dur - 1)
            if e0 > sc.DATA_END: continue
            td = ticks(s0, cad, end=e0)
            vol = float(lr.loc[s0 + pd.Timedelta(days=1):e0].std() * np.sqrt(365) * 100)
            eth_ret = float(e[e0] / e[s0] - 1) * 100
            for sp, w in SPLITS.items():
                out, meta = run_position(('ETH', 'BTC', 'USDC'), w, td, cad, strategies=('A', 'B', 'C'))
                if out is None: continue
                base = dict(section='2.11', start_day=s0.date().isoformat(), duration=f'{dur}d', cadence_d=cad, split=sp,
                            eth_vol_pct=vol, eth_return_pct=eth_ret, legs='ETH+BTC+USDC')
                for st, r in out.items(): rows.append(record(base, st, r, meta))
    return pd.DataFrame(rows)

def pivot_values(df, keys):
    v = df.pivot_table(index=keys, columns='strategy', values='final_value', aggfunc='first').dropna(subset=['A', 'B', 'C'])
    return v

def win_table(v):
    a_b = v.A - v.B; a_c = v.A - v.C
    n = len(v)
    def share(m): return 100 * m.sum() / n if n else np.nan
    return dict(n=n,
                A_beats_B=share(a_b > TIE), tie_B=share(a_b.abs() <= TIE), B_beats_A=share(a_b < -TIE),
                A_beats_C=share(a_c > TIE), C_beats_A=share(a_c < -TIE),
                A_beats_both=share((a_b > TIE) & (a_c > TIE)),
                median_A_minus_B_pct=float(np.median(a_b) / 10), median_A_minus_C_pct=float(np.median(a_c) / 10),
                p5_A_minus_B_pct=float(np.percentile(a_b, 5) / 10), p95_A_minus_B_pct=float(np.percentile(a_b, 95) / 10))
