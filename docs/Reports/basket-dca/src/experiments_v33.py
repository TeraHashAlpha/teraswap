"""v3.3 · Coinbase tokenized stocks (Base) as Split DCA legs.

Two windows, both real data:
  real  : 25 Aug – 16 Nov 2026, hourly. Stock legs: the «Coinbase X» total-return feeds on Base (24/5) for the
          ADR-024 decision price (feed if its round is <= 600 s old, else DefiLlama) and for the on-chain floor; the
          token's DefiLlama hourly price as the DEX/execution price. Crypto and USDT legs: DefiLlama hourly.
  long  : Jan 2023 – Aug 2026, one tick a day at 12:00 UTC. Stock legs: the per-share NYSE feeds on Arbitrum
          (Chainlink, raw), split-adjusted from the feed itself; crypto: DefiLlama hourly. Approximation, declared:
          no overnight session, no dividends; used for closures over 3.5 years and for the split case.
Options for a stock leg while the US market is closed (weekend, holiday):
  A    : the stock leg has no price (keeper skips it; the engine catches up later).
  B    : the basket's cycles fall only on market days (all legs wait).
  C90  : the stock leg buys at the DEX price; on-chain floor from the feed only while its round is <= 90 000 s old.
  C3d  : same, maxStaleness 100 h (360 000 s): the last close floors every weekend and 3-day holiday, even when the
         feed's last round came up to 24 h (one heartbeat) before the close.
  Cfz  : as C3d but the keeper decides on the frozen feed (0% move) - only to measure the rule-4 bias.
Engine: v3.2 discrete (L = 2, Hamilton, k_soft = ceil(N/4) no cap, rule 9 at 25%, soft), 1 000 USD, minFill 16 USD,
floor slippage 3% (DEFAULT_MAX_SLIPPAGE_BPS = 300); a purchase the floor would refuse is not made that cycle."""
import os, sys, json, math, itertools, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import experiments_v3 as e3, experiments_v32 as E
from scenarios import SPLITS
from engine_discrete import run_discrete, choose_n
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V33 = os.path.join(ROOT, 'data', 'series', 'v33'); R33 = os.path.join(ROOT, 'results', 'v33'); os.makedirs(R33, exist_ok=True)
GZ = {'method': 'gzip', 'mtime': 0}
THR, MINFILL, L, G, C, SLIP = 0.25, 16.0, 2, 3, 1000.0, 0.03
NS = (6, 7, 8, 9, 10, 12, 15, 20, 26, 30, 60, 86)
MAXS = {'A': 90000, 'B': 90000, 'C90': 90000, 'C3d': 360000, 'Cfz': 360000}   # 100 h: 72 h closure + 24 h heartbeat + 4 h
def fits(N, c): return (N + 4) * c < 90                      # spec: expiry = start + (N + 4) x T + margin <= 90 days
STOCKS = ('NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'TSLA')
REAL_START, REAL_END = pd.Timestamp('2026-08-25'), pd.Timestamp('2026-11-15 23:00')
H = pd.date_range('2026-08-20', REAL_END, freq='h')
BASKETS = {  # name: (legs, kind); a stock leg is 'NVDAc', crypto 'ETH'/'BTC', stable 'USDT'
    'ETH+cbBTC+NVDAc': (('ETH', 'BTC', 'NVDAc'), '2 cripto + 1 acção'), 'ETH+cbBTC+AAPLc': (('ETH', 'BTC', 'AAPLc'), '2 cripto + 1 acção'),
    'ETH+cbBTC+TSLAc': (('ETH', 'BTC', 'TSLAc'), '2 cripto + 1 acção'), 'ETH+NVDAc+MSFTc': (('ETH', 'NVDAc', 'MSFTc'), '1 cripto + 2 acções'),
    'NVDAc+AAPLc+MSFTc': (('NVDAc', 'AAPLc', 'MSFTc'), '3 acções'), 'AMZNc+GOOGLc+METAc': (('AMZNc', 'GOOGLc', 'METAc'), '3 acções'),
    'ETH+NVDAc+USDT': (('ETH', 'NVDAc', 'USDT'), 'cripto + acção + stable'), 'NVDAc+AAPLc+USDT': (('NVDAc', 'AAPLc', 'USDT'), '2 acções + stable')}
LONG_BASKETS = {'ETH+BTC+NVDA': ('ETH', 'BTC', 'NVDA'), 'NVDA+AAPL+MSFT': ('NVDA', 'AAPL', 'MSFT'), 'ETH+NVDA+USDT': ('ETH', 'NVDA', 'USDT')}
def is_stock(leg): return leg.endswith('c') and leg[:-1] in STOCKS or leg in STOCKS

# ------------------------------------------------------------------ data
def _rounds(key):
    d = pd.read_csv(os.path.join(V33, f'rounds_{key}.csv')); return d[d.updatedAt > 0].sort_values('updatedAt')
_dl = {}
def dl(sym):
    if sym not in _dl:
        d = pd.read_csv(os.path.join(V33, f'defillama_{sym}_hourly.csv'))
        s = pd.Series(d.price.values, index=pd.to_datetime(d.ts, unit='s')).sort_index(); _dl[sym] = s[~s.index.duplicated()]
    return _dl[sym]
def on_grid(s, grid): return s.reindex(grid, method='nearest', tolerance=pd.Timedelta('1h')).values

def closure_calendar(grid, gap_h=26):
    """Closed = every Coinbase feed is inside one of its own gaps longer than gap_h hours (nobody quotes)."""
    cfg = json.load(open(os.path.join(V33, 'feeds_v33.json'))); ts = e3.to_epoch(grid); closed = np.ones(len(grid), bool)
    for key in [k for k in cfg if k.startswith('cb_')]:
        u = _rounds(key).updatedAt.values; i = np.searchsorted(u, ts, side='right') - 1
        ok = (i >= 0) & (i + 1 < len(u))
        gap = np.where(ok, (u[np.clip(i + 1, 0, len(u) - 1)] - u[np.clip(i, 0, len(u) - 1)]) / 3600, 0)
        closed &= ok & (gap > gap_h)
    return closed

_legs = {}
def leg_arrays(leg):
    """Real window: exec (DEX/DefiLlama), dec (ADR-024), feed price and age, next-open feed price."""
    if leg in _legs: return _legs[leg]
    n = len(H)
    if leg in ('ETH', 'BTC', 'USDT'):
        sym = {'BTC': 'cbBTC'}.get(leg, leg); p = on_grid(dl(sym), H)
        out = dict(exec=p, dec=p, feed=np.full(n, np.nan), age=np.full(n, np.inf), reopen=np.full(n, np.nan))
    else:
        r = _rounds(f'cb_{leg[:-1]}'); ts = e3.to_epoch(H); fp, age = e3.sample_rounds(r, ts)
        d = on_grid(dl(leg), H)
        dec = np.where((age == age) & (age <= 600), fp, d)
        u = r.updatedAt.values; j = np.searchsorted(u, ts, side='right')            # the first round after t
        reopen = np.where(j < len(u), r.price.values[np.clip(j, 0, len(u) - 1)], np.nan)
        out = dict(exec=d, dec=dec, feed=fp, age=age, reopen=reopen)
    _legs[leg] = out; return out

# ------------------------------------------------------------------ positions
def ticks_calendar(i0, c, n):                     # i0: hourly index of the first tick
    return [i0 + 24 * c * k for k in range(n)]
def ticks_market(i0, c, n, closed):
    """B: daily / 3-day = every (c)th open day at the same hour; weekly = +7 days, moved to the next open hour."""
    out = []
    if c == 7:
        for k in range(n):
            i = i0 + 24 * 7 * k
            while i < len(closed) and closed[i]: i += 1
            out.append(i)
        return out
    i, cnt = i0, 0
    while len(out) < n and i < len(closed):
        if not closed[i]:
            if cnt % c == 0: out.append(i)
            cnt += 1
        i += 24
    return out

def build(legs, idx, opt, closed, stable_idx=None):
    """idx: N + 1 + G hourly indices (previous tick, N ticks, G grace ticks). Returns the engine matrices."""
    idx = np.asarray(idx); PE, PD = [], []
    for leg in legs:
        a = leg_arrays(leg); pe = a['exec'][idx].copy(); pdv = a['dec'][idx].copy()
        if is_stock(leg):
            cl = closed[idx]
            if opt == 'A': pdv[cl] = np.nan
            if opt == 'Cfz': pdv = np.where(cl, a['feed'][idx], pdv)
            fresh = a['age'][idx] <= MAXS[opt]                                      # on-chain floor exists only then
            floor_fail = fresh & (pe > a['feed'][idx] / (1 - SLIP))                 # a USDC -> stock buy below the floor reverts
            pdv[floor_fail] = np.nan
        PE.append(pe); PD.append(pdv)
    M = np.column_stack(PE); D = np.column_stack(PD); N = len(idx) - 1 - G
    if np.isnan(M).any(): return None                                              # every leg priced on every tick, or no position
    return dict(Pe=M[1:N + 1], p0=M[0], Pd=D[1:N + 1], pd0=D[0], rPe=M[N + 1:], rPd=D[N + 1:], idx=idx)

def run_real(task):
    bname, opt = task; legs, kind = BASKETS[bname]; closed = closure_calendar(H)
    st = [j for j, l in enumerate(legs) if is_stock(l)]; sidx = legs.index('USDT') if 'USDT' in legs else None
    sb = dict(stable_idx=sidx, band=0.01) if sidx is not None else {}
    rows = []
    i_first = int(np.searchsorted(H, REAL_START))
    for c in (1, 3, 7):
        for N in [N for N in NS if fits(N, c)]:
            for day in pd.date_range(REAL_START, REAL_END.normalize(), freq='D'):
                for hour in (0, 6, 12, 18):
                    i0 = int(np.searchsorted(H, day + pd.Timedelta(hours=hour)))
                    if i0 - 24 * c < 0: continue
                    if opt == 'B':
                        if closed[i0]: continue                                     # a B basket starts on an open hour
                        seq = ticks_market(i0, c, N + G, closed)
                        if len(seq) < N + G or seq[-1] >= len(H): continue
                        prev = seq[0] - 24 * c
                        span_days = (H[seq[-1]] - H[prev]).total_seconds() / 86400 + c  # creation to the end of the last extra cycle,
                        if span_days >= 90: continue                                # as (N + 4) x T in the spec; else it does not fit
                        idx = [prev] + seq
                    else:
                        idx = [i0 - 24 * c] + ticks_calendar(i0, c, N + G)
                    if idx[-1] >= len(H) or i0 < i_first: continue
                    m = build(legs, idx, opt, closed, sidx)
                    if m is None: continue
                    for sp in SPLITS:
                        w = np.asarray(SPLITS[sp])
                        r = run_discrete(m['Pe'], w, n=None, min_fill=MINFILL, L=L, Pd=m['Pd'], pd0=m['pd0'], rPe=m['rPe'], rPd=m['rPd'],
                                         dd=THR, mode='soft', k_soft=E.k_rec, **sb)
                        ti = np.asarray(idx[1:]); cl = closed[ti]
                        wk = [(t, i, x) for t, i, x, kk in r.fills if i in st and cl[t]]
                        sel_closed = [i for t, i, x, kk in r.fills if kk == 'select' and cl[t]]
                        gap = [leg_arrays(legs[i])['exec'][ti[t]] / leg_arrays(legs[i])['reopen'][ti[t]] - 1 for t, i, x in wk
                               if leg_arrays(legs[i])['reopen'][ti[t]] == leg_arrays(legs[i])['reopen'][ti[t]]]
                        rows.append(dict(window='real', basket=bname, kind=kind, option=opt, start=str(H[i0]), hour=hour, cadence_d=c, N=N, split=sp,
                                         k=r.k_soft, n_chunks=int(r.n.sum()), pending_chunks=r.pending_chunks, pend_stock=int(sum(r.n[i] - r.done[i] for i in st)),
                                         unbought_pct=round(100 * r.unbought_usd / C, 4), max_cycle_pct=round(r.max_cycle_pct, 4), fills_in_grace=r.fills_in_grace,
                                         idle_sem_preco=r.idle_counts['sem preço'], idle_banda=r.idle_counts['banda'], r9_cycles=r.r9_block_cycles,
                                         closed_ticks=int(cl[:N + G].sum()), stock_fills_closed=len(wk), stock_usd_closed=round(sum(x for _, _, x in wk), 4),
                                         sel_closed=len(sel_closed), sel_closed_stock=sum(1 for i in sel_closed if i in st),
                                         gap_sum=round(float(np.sum(gap)), 6), gap_n=len(gap), gap_max=round(float(np.max(gap)), 6) if gap else np.nan,
                                         span_days=round((H[idx[N]] - H[idx[0]]).total_seconds() / 86400, 2),
                                         value_end=round(r.value_end, 4)))
    return pd.DataFrame(rows)

def run_all_real():
    from multiprocessing import Pool
    tasks = [(b, o) for b in BASKETS for o in ('A', 'B', 'C90', 'C3d', 'Cfz') if o != 'Cfz' or BASKETS[b][1].startswith('2 cripto')]
    with Pool(2) as p: out = p.map(run_real, tasks, chunksize=1)
    pd.concat(out, ignore_index=True).to_csv(os.path.join(R33, 'real_window.csv.gz'), index=False, compression=GZ)

# ------------------------------------------------------------------ long window: closures, splits, A vs B
H2 = pd.date_range('2022-12-01', '2026-11-16 23:00', freq='h')
def arb_series(sym):
    """Per-share NYSE feed on Arbitrum, hour by hour (last round), plus the split factors found in the feed itself."""
    r = _rounds(f'arb_{sym}'); u = r.updatedAt.values; p = r.price.values
    splits = []
    for k in range(1, len(p)):
        ratio = p[k] / p[k - 1]
        if ratio < 0.6 and (u[k] - u[k - 1]) > 12 * 3600:
            m = round(1 / ratio)
            if m >= 2 and abs(1 / ratio - m) / m < 0.06: splits.append((int(u[k]), m))
    adj = p.astype(float).copy()
    for ts, m in splits: adj[u < ts] = adj[u < ts] / m
    ts2 = e3.to_epoch(H2); i = np.searchsorted(u, ts2, side='right') - 1; ok = i >= 0
    raw = np.where(ok, p[np.clip(i, 0, None)], np.nan); ad = np.where(ok, adj[np.clip(i, 0, None)], np.nan)
    moved = np.r_[True, np.diff(p) != 0]                                             # heartbeat rounds on closed days repeat the price
    days = sorted({pd.Timestamp(x, unit='s').tz_localize('UTC').tz_convert('America/New_York').date() for x in u[moved]})
    return raw, ad, splits, days

def long_calendar():
    """Market day = a NYSE session (XNYS calendar, saved by fetch_v33.sessions()). The Arbitrum feeds are not used for
    this: they publish moved prices on some weekends and holidays."""
    d = pd.read_csv(os.path.join(V33, 'xnys_sessions.csv'))
    return {pd.Timestamp(x).date() for x in d.session}

def long_closures():
    """Every run of consecutive closed ET calendar days (weekends, holidays) since the first round."""
    days = sorted(long_calendar()); out = []
    for a, b in zip(days[:-1], days[1:]):
        gap = (pd.Timestamp(b) - pd.Timestamp(a)).days - 1
        if gap > 0: out.append(dict(last_open=str(a), next_open=str(b), closed_days=gap, closed_hours_24_5=24 * gap))       # 24/5: session of day D runs D-1 20:00 ET to D 20:00 ET
    return pd.DataFrame(out)

def weekend_moves():
    """Close-to-reopen move of every NYSE closure (XNYS calendar), per stock, split-adjusted: last round at or before
    16:05 ET on the last session, first round at or after 09:30 ET on the next session (the Arbitrum feeds also publish
    some prices on closed days; those are ignored). This is the move a stale floor would have to absorb."""
    days = sorted(long_calendar()); dset = set(days); rows = []
    for s in ('NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'TSLA'):
        r = _rounds(f'arb_{s}'); u = r.updatedAt.values; p = r.price.values.astype(float).copy(); _, _, splits, _ = arb_series(s)
        for ts, m in splits: p[u < ts] = p[u < ts] / m
        et = pd.to_datetime(u, unit='s').tz_localize('UTC').tz_convert('America/New_York')
        d = np.array([x.date() for x in et]); hm = et.hour * 60 + et.minute
        for a, b in zip(days[:-1], days[1:]):
            gap = (pd.Timestamp(b) - pd.Timestamp(a)).days - 1
            if gap < 1 or a < d.min() or b > d.max(): continue
            ia = np.where((d == a) & (hm <= 16 * 60 + 5))[0]; ib = np.where((d == b) & (hm >= 9 * 60 + 30))[0]
            if not len(ia) or not len(ib): continue
            rows.append(dict(stock=s, last_open=str(a), next_open=str(b), closed_days=gap, move_pct=100 * (p[ib[0]] / p[ia[-1]] - 1)))
    return pd.DataFrame(rows)

def run_long(task):
    bname, opt, variant = task; legs = LONG_BASKETS[bname]; days = long_calendar()
    st = [j for j, l in enumerate(legs) if l in STOCKS]; sidx = legs.index('USDT') if 'USDT' in legs else None
    sb = dict(stable_idx=sidx, band=0.01) if sidx is not None else {}
    grid = pd.date_range('2023-01-02 12:00', '2026-11-06 12:00', freq='D'); gi = np.searchsorted(H2, grid)
    et = [(t - pd.Timedelta(hours=5)).date() for t in grid]
    closed = np.array([d not in days for d in et])
    cols = []
    for leg in legs:
        if leg in STOCKS:
            raw, ad, _, _ = arb_series(leg); cols.append((raw if variant == 'raw' else ad)[gi])
        else:
            sym = {'BTC': 'cbBTC'}.get(leg, leg); s = on_grid(dl(sym), grid)
            if leg == 'BTC':
                s = np.where(np.isnan(s), on_grid(dl('WBTC'), grid), s)
            cols.append(s)
    P = np.column_stack(cols); rows = []
    first = np.where(~np.isnan(P).any(axis=1))[0][0]
    for c in (1, 3, 7):
        for N in [N for N in NS if fits(N, c)]:
            for s0 in range(first + c, len(grid), 2):
                if opt == 'B':
                    if closed[s0]: continue
                    seq = []; i = s0; cnt = 0
                    if c == 7:
                        for k in range(N + G):
                            j = s0 + 7 * k
                            while j < len(grid) and closed[j]: j += 1
                            seq.append(j)
                    else:
                        while len(seq) < N + G and i < len(grid):
                            if not closed[i]:
                                if cnt % c == 0: seq.append(i)
                                cnt += 1
                            i += 1
                    if len(seq) < N + G or seq[-1] >= len(grid): continue
                    if seq[-1] - (seq[0] - c) + c >= 90: continue
                    idx = [seq[0] - c] + seq
                else:
                    idx = [s0 - c] + [s0 + c * k for k in range(N + G)]
                    if idx[-1] >= len(grid): continue
                idx = np.asarray(idx); Pe = P[idx].copy(); Pd = Pe.copy()
                if opt == 'A':
                    for j in st: Pd[closed[idx], j] = np.nan
                if np.isnan(Pe[:, :]).all(axis=0).any(): continue
                N1 = N + 1
                for sp in SPLITS:
                    w = np.asarray(SPLITS[sp])
                    for mode in (('soft', 'rigid') if variant == 'raw' or bname == 'ETH+BTC+NVDA' else ('soft',)):
                        r = run_discrete(Pe[1:N1], w, n=None, min_fill=MINFILL, L=L, Pd=Pd[1:N1], pd0=Pd[0], rPe=Pe[N1:], rPd=Pd[N1:],
                                         dd=THR, mode=mode, k_soft=E.k_rec, **sb)
                        rows.append(dict(window='long', basket=bname, option=opt, variant=variant, mode=mode, start=str(grid[idx[1]].date()), cadence_d=c, N=N, split=sp,
                                         pending_chunks=r.pending_chunks, unbought_pct=round(100 * r.unbought_usd / C, 4), max_cycle_pct=round(r.max_cycle_pct, 4),
                                         fills_in_grace=r.fills_in_grace, idle_sem_preco=r.idle_counts['sem preço'], r9_cycles=r.r9_block_cycles,
                                         prot_stock=int(sum(r.prot_cycles[j] for j in st)), span_days=int(idx[N] - idx[0]), value_end=round(r.value_end, 4)))
    return pd.DataFrame(rows)

def run_all_long():
    from multiprocessing import Pool
    tasks = [(b, o, 'adj') for b in LONG_BASKETS for o in ('A', 'B')] + [('ETH+BTC+NVDA', 'A', 'raw')]
    with Pool(2) as p: out = p.map(run_long, tasks, chunksize=1)
    pd.concat(out, ignore_index=True).to_csv(os.path.join(R33, 'long_window.csv.gz'), index=False, compression=GZ)

# ------------------------------------------------------------------ feed facts
def feed_facts():
    cfg = json.load(open(os.path.join(V33, 'feeds_v33.json'))); closed = closure_calendar(H); rows = []
    for key, c in cfg.items():
        r = _rounds(key); u = r.updatedAt.values; p = r.price.values; g = np.diff(u) / 3600
        t0 = pd.Timestamp(u[0], unit='s'); step = np.abs(np.diff(p) / p[:-1]) * 100
        rec = dict(key=key, symbol=c['symbol'], network=c['network'], category=c.get('category'), threshold=c.get('threshold'), heartbeat=c.get('heartbeat'),
                   rounds=len(r), first=str(t0)[:16], last=str(pd.Timestamp(u[-1], unit='s'))[:16], gaps_over_26h=int((g > 26).sum()),
                   max_gap_h=round(float(g.max()), 1), in_session_gaps_20_26h=int(((g > 20) & (g <= 26)).sum()), max_step_pct=round(float(step.max()), 2))
        if key.startswith('cb_') and os.path.exists(os.path.join(V33, f"defillama_{c['symbol']}c_hourly.csv")):
            a = leg_arrays(c['symbol'] + 'c'); m = (~closed) & (a['dec'] == a['dec']) & (a['exec'] == a['exec']) & (a['feed'] == a['feed']) & (H >= REAL_START)
            dev = np.abs(a['exec'][m] / a['feed'][m] - 1) * 100
            mc = closed & (a['exec'] == a['exec']) & (a['feed'] == a['feed']) & (H >= REAL_START)
            devc = (a['exec'][mc] / a['feed'][mc] - 1) * 100
            rec.update(dex_vs_feed_open_med=round(float(np.median(dev)), 3), dex_vs_feed_open_p95=round(float(np.percentile(dev, 95)), 3),
                       dex_vs_feed_closed_p5=round(float(np.percentile(devc, 5)), 2), dex_vs_feed_closed_p95=round(float(np.percentile(devc, 95)), 2),
                       closed_hours_floor_fail_3pct=round(100 * float((devc > 100 * (1 / (1 - SLIP) - 1)).mean()), 2),
                       decided_by_feed_pct=round(100 * float(((a['age'] <= 600) & ~closed & (H >= REAL_START)).sum() / max(1, (~closed & (H >= REAL_START)).sum())), 1))
        elif key.startswith('arb_'):
            _, _, splits, _ = arb_series(c['symbol'])
            rec.update(splits='; '.join(f'{pd.Timestamp(ts, unit="s").date()} {m}:1' for ts, m in splits) or '—')
        rows.append(rec)
    cl = closure_calendar(H); seg = []; i = 0
    while i < len(H):
        if cl[i]:
            j = i
            while j + 1 < len(H) and cl[j + 1]: j += 1
            seg.append(dict(closed_from=str(H[i]), closed_to=str(H[j]), hours=j - i + 1, weekday_from=H[i].day_name()))
            i = j + 1
        else: i += 1
    return pd.DataFrame(rows), pd.DataFrame(seg)

def compute():
    f, seg = feed_facts(); f.to_csv(os.path.join(R33, 'feeds.csv'), index=False); seg.to_csv(os.path.join(R33, 'closures_real.csv'), index=False)
    long_closures().to_csv(os.path.join(R33, 'closures_long.csv'), index=False); weekend_moves().to_csv(os.path.join(R33, 'weekend_moves_long.csv'), index=False)
    run_all_real(); run_all_long()

if __name__ == '__main__':
    compute()
