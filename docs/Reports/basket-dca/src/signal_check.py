"""§2.12 — does the selection signal buy each leg at a better time than the fixed 3-leg DCA? Real windows only.
Same mechanics as engine.run_basket (rule-3 fix, cooldown, lock, final liquidation, no rule 9); only the score changes."""
import sys, numpy as np, pandas as pd
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
import series as S, scenarios as sc
from scenarios import SPLITS, ticks
from engine import run_fixed

def run_sig(P, p0, w, sig, C=1000.0):
    N, L = P.shape; b = C / N; T = np.array(w) * C; S_ = np.zeros(L); Q = np.zeros(L); cd = None
    for t in range(N):
        if sig == 'tick': sc_ = P[t] / (P[t-1] if t else p0) - 1
        elif sig == 'media': sc_ = P[t] / P[:t+1].mean(axis=0) - 1          # below its own average so far
        elif sig == 'entrada': sc_ = P[t] / P[0] - 1                         # below its own entry price
        elif sig == 'rotacao': sc_ = np.array([(i - t) % L for i in range(L)], float)  # no signal: fixed rotation
        op = [i for i in range(L) if S_[i] < T[i] - 1e-9]
        key = lambda i: (round(sc_[i], 12), -((T[i] - S_[i]) / T[i]))
        if t == N - 1:
            for i in sorted(op, key=key): x = T[i] - S_[i]; S_[i] += x; Q[i] += x / P[t, i]
            break
        el = list(op)
        if cd in el and len(el) > 1: el.remove(cd)
        el.sort(key=key); bud = b
        for i in el:
            if bud <= 1e-9: break
            x = min(bud, T[i] - S_[i]); S_[i] += x; Q[i] += x / P[t, i]; bud -= x
        cd = el[0] if el else None
    return S_, Q

def sec_2_12():
    e = S.raw('ETH'); lr = np.log(e / e.shift(1))
    rows = []
    for dur in (30, 90):
        for s0 in pd.date_range('2022-01-01', '2026-10-06', freq='D'):
            e0 = s0 + pd.Timedelta(days=dur - 1)
            if e0 > sc.DATA_END: continue
            td = ticks(s0, 1, end=e0); need = [td[0] - pd.Timedelta(days=1)] + td
            cols = []
            for leg in ('ETH', 'BTC', 'USDC'):
                src, s = S.resolve(leg, need)
                if s is None: break
                cols.append(s.reindex(need).values)
            if len(cols) < 3: continue
            M = np.column_stack(cols); P, p0 = M[1:], M[0]
            vol = float(lr.loc[s0 + pd.Timedelta(days=1):e0].std() * np.sqrt(365) * 100)
            for sp, w in SPLITS.items():
                rb = run_fixed(P, w); vB = (rb.qty * P[-1]).sum(); apB = rb.spent / rb.qty
                for sig in ('tick', 'media', 'entrada', 'rotacao'):
                    S_, Q = run_sig(P, p0, w, sig); v = (Q * P[-1]).sum(); ap = S_ / Q
                    rows.append(dict(dur=dur, start=s0, split=sp, vol=vol, sig=sig, diff_pct=(v - vB) / 10,
                                     eth_px=(ap[0] / apB[0] - 1) * 100, btc_px=(ap[1] / apB[1] - 1) * 100))
    d = pd.DataFrame(rows)
    p75 = d[d.dur == 30].vol.quantile(.75)
    d['regime'] = np.where(d.vol >= d.groupby('dur').vol.transform(lambda s: s.quantile(.75)), 'alta vol.', 'normal')
    g = d.groupby(['dur', 'sig', 'regime']).agg(n=('diff_pct', 'size'), win=('diff_pct', lambda s: (s > 0.01).mean() * 100),
            med=('diff_pct', 'median'), p5=('diff_pct', lambda s: s.quantile(.05)), p95=('diff_pct', lambda s: s.quantile(.95)),
            eth_px=('eth_px', 'median'), btc_px=('btc_px', 'median'),
            eth_cheaper=('eth_px', lambda s: (s < 0).mean() * 100), btc_cheaper=('btc_px', lambda s: (s < 0).mean() * 100))
    return d, g.reset_index()
