"""§2.10 — abrupt one-hour moves (Nov 2021 – Nov 2026).

Detection uses hourly exchange candles (two venues per asset) because a 60-minute high/low is not
recoverable from a daily feed sample. Rule: an hour qualifies when the high/low range of the candle
exceeds 15% on one venue AND the same hour exceeds 10% on a second venue for the same asset (a
single-venue spike is treated as a bad print). For UST, which no venue in the set lists, the
detection uses the Chainlink USTC/ETH x ETH/USD composite read every hour.
"""
import os, sys, glob, json, datetime as dt, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HX = os.path.join(ROOT, 'data', 'series', 'hourly_exchange')
VENUES = {'ETH': ['coinbase_ETH-USD', 'bitstamp_ethusd'], 'BTC': ['coinbase_BTC-USD', 'bitstamp_btcusd'],
          'USDC': ['bitstamp_usdcusd'], 'USDT': ['coinbase_USDT-USD', 'bitstamp_usdtusd'], 'DAI': ['coinbase_DAI-USD']}
THR, CONFIRM = 0.15, 0.10

def candles(name):
    d = pd.read_csv(os.path.join(HX, f'{name}.csv')).sort_values('ts')
    d['t'] = pd.to_datetime(d.ts, unit='s'); d['range'] = d.high / d.low - 1
    d['c2c'] = d.close / d.close.shift(1) - 1; d.loc[d.ts.diff() != 3600, 'c2c'] = np.nan
    return d.set_index('t')

def scan():
    """Per asset: the largest close-to-close move and the qualifying hours (range rule)."""
    summary, hits = [], []
    for asset, vs in VENUES.items():
        cs = {v: candles(v) for v in vs}
        for v, d in cs.items():
            i = d.c2c.abs().idxmax(); j = d.range.idxmax()
            summary.append(dict(asset=asset, venue=v, hours=len(d), max_c2c_pct=float(d.c2c[i] * 100), at_c2c=str(i),
                                max_range_pct=float(d.range[j] * 100), at_range=str(j),
                                hours_c2c_over_15=int((d.c2c.abs() > THR).sum()), hours_range_over_15=int((d.range > THR).sum())))
            for t, r in d[d.range > THR].iterrows():
                others = [cs[o].range.get(t, np.nan) for o in vs if o != v]
                confirmed = any(x > CONFIRM for x in others if not np.isnan(x)) if others else None
                hits.append(dict(asset=asset, venue=v, hour=t, range_pct=r.range * 100, c2c_pct=r.c2c * 100,
                                 open=r.open, high=r.high, low=r.low, close=r.close,
                                 other_venue_range_pct=(others[0] * 100 if others and not np.isnan(others[0]) else np.nan),
                                 confirmed=confirmed))
    return pd.DataFrame(summary), pd.DataFrame(hits)

# ------------------------------------------------------------------ episodes
EPISODES = {   # id: (first qualifying hour UTC, asset, label, legs, feed keys per leg, strict 15% rule met?)
    'E1': ('2021-12-04 05:00', 'BTC', 'BTC · flash crash de 4 Dez 2021', ('ETH', 'BTC', 'USDC'), True),
    'E2': ('2022-05-11 07:00', 'UST', 'UST · colapso Terra, 11 Mai 2022', ('ETH', 'BTC', 'UST'), True),
    'E3': ('2022-06-15 18:00', 'ETH', 'ETH · FOMC + Celsius, 15 Jun 2022', ('ETH', 'BTC', 'USDC'), True),
    'E4': ('2023-03-11 06:00', 'USDC', 'USDC · SVB, 11 Mar 2023 (14,6%: abaixo do limiar)', ('ETH', 'BTC', 'USDC'), False),
    'E5': ('2024-08-05 01:00', 'ETH', 'ETH · yen carry, 5 Ago 2024', ('ETH', 'BTC', 'USDC'), True),
    'E6': ('2025-02-03 01:00', 'ETH', 'ETH · tarifas, 3 Fev 2025', ('ETH', 'BTC', 'USDC'), True),
    'E7': ('2025-10-10 21:00', 'ETH', 'ETH · liquidações de 10 Out 2025', ('ETH', 'BTC', 'USDC'), True),
}
CBBTC_FROM, WBTC_ARB_FROM, WBTC_BTC_FROM = pd.Timestamp('2024-09-14'), pd.Timestamp('2022-11-26'), pd.Timestamp('2022-03-01')

def leg_feeds(ep):
    h = pd.Timestamp(EPISODES[ep][0]); legs = EPISODES[ep][3]
    lo = h - pd.Timedelta(days=31)
    out = []
    for leg in legs:
        if leg == 'BTC':
            # WBTC/BTC on Ethereum has no readable rounds before 2022-03 (older phases revert), so E1 uses the
            # BTC/USD feed itself — declared in the sources column, never silently.
            out.append(('cbBTC',) if lo >= CBBTC_FROM else ('WBTC',) if lo >= WBTC_ARB_FROM
                       else ('BTC_mainnet',) if lo < WBTC_BTC_FROM else ('WBTC_BTC_mainnet', 'BTC_mainnet'))
        elif leg == 'UST': out.append(('UST_ETH', 'ETH_mainnet'))
        else: out.append((leg,))
    return out

def grids(ep):
    h = pd.Timestamp(EPISODES[ep][0])
    hourly = [h + pd.Timedelta(hours=k) for k in range(-73, 73)]
    a = h + pd.Timedelta(hours=1)          # 4 h and daily ticks are aligned to the first reading AFTER the move
    four = [a + pd.Timedelta(hours=4 * k) for k in range(-61, 61)]
    daily = [a + pd.Timedelta(days=k) for k in range(-31, 31)]
    return sorted(set(hourly) | set(four) | set(daily))

def minute_grid(ep):
    h = pd.Timestamp(EPISODES[ep][0]); return [h + pd.Timedelta(minutes=m) for m in range(0, 61)]

def fetch_all():
    import fetch_chainlink as fc
    from concurrent.futures import ThreadPoolExecutor
    feeds = json.load(open(os.path.join(ROOT, 'config', 'feeds.json')))
    jobs = {}
    for ep in EPISODES:
        g = grids(ep); gm = minute_grid(ep)
        for i, fk in enumerate(leg_feeds(ep)):
            for k in fk:
                jobs.setdefault(k, set()).update(g)
                if i == {'ETH': 0, 'BTC': 1, 'UST': 2, 'USDC': 2}[EPISODES[ep][1]]: jobs[k].update(gm)
    out_dir = os.path.join(ROOT, 'data', 'series', 'hourly_feeds'); os.makedirs(out_dir, exist_ok=True)
    def one(k):
        ts = sorted(int(t.tz_localize('UTC').timestamp()) for t in jobs[k])
        f = fc.Feed(k, feeds[k]); r = f.sample(ts)
        pd.DataFrame({'utc': [dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat() for t in ts],
                      'price': [p for p, u in r], 'age_s': [(t - u) if u else None for t, (p, u) in zip(ts, r)]}
                     ).to_csv(os.path.join(out_dir, f'cl_{k}.csv'), index=False)
        return k, len(ts)
    by_net = {}
    for k in jobs: by_net.setdefault(feeds[k]['network'], []).append(k)
    with ThreadPoolExecutor(len(by_net)) as ex:
        for res in ex.map(lambda n: [one(k) for k in by_net[n]], list(by_net)):
            for k, n in res: print(k, n, flush=True)

# ------------------------------------------------------------------ simulations on the episodes
HF = os.path.join(ROOT, 'data', 'series', 'hourly_feeds')
_hc = {}
def hseries(k):
    if k not in _hc:
        d = pd.read_csv(os.path.join(HF, f'cl_{k}.csv')).dropna(subset=['price'])
        _hc[k] = pd.Series(d.price.values, index=pd.to_datetime(d.utc).dt.tz_convert(None)).astype(float)
    return _hc[k]

def leg_series(fk):
    s = hseries(fk[0])
    for k in fk[1:]: s = (s * hseries(k)).dropna()
    return s

LABEL = {'ETH': 'Chainlink ETH/USD · Arbitrum', 'USDC': 'Chainlink USDC/USD · Arbitrum', 'WBTC': 'Chainlink WBTC/USD · Arbitrum',
         'cbBTC': 'Chainlink cbBTC/USD · Base', 'WBTC_BTC_mainnet': 'Chainlink WBTC/BTC × BTC/USD · Ethereum',
         'UST_ETH': 'Chainlink USTC/ETH × ETH/USD · Ethereum', 'BTC_mainnet': 'Chainlink BTC/USD · Ethereum (sem WBTC legível em Dez 2021)'}

def position_plan(ep):
    """Every position contains the event hour; 4 h and daily ticks fall on the first reading after the move."""
    h = pd.Timestamp(EPISODES[ep][0]); a = h + pd.Timedelta(hours=1)
    plan = []
    for n, step in ((24, 2), (72, 6)):                  # hourly cadence: the event hour and the next one are both ticks
        for s0 in range(-(n - 1), 1, step):
            plan.append((1, n, h + pd.Timedelta(hours=s0)))
    for n, step in ((30, 12), (60, 24)):                # 4-hourly
        span = (n - 1) * 4
        for s0 in range(-span, 1, step):
            if s0 % 4 == 0: plan.append((4, n, a + pd.Timedelta(hours=s0)))
    for n, step in ((15, 1), (30, 2)):                  # daily, at the hour after the move
        for s0 in range(-(n - 1), 1, step):
            plan.append((24, n, a + pd.Timedelta(days=s0)))
    return plan

def run_episodes():
    from engine import run_basket, run_fixed, run_single
    from scenarios import SPLITS, CAPITAL
    rows = []
    for ep, (h, asset, label, legs, strict) in EPISODES.items():
        fks = leg_feeds(ep); ser = [leg_series(fk) for fk in fks]
        srcs = ' | '.join(LABEL.get(fk[0], fk[0]) for fk in fks)
        h = pd.Timestamp(h)
        for cad_h, n, s0 in position_plan(ep):
            td = [s0 + pd.Timedelta(hours=cad_h * k) for k in range(n)]
            prev0 = s0 - pd.Timedelta(hours=cad_h)
            try:
                P = np.array([[s[t] for s in ser] for t in td]); p0 = np.array([s[prev0] for s in ser])
            except KeyError:
                continue
            ev_idx = next(i for i, t in enumerate(td) if t >= h)
            for sp, w in SPLITS.items():
                variants = {'A': dict(), 'A · regra 9 25% suave': dict(dd_threshold=0.25, dd_mode='soft'),
                            'A · regra 9 25% rígido': dict(dd_threshold=0.25, dd_mode='rigid'),
                            'A · banda peg 1%': dict(stable_idx=2, stable_band=0.01, stable_final='rigid')}
                res = {k: run_basket(P, p0, w, CAPITAL, True, **kw) for k, kw in variants.items()}
                res['A0'] = run_basket(P, p0, w, CAPITAL, False); res['B'] = run_fixed(P, w, CAPITAL); res['C'] = run_single(P[:, 0], CAPITAL)
                for st, r in res.items():
                    p_end = P[-1] if st != 'C' else P[-1, :1]
                    rows.append(dict(section='2.10', episode=ep, episode_label=label, strict_15=strict, event_hour=str(h),
                                     cadence_h=cad_h, n_ticks=n, start=str(s0), end=str(td[-1]), event_tick=ev_idx,
                                     split=sp, strategy=st, sources=srcs,
                                     deviation_pp=r.deviation_pp if st != 'C' else np.nan, uninvested_pct=r.uninvested_pct,
                                     final_value=r.final_value(p_end), max_drawdown_pct=r.max_drawdown_pct, n_fills=r.n_fills,
                                     stable_bought_usd=float(r.spent[2]) if st != 'C' else np.nan,
                                     final_tick_share_pct=100 * sum(u for t, i, u, k in r.fills if t == n - 1) / CAPITAL))
    return pd.DataFrame(rows)

def feed_view():
    """What the keeper's feed showed inside each event hour (minute samples) vs the exchange candles."""
    out = []
    for ep, (h, asset, label, legs, strict) in EPISODES.items():
        h = pd.Timestamp(h); idx = {'ETH': 0, 'BTC': 1, 'UST': 2, 'USDC': 2}[asset]
        fk = leg_feeds(ep)[idx]; s = leg_series(fk)
        m = s.loc[h:h + pd.Timedelta(minutes=60)]
        hourly = s.reindex([h + pd.Timedelta(hours=k) for k in range(0, 2)])
        out.append(dict(episode=ep, label=label, feed=LABEL.get(fk[0], fk[0]), minute_points=len(m),
                        feed_open=float(m.iloc[0]) if len(m) else np.nan,
                        feed_min=float(m.min()) if len(m) else np.nan, feed_max=float(m.max()) if len(m) else np.nan,
                        feed_range_pct=float((m.max() / m.min() - 1) * 100) if len(m) else np.nan,
                        feed_hour_to_hour_pct=float((hourly.iloc[1] / hourly.iloc[0] - 1) * 100)))
    return pd.DataFrame(out)
