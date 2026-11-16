"""T7 · step 1-2: inventory of real USD-stablecoin depegs, D_rec and the ceiling (owner's rule).

Universe : every USD-pegged coin in DefiLlama's stablecoin registry whose circulating supply reached >= 50 M USD
           before the event (curated or not), Jan 2020 – Nov 2026 (DefiLlama history).
Detection: DefiLlama price < 0.98 for >= 3 consecutive hourly points (coins with full hourly history: the curated
           list) or >= 2 consecutive daily points (the rest). Isolated prints are not events.
Event    : from the first such point until recovery. 'Recovered' = back to >= 0.99 and never below 0.99 for the next
           30 consecutive days (downside only: excursions above the peg, e.g. LUSD at 1.02-1.05, are not the risk the
           consent covers). Not recovered = no such 30-day stretch until the end of the data.
Measures : max drop on (1) the series the keeper would read (Chainlink hour by hour where a feed exists; else the
           DefiLlama hourly aggregate, declared — no exchange history is reachable for most of these coins), (2) the
           minimum of the hourly exchange candle (Coinbase/Bitstamp, where the pair exists), (3) the daily 00:00 tick.
Confirmed: a second, independent series (Chainlink or exchange) also went below 0.99 inside the event; events seen
           only in the aggregator are listed but marked, and only confirmed events enter D_rec.
"""
import os, sys, json, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import series as S
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ST = os.path.join(ROOT, 'data', 'series', 'v3', 'stables')
DET, REC_LVL, REC_DAYS, MIN_CIRC = 0.98, 0.99, 30, 50e6
DATA_END = pd.Timestamp('2026-11-06 23:00')
CURATED = {'USDC': 'usd-coin', 'USDT': 'tether', 'DAI': 'dai', 'BUSD': 'binance-usd', 'TUSD': 'true-usd', 'USDP': 'paxos-standard',
           'FRAX': 'frax', 'LUSD': 'liquity-usd', 'GUSD': 'gemini-dollar', 'USDD': 'usdd', 'UST': 'terrausd', 'USDe': 'ethena-usde',
           'PYUSD': 'paypal-usd', 'FDUSD': 'first-digital-usd', 'sUSD': 'nusd', 'MIM': 'magic-internet-money', 'crvUSD': 'crvusd',
           'GHO': 'gho', 'USDS': 'usds', 'DOLA': 'dola-usd', 'USD0': 'usual-usd', 'RLUSD': 'ripple-usd'}
G2S = {g: s for s, g in CURATED.items()}
CANDLES = {'USDC': 'Bitstamp USDC/USD', 'USDT': 'Coinbase USDT-USD', 'DAI': 'Coinbase DAI-USD', 'USDP': 'Coinbase PAX-USD',
           'GUSD': 'Coinbase GUSD-USD', 'PYUSD': 'Coinbase PYUSD-USD'}
NAMED = [('USDT', '2022-05-12')]      # named by the Architect; kept even if under the detection threshold
# Issuer wind-downs: after these dates the coin was no longer minted/redeemed in the normal way and its prices
# come from thin pools; such prints are not depegs a buyer of the catalog would face. Declared, never silent.
WIND_DOWN = {'binance-usd': ('2023-02-21', 'Paxos deixou de emitir BUSD (21 Fev 2023)'),
             'binance-peg-busd': ('2023-02-21', 'Paxos deixou de emitir BUSD (21 Fev 2023)'),
             'fei-usd': ('2022-08-20', 'Tribe DAO encerrou o FEI e abriu o resgate (Ago 2022)')}

# ------------------------------------------------------------------ loaders
_c = {}
def _memo(k, f):
    if k not in _c: _c[k] = f()
    return _c[k]

def dl_daily(g):
    def f():
        d = _memo('daily', lambda: pd.read_csv(os.path.join(ST, 'dl_daily_all_usd.csv')))
        x = d[d.gecko_id == g]; return pd.Series(x.price.values, index=pd.to_datetime(x.date, unit='s')).sort_index()
    return _memo(('dd', g), f)

def circulating(g):
    def f():
        d = _memo('circ', lambda: pd.read_csv(os.path.join(ST, 'dl_circulating.csv')))
        x = d[d.gecko_id == g]; return pd.Series(x.circulating_usd.values, index=pd.to_datetime(x.date, unit='s')).sort_index()
    return _memo(('cc', g), f)

def symbol(g):
    d = _memo('circ', lambda: pd.read_csv(os.path.join(ST, 'dl_circulating.csv')))
    x = d[d.gecko_id == g]
    return G2S.get(g) or (x.symbol.iloc[0] if len(x) else g)

def dl_hourly(g):
    def f():
        s = G2S.get(g); p = os.path.join(ST, f'defillama_{s}_hourly.csv') if s else None
        full = bool(p and os.path.exists(p))
        if not full: p = os.path.join(ST, f'defillama_X_{g}_hourly.csv')
        if not os.path.exists(p): return None, False
        d = pd.read_csv(p); return pd.Series(d.price.values, index=pd.to_datetime(d.ts, unit='s')).sort_index(), full
    return _memo(('dh', g), f)

def cl_hourly(sym):
    """Chainlink (Ethereum) hour by hour: from the complete round list, or from the hourly samples taken around
    each event for the 1 h-heartbeat feeds; UST = USTC/ETH x ETH/USD."""
    def f():
        p = os.path.join(ST, f'cl_rounds_{sym}.csv')
        if os.path.exists(p):
            r = pd.read_csv(p).sort_values('updatedAt'); r = r[r.updatedAt > 0]
            g = pd.date_range(pd.to_datetime(r.updatedAt.iloc[0], unit='s').ceil('h'), DATA_END, freq='h')
            ts = ((g - pd.Timestamp('1970-01-01')) // pd.Timedelta('1s')).to_numpy()
            i = np.searchsorted(r.updatedAt.values, ts, side='right') - 1
            return pd.Series(r.price.values[i], index=g)
        p = os.path.join(ST, f'cl_hourly_ev_{sym}.csv')
        if os.path.exists(p):
            d = pd.read_csv(p).dropna(subset=['price']); return pd.Series(d.price.values, index=pd.to_datetime(d.utc).dt.tz_convert(None)).sort_index()
        if sym == 'UST':
            import hourly_events as he
            h = he.leg_series(('UST_ETH', 'ETH_mainnet')); a = S.raw('UST')
            a = a[(a.index < h.index[0]) | (a.index > h.index[-1])]
            return pd.concat([a, h]).sort_index()
        return None
    return _memo(('cl', sym), f)

def candles(sym):
    def f():
        p = os.path.join(ST, f'candles_{sym}.csv')
        if not os.path.exists(p): return None
        d = pd.read_csv(p); d.index = pd.to_datetime(d.ts, unit='s'); return d.sort_index()
    return _memo(('cd', sym), f)

def daily_tick(sym, g):
    """00:00 UTC tick: Chainlink where we hold a daily or complete series, else the DefiLlama daily point."""
    if sym in ('USDC', 'USDT', 'DAI', 'UST'):
        try: return S.raw(sym), 'Chainlink 00:00 (Arbitrum; UST = USTC/ETH×ETH/USD Ethereum)'
        except FileNotFoundError: pass
    c = cl_hourly(sym) if sym else None
    if c is not None and len(c):
        x = c[c.index.hour == 0]
        if len(x): return x, 'Chainlink 00:00 (Ethereum)'
    return dl_daily(g), 'DefiLlama diário'

# ------------------------------------------------------------------ detection
def runs_below(s, lvl, min_pts, max_gap):
    low = s[s < lvl]
    if low.empty: return []
    grp = (low.index.to_series().diff() > max_gap).cumsum()
    out = []
    for _, x in low.groupby(grp.values):
        if len(x) >= min_pts: out.append(x.index[0])
    return out

def recovery_time(s, t0):
    """First t >= t0 with s >= 0.99 for the next 30 days (and data covering them). None if never."""
    x = s[s.index >= t0]
    bad = x < REC_LVL
    if not bad.any(): return x.index[0] if len(x) else None
    # candidate starts: points >= 0.99 right after a bad point
    last_bad = None
    bad_times = x.index[bad.values]
    j = 0
    for t in x.index[~bad.values]:
        while j < len(bad_times) and bad_times[j] < t: j += 1
        nxt = bad_times[j] if j < len(bad_times) else None
        if (nxt is None or nxt > t + pd.Timedelta(days=REC_DAYS)) and x.index[-1] >= t + pd.Timedelta(days=REC_DAYS):
            return t
    return None

def detect():
    """One row per event, every coin with >= 50 M circulating before it."""
    daily = _memo('daily', lambda: pd.read_csv(os.path.join(ST, 'dl_daily_all_usd.csv')))
    coins = sorted(set(daily.gecko_id))
    rows = []
    for g in coins:
        h, full = dl_hourly(g)
        if full: det, mp, gap, kind = h, 3, pd.Timedelta(hours=2), 'DefiLlama horário'
        else: det, mp, gap, kind = dl_daily(g), 2, pd.Timedelta(days=1, hours=1), 'DefiLlama diário'
        if det is None or det.empty: continue
        starts = runs_below(det, DET, mp, gap)
        sym = symbol(g)
        for s_, d_ in NAMED:
            if G2S.get(g) == s_ and not any(abs((t - pd.Timestamp(d_)).days) < 10 for t in starts):
                starts.append(pd.Timestamp(d_) - pd.Timedelta(days=1))
        starts.sort()
        t_end = pd.Timestamp('1900-01-01')
        recs = det if full else dl_daily(g)
        for t0 in starts:
            if t0 <= t_end: continue                   # inside the previous event
            rt = recovery_time(recs, t0)
            t_end = rt if rt is not None else pd.Timestamp('2100-01-01')
            c = circulating(g); pre = c[c.index <= t0]
            peak = float(pre.max()) if len(pre) else 0.0
            at = float(pre.iloc[-1]) if len(pre) else 0.0
            if at < MIN_CIRC: continue                  # the coin had to be in use when it happened
            wd = WIND_DOWN.get(g)
            if wd and t0 >= pd.Timestamp(wd[0]): continue
            hourly_ok = True
            if not full:                                # daily detection: needs >= 3 consecutive hourly points < 0.98
                hw = h.loc[t0 - pd.Timedelta(days=2):t0 + pd.Timedelta(days=45)] if h is not None else pd.Series(dtype=float)
                hourly_ok = bool(len(hw)) and bool(runs_below(hw, DET, 3, pd.Timedelta(hours=2)))
                if not len(hw): hourly_ok = None
            rows.append(dict(gecko_id=g, symbol=sym, detection=kind, start=t0, hourly_confirmed=hourly_ok, recovered=rt is not None, recovered_at=rt,
                             days_to_recover=(rt - t0).total_seconds() / 86400 if rt is not None else np.nan,
                             circ_peak_before_musd=peak / 1e6, circ_at_start_musd=float(pre.iloc[-1]) / 1e6 if len(pre) else 0.0,
                             named=any(G2S.get(g) == s_ and abs((t0 - pd.Timestamp(d_)).days) < 10 for s_, d_ in NAMED)))
    return pd.DataFrame(rows)

def sustained_min(x, n=3):
    """Minimum of the n-point rolling median: an isolated print cannot set the drop (aggregator series only)."""
    x = x.dropna()
    if len(x) < n: return float(x.min()) if len(x) else np.nan, (x.idxmin() if len(x) else pd.NaT)
    r = x.rolling(n, center=True).median().dropna()
    return float(r.min()), r.idxmin()

def agg_series(g, a, b):
    """DefiLlama hourly where we hold it inside [a, b], DefiLlama daily for the rest of the window."""
    h, full = dl_hourly(g); d = dl_daily(g).loc[a:b]
    hw = h.loc[a:b] if h is not None else pd.Series(dtype=float)
    if len(hw):
        d = d[(d.index < hw.index[0]) | (d.index > hw.index[-1])]
    return pd.concat([hw, d]).sort_index()

def measure(ev):
    out = []
    for _, e in ev.iterrows():
        g, sym = e.gecko_id, G2S.get(e.gecko_id)
        a = e.start - pd.Timedelta(days=1)
        b = max(e.recovered_at, e.start + pd.Timedelta(days=4)) if e.recovered else DATA_END
        r = dict(e)
        ag = agg_series(g, a, b)
        r['agg_raw_min'] = float(ag.min()) if len(ag) else np.nan
        r['agg_min'], r['agg_min_at'] = sustained_min(ag)
        cl = cl_hourly(sym) if sym else None
        clw = cl.loc[a:b] if cl is not None else pd.Series(dtype=float)
        if len(clw):
            r['keeper_series'] = 'Chainlink (Ethereum), hora a hora' if sym != 'UST' else 'Chainlink USTC/ETH × ETH/USD (diário; horário em Mai 2022)'
            r['keeper_min'] = float(clw.min()); r['keeper_min_at'] = clw.idxmin()
        else:
            r['keeper_series'] = 'DefiLlama (quórum, sem feed Chainlink) · mínimo sustentado'
            r['keeper_min'], r['keeper_min_at'] = r['agg_min'], r['agg_min_at']
        cd = candles(sym) if sym else None
        cdw = cd.loc[a:b] if cd is not None else None
        r['candle_min'] = float(cdw.low.min()) if cdw is not None and len(cdw) else np.nan
        r['candle_src'] = CANDLES.get(sym, '') if cdw is not None and len(cdw) else ''
        dt_, dsrc = daily_tick(sym, g)
        dtw = dt_.loc[a.normalize():b]
        r['daily_tick_min'] = float(dtw.min()) if len(dtw) else np.nan; r['daily_tick_src'] = dsrc
        second = []
        if len(clw): second.append(float(clw.min()))
        if cdw is not None and len(cdw): second.append(float(cdw.close.min()))
        r['confirmed'] = (min(second) < REC_LVL) if second else None
        r['max_drop_pct'] = (1 - r['keeper_min']) * 100
        if e.named and len(clw):                       # under the aggregator threshold: recovery read on the keeper series
            rt = recovery_time(cl, clw[clw < REC_LVL].index[0]) if (clw < REC_LVL).any() else None
            r['recovered_at'] = rt; r['days_to_recover'] = (rt - clw[clw < REC_LVL].index[0]).total_seconds() / 86400 if rt is not None else np.nan
        dd = dl_daily(g)
        r['last_price'] = float(dd.iloc[-1]) if len(dd) else np.nan
        r['last_date'] = dd.index[-1] if len(dd) else pd.NaT
        tail = agg_series(g, e.start, DATA_END) if not len(clw) else pd.concat([clw, dd.loc[clw.index[-1]:]])
        for lv in (0.5, 0.1):
            hit = tail[tail < lv]
            r[f'days_to_{int(lv*100)}c'] = (hit.index[0] - e.start).total_seconds() / 86400 if len(hit) else np.nan
        out.append(r)
    return pd.DataFrame(out)

# ------------------------------------------------------------------ step 2
def ceiling(m, margin=5.0, d_rec_owner=None, owner_free=None):
    """D_rec, the owner's rule, and what sits around the ceiling. 'confirmed' = a second independent series
    (Chainlink or exchange) also saw the depeg; aggregator-only events are the sensitivity case."""
    ok = m[m.hourly_confirmed != False]
    rec_c = ok[ok.recovered & (ok.confirmed == True)].sort_values('max_drop_pct', ascending=False)
    rec_a = ok[ok.recovered].sort_values('max_drop_pct', ascending=False)
    non = ok[~ok.recovered & (ok.confirmed != False)]       # a depeg the keeper's own feed did not see is not a collapse
    def series_for(e):
        g, sym = e.gecko_id, G2S.get(e.gecko_id)
        cl = cl_hourly(sym) if sym else None
        if cl is not None and len(cl.loc[e.start - pd.Timedelta(days=1):]):
            x = cl.loc[e.start - pd.Timedelta(days=1):]
            dd = dl_daily(g); return pd.concat([x, dd.loc[x.index[-1] + pd.Timedelta(seconds=1):]])
        x = agg_series(g, e.start - pd.Timedelta(days=1), DATA_END)      # aggregator: same sustained reading as the drop
        return x.rolling(3, center=True, min_periods=1).median()
    def rule(d_rec, low=None):
        rows = []
        for _, e in non.iterrows():
            x = series_for(e)
            def first_below(lv):
                y = x[x <= lv]; return y.index[0] if len(y) else pd.NaT
            t_ceil = first_below(1 - ((d_rec - margin) if low is None else low) / 100); t_rec = first_below(1 - d_rec / 100); t50 = first_below(0.5)
            rows.append(dict(symbol=e.symbol, start=e.start, confirmed=e.confirmed, keeper_series=e.keeper_series, max_drop_pct=e.max_drop_pct,
                             passed_d_rec=bool(pd.notna(t_rec)), crossed_ceiling_at=t_ceil, crossed_d_rec_at=t_rec, crossed_50c_at=t50,
                             h_ceiling_to_d_rec=(t_rec - t_ceil).total_seconds() / 3600 if pd.notna(t_rec) and pd.notna(t_ceil) else np.nan,
                             d_ceiling_to_50c=(t50 - t_ceil).total_seconds() / 86400 if pd.notna(t50) and pd.notna(t_ceil) else np.nan,
                             last_price=e.last_price, last_date=e.last_date, circ_at_start_musd=e.circ_at_start_musd,
                             status='colapsou' if e.last_price < 0.5 else ('em curso' if e.start > DATA_END - pd.Timedelta(days=180) else 'não recuperou')))
        nr = pd.DataFrame(rows)
        applies = bool(len(nr)) and (nr.passed_d_rec.any() or (~nr.passed_d_rec).any())
        c = d_rec - margin if applies else d_rec
        lst = nr[nr.max_drop_pct >= c] if len(nr) else nr
        return nr, applies, c, lst
    out = {}
    for tag, rec in (('confirmado', rec_c), ('qualquer série', rec_a)):
        top = rec.iloc[0]; nr, applies, c, lst = rule(float(top.max_drop_pct))
        out[tag] = dict(d_rec=float(top.max_drop_pct), event=top, top5=rec.head(6), non_recovered=nr, rule_applies=applies, ceiling=c,
                        dead_through_ceiling=lst)
    if d_rec_owner is not None:                    # the owner's rule (7 Nov 2026): free up to owner_free; above it, one warning citing d_rec_owner
        nr, applies, c, lst = rule(float(d_rec_owner), low=owner_free)
        if owner_free is not None: c = float(owner_free); lst = nr[nr.max_drop_pct >= c] if len(nr) else nr
        out['dono'] = dict(d_rec=float(d_rec_owner), event=pd.Series(dict(symbol='escolha do dono', start=None, max_drop_pct=float(d_rec_owner),
                           keeper_min=1 - float(d_rec_owner) / 100, days_to_recover=None, keeper_series='')),
                           top5=rec_a.head(6), non_recovered=nr, rule_applies=applies, ceiling=c, dead_through_ceiling=lst)
    lv = []
    for L in (2, 3, 5, 7.5, 10, 12.5, 15, 20, 25, 30, 40, 50, 75, 80, 90):
        r_ = ok[ok.max_drop_pct >= L]; rc = r_[r_.confirmed == True]
        lv.append(dict(level_pct=L, events=len(r_), recovered=int(r_.recovered.sum()), not_recovered=int((~r_.recovered).sum()),
                       share_not_recovered_pct=100 * float((~r_.recovered).mean()) if len(r_) else np.nan,
                       confirmed_events=len(rc), confirmed_not_recovered=int((~rc.recovered).sum())))
    out['levels'] = pd.DataFrame(lv)
    return out
