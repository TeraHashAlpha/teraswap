"""T7 · the input stable (what the user pays with) and step 3 (a stable as leg 3), on the real events.

Events and series (hour by hour, the §2.10 grids):
  USDC · SVB, Mar 2023 (episode E4)      ETH Arbitrum, WBTC Arbitrum, COMP Ethereum; USDC = Chainlink USDC/USD Ethereum (all rounds)
  DAI  · SVB, Mar 2023 (episode E4 grid) same legs; DAI = Chainlink DAI/USD Ethereum (hourly samples), else DefiLlama hourly
  USDT · May 2022 (episode E2 grid)      ETH Arbitrum, WBTC/BTC×BTC/USD Ethereum, COMP Ethereum; USDT = Chainlink USDT/USD Ethereum
  UST  · May 2022 (episode E2), the worst case that never recovered (leg 3 only; nobody pays in UST in the catalog)

Input stable: the position is denominated in the stable. Each purchase sells stable units at its USD price p(t):
asset price in stable units = USD price / p(t). Pause rule = a cycle is skipped while |p - 1| > band (the money waits,
ADR-024); a last cycle that falls in a pause waits for the first hour back inside the band and executes there.
Value is reported in USD at the end of the position (holdings at the feed + unspent stable at p_end)."""
import os, sys, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hourly_events as he, prices_v3 as pv, experiments_v3x as X, t7_stables as T, series as S
from scenarios import SPLITS
from engine_plus import run_plus
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EVENTS = {'USDC · SVB (Mar 2023)': ('E4', 'USDC'), 'DAI · SVB (Mar 2023)': ('E4', 'DAI'), 'USDT · Mai 2022': ('E2', 'USDT'),
          'UST · Mai 2022 (contra-caso: nunca recuperou)': ('E2', 'UST')}
LEG3_EVENTS = {'USDC · SVB (Mar 2023)': ('E4', 'USDC'), 'DAI · SVB (Mar 2023)': ('E4', 'DAI'), 'USDT · Mai 2022': ('E2', 'USDT'),
               'UST · Terra (Mai 2022), nunca recuperou': ('E2', 'UST')}

_p = {}
def stable_price(sym):
    """Function t -> USD price of the stable (Chainlink first; DefiLlama hourly as declared fallback)."""
    if sym in _p: return _p[sym]
    if sym == 'UST':
        h = he.leg_series(('UST_ETH', 'ETH_mainnet')); d = S.raw('UST')
        def f(t):
            if t in h.index: return float(h[t])
            x = d[d.index <= t]; return float(x.iloc[-1]) if len(x) else np.nan
        _p[sym] = f; return f
    cl = T.cl_hourly(sym); dl, _ = T.dl_hourly(T.CURATED[sym])
    def f(t):
        if cl is not None and len(cl) and cl.index[0] <= t <= cl.index[-1] + pd.Timedelta(hours=1):
            x = cl[cl.index <= t]
            if len(x) and (t - x.index[-1]) <= pd.Timedelta(hours=2): return float(x.iloc[-1])
        if dl is not None:
            v = dl.loc[t - pd.Timedelta(hours=1):t + pd.Timedelta(hours=1)]
            if len(v): return float(v.iloc[0])
        return np.nan
    _p[sym] = f; return f

def legs_for(ep, third):
    """USD price series for ETH, the BTC feed and the third leg (COMP for the three-volatile basket)."""
    fks = he.leg_feeds(ep); ser = [he.leg_series(fks[0]), he.leg_series(fks[1])]
    if third == 'COMP':
        s3, _ = X.x_hourly('COMP_mainnet')
    else:
        s3 = None
    return ser, s3

def positions(ep):
    for cad_h, n, s0 in he.position_plan(ep):
        td = [s0 + pd.Timedelta(hours=cad_h * k) for k in range(n)]
        yield cad_h, n, s0, td, [s0 - pd.Timedelta(hours=cad_h)] + td

def next_in_band(f, t, band, limit_days=60):
    for k in range(1, 24 * limit_days):
        u = t + pd.Timedelta(hours=k); p = f(u)
        if p == p and abs(p - 1) <= band: return u
    return None

def usd_at(series_list, t):
    """USD prices of the legs at an arbitrary hour (nearest earlier hourly point in the cached grids, else nan)."""
    out = []
    for s in series_list:
        x = s[s.index <= t]; out.append(float(x.iloc[-1]) if len(x) and (t - x.index[-1]) <= pd.Timedelta(hours=1) else np.nan)
    return np.array(out)

# ------------------------------------------------------------------ input stable
PAUSES = [('sem pausa', None, None), ('0,5%', 0.005, None), ('1%', 0.01, None), ('2%', 0.02, None), ('5%', 0.05, None),
          ('1% · pausa máx. 72 h', 0.01, 72), ('2% · pausa máx. 72 h', 0.02, 72)]

def paused_at(f, t, band, cap_h):
    p = f(t)
    if not (p == p) or abs(p - 1) <= band: return False
    if cap_h is None: return True
    for k in range(1, cap_h + 1):                      # resumes once the stable has been out of the band for cap_h hours
        q = f(t - pd.Timedelta(hours=k))
        if q == q and abs(q - 1) <= band: return True
    return False

def wait_last(f, t, band, cap_h, limit_days=60):
    """When the last cycle is paused: the first hour back inside the band, or the end of the capped pause."""
    for k in range(1, 24 * limit_days):
        u = t + pd.Timedelta(hours=k)
        if not paused_at(f, u, band, cap_h): return u
    return None

def input_stable():
    rows = []; skipped = 0
    for ev, (ep, sym) in EVENTS.items():
        f = stable_price(sym); ser, comp = legs_for(ep, 'COMP')
        for product, lser, w in (('DCA de um token (ETH)', [ser[0]], {'100': (1.0,)}),
                                 ('Basket ETH+BTC+COMP (A+)', [ser[0], ser[1], comp], SPLITS)):
            for cad_h, n, s0, td, need in positions(ep):
                try: U = np.array([[s[t] for s in lser] for t in need])
                except KeyError: continue
                p = np.array([f(t) for t in need])
                if np.isnan(p).any() or np.isnan(U).any(): continue
                Pstab = U / p[:, None]                       # price in stable units
                for blab, band, cap_h in PAUSES:
                    Pe = Pstab[1:].copy(); Pd = Pe.copy(); pd0 = Pstab[0].copy()
                    paused = np.zeros(n, bool); t_exec = td[-1]; executed_last = True
                    if band is not None:
                        paused = np.array([paused_at(f, t, band, cap_h) for t in td])
                        Pd[paused] = np.nan
                        if paused[-1]:                        # the last cycle waits
                            u = wait_last(f, td[-1], band, cap_h)
                            if u is None: executed_last = False   # never back: the rest stays in the stable
                            else:
                                Uu = usd_at(lser, u)
                                if np.isnan(Uu).any(): skipped += 1; continue
                                Pe[-1] = Uu / f(u); Pd[-1] = Pe[-1]; t_exec = u
                    for sp, ww in w.items():
                        L = len(lser)
                        kw = dict(select=L > 1)
                        if L > 1: kw.update(dd=0.25, mode='soft', k=10, min_fill=16.0)
                        r = run_plus(Pe, ww, Pd=Pd, pd0=pd0, **kw)
                        p_end = f(t_exec); U_end = usd_at(lser, t_exec) if t_exec != td[-1] else U[-1]
                        px = [p[1 + t] if not (t == n - 1 and t_exec != td[-1]) else f(t_exec) for t in range(n)]
                        below = sum(x for t, i, x, k in r.fills if px[t] < 0.99)
                        cost = sum(x * (1 - px[t]) for t, i, x, k in r.fills)
                        rows.append(dict(event=ev, stable=sym, product=product, cadence_h=cad_h, n_ticks=n, start=str(s0), split=sp,
                                         band=blab, paused_cycles=int(paused.sum()), last_cycle_waited_h=(t_exec - td[-1]).total_seconds() / 3600,
                                         last_executed=executed_last, sold_below_peg_pct=100 * below / r.capital, depeg_cost_pct=100 * cost / r.capital,
                                         value_usd=float((r.qty * U_end).sum() + r.cash_left * p_end), uninvested_pct=r.uninvested_pct,
                                         dev_pp=r.deviation_pp))
    out = pd.DataFrame(rows); out.attrs['skipped'] = skipped
    return out

# ------------------------------------------------------------------ step 3: stable as leg 3
OWNER_BANDS = [(0.01, '1% (defeito)'), (0.05, '5%'), (0.10, '10% (máx. sem aviso)'), (0.20, '20% (com aviso)'), (0.80, '80% (com aviso)')]
def leg3(bands=OWNER_BANDS):
    blab = [b for _, b in bands]; bands = [v for v, _ in bands]
    rows = []
    for ev, (ep, sym) in LEG3_EVENTS.items():
        f = stable_price(sym); ser, _ = legs_for(ep, None)
        h = pd.Timestamp(he.EPISODES[ep][0])
        ev_t = {'USDT': pd.Timestamp('2022-05-12 08:00')}.get(sym, h)
        p7, p30 = f(ev_t + pd.Timedelta(days=7)), f(ev_t + pd.Timedelta(days=30))
        for cad_h, n, s0, td, need in positions(ep):
            if not (td[0] <= ev_t + pd.Timedelta(hours=cad_h) and td[-1] >= ev_t - pd.Timedelta(hours=cad_h)): continue
            try: U = np.array([[s[t] for s in ser] + [f(t)] for t in need])
            except KeyError: continue
            if np.isnan(U).any(): continue
            pmin_after = min(f(ev_t + pd.Timedelta(hours=k)) for k in range(0, 24 * 30 + 1, 6))
            for (band, bl), (dd, ddl), mode, (sp, w) in __import__('itertools').product(
                    zip(bands, blab), ((None, 'desligada'), (0.25, '25%')), ('soft', 'rigid'), SPLITS.items()):
                if dd is None and mode == 'rigid': continue          # without rule 9 the two modes are identical
                r = run_plus(U[1:], w, p0=U[0], dd=dd, mode=mode, k=10 if mode == 'soft' else 1, stable_idx=2, band=band)
                off = [(t, x) for t, i, x, k in r.fills if i == 2 and U[1 + t, 2] < 0.99]
                usd_off = sum(x for t, x in off); q_off = sum(x / U[1 + t, 2] for t, x in off)
                stop = [t for t in range(n) if abs(U[1 + t, 2] - 1) > band]
                rows.append(dict(event=ev, stable=sym, cadence_h=cad_h, n_ticks=n, start=str(s0), split=sp, w3=w[2], band=bl, rule9=ddl,
                                 mode='suave' if mode == 'soft' else 'rígido', usd_bought_offpeg=usd_off,
                                 avg_px_offpeg=usd_off / q_off if q_off else np.nan,
                                 value_offpeg_7d=q_off * p7, value_offpeg_30d=q_off * p30,
                                 spent3_pct=100 * r.spent[2] / r.capital,
                                 max_loss_stable_pct=100 * (r.spent[2] - r.qty[2] * pmin_after) / r.capital,
                                 first_blocked=str(td[stop[0]]) if stop else '', dev_pp=r.deviation_pp, unin_pct=r.uninvested_pct))
    return pd.DataFrame(rows)
