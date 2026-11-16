"""v3.2 · A: the soft-mode window k_soft as a function of N; B: the stable leg of phase 1 on Base (USDT or DAI).

Positions: N ticks at a product cadence c (1, 3 or 7 days), N in the request's list where (N + 3)·c fits the 90-day
order limit, on the v3.1 windows: S1–S7 (one position starting on each day of the window), Jul–Out 2026 (one per
day), the 7 episodes (daily 00:00 positions whose span contains the move) and the 5-year sample (one per day from
31 Mar 2022). A+ discreto, L = 2, Hamilton, rule 9 at 25%, 1 000 USD, minFill 16 USD.

Stable legs (USDT, DAI): execution price = the Base feed the executor has registered (from Aug 2023), else the same
feed on Ethereum; decision price = the Architect's rule: the feed while its round is no older than maxStaleness, else
the quorum (DefiLlama here), else no price; band: |p − 1| + the feed's deviation threshold > band when the feed
decides. Volatile legs exactly as v3.1 (switch P: Chainlink <= 600 s, else DefiLlama)."""
import os, sys, json, math, itertools, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import experiments as ex, experiments_v3 as e3, experiments_v3x as xx, hourly_events as he, scenarios as sc, t7_stables as T7
from scenarios import SPLITS
from engine_discrete import run_discrete, choose_n
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R32 = os.path.join(ROOT, 'results', 'v32'); os.makedirs(R32, exist_ok=True)
V32 = os.path.join(ROOT, 'data', 'series', 'v32')
GZ = {'method': 'gzip', 'mtime': 0}
THR, MINFILL, L, G, C = 0.25, 16.0, 2, 3, 1000.0
NS = (6, 7, 8, 9, 10, 12, 15, 20, 26, 30, 60, 86)
CADS = (1, 3, 7)
MAX_DAYS = 90
def fits(N, c): return (N + G) * c < MAX_DAYS          # expiry = start + (N + 3)·c + margin <= 90 days
COMBOS = [(c, N) for c in CADS for N in NS if fits(N, c)]
BASKETS = {'ETH+cbBTC+VIRTUAL': ('ETH', 'BTC', 'VIRTUAL'), 'ETH+cbBTC+COMP': ('ETH', 'BTC', 'COMP'),
           'ETH+cbBTC+AERO': ('ETH', 'BTC', 'AERO'), 'ETH+cbBTC+USDT': ('ETH', 'BTC', 'USDT'), 'ETH+cbBTC+DAI': ('ETH', 'BTC', 'DAI')}
STABLE_B = ('ETH+cbBTC+USDT', 'ETH+cbBTC+DAI')
BAND = 0.01

# ------------------------------------------------------------------ k_soft candidates (each returns k for (N, n))
def _c(x, lo=1, hi=10): return int(max(lo, min(hi, x)))
CANDS = {
    'k = 10':          lambda N, n: 10,
    '⌈N/2⌉':           lambda N, n: _c(math.ceil(N / 2)),
    '⌈N/3⌉':           lambda N, n: _c(math.ceil(N / 3)),
    '⌈N/4⌉':           lambda N, n: _c(math.ceil(N / 4)),
    '⌈N/4⌉ sem tecto': lambda N, n: _c(math.ceil(N / 4), hi=10 ** 6),
    'garantia':        lambda N, n: _c(math.ceil(int(np.max(n)) / L) - G, hi=10 ** 6),   # smallest window that still fits
}                                                                                        # every chunk of a leg protected until then
CAND_ORDER = list(CANDS)
K_REC_NAME = '⌈N/4⌉ sem tecto'          # set after the run (see report_v32); used by §B4 and the tests
def k_rec(N, n=None): return CANDS[K_REC_NAME](N, n)

# ------------------------------------------------------------------ daily grid, one array per price source
GRID = pd.date_range('2021-01-01', '2027-02-28', freq='D')
GIX = {d: i for i, d in enumerate(GRID)}
DATA_LAST = pd.Timestamp('2026-11-07')       # last daily row any v3.1 source has; later rows are «no data»
STABLE_SRC = {'USDT': ['USDT_base', 'USDT_eth'], 'DAI': ['DAI_base', 'DAI_eth']}
STABLE_LABEL = {'USDT_base': 'Chainlink USDT/USD · Base', 'USDT_eth': 'Chainlink USDT/USD · Ethereum',
                'DAI_base': 'Chainlink DAI/USD · Base', 'DAI_eth': 'Chainlink DAI/USD · Ethereum'}

def stable_params():
    """(deviation threshold, maxStaleness) for each stable source: Base from the executor registry + directory;
    Ethereum from the mainnet directory, maxStaleness = heartbeat × 90 000 / 86 400 (the Base executor's ratio)."""
    reg = {t['symbol']: t for t in json.load(open(os.path.join(V32, 'executor_registry_base_v32.json')))['tokens']}
    cfg = json.load(open(os.path.join(T7.ST, 'stable_feeds.json')))
    out = {}
    for s in ('USDT', 'DAI'):
        out[f'{s}_base'] = (float(reg[s]['directory_threshold_pct']) / 100, float(reg[s]['maxStaleness']))
        out[f'{s}_eth'] = (float(cfg[s]['threshold']) / 100, float(cfg[s]['heartbeat']) * 90000 / 86400)
    return out

def stable_rounds(src):
    if src == 'USDT_eth':
        d = pd.read_csv(os.path.join(T7.ST, 'cl_rounds_USDT.csv'))
    else:
        d = pd.read_csv(os.path.join(V32, f'rounds_{src}.csv'))
    d = d[d.updatedAt > 0].sort_values('updatedAt'); return d

_dlh = {}
def dl_stable(sym):
    if sym not in _dlh:
        d = pd.read_csv(os.path.join(T7.ST, f'defillama_{sym}_hourly.csv'))
        s = pd.Series(d.price.values, index=pd.to_datetime(d.ts, unit='s')).sort_index(); _dlh[sym] = s[~s.index.duplicated()]
    return _dlh[sym]

def dl_near(sym, idx):
    return dl_stable(sym).reindex(idx, method='nearest', tolerance=pd.Timedelta('1h')).values

_arr = {}
def src_arrays(src):
    """pe, pd, badd on GRID (NaN where the source has no data)."""
    if src in _arr: return _arr[src]
    n = len(GRID); keep = GRID <= DATA_LAST
    if src in STABLE_LABEL:
        thr, max_s = stable_params()[src]; sym = src.split('_')[0]
        r = stable_rounds(src); ts = e3.to_epoch(GRID)
        p, age = e3.sample_rounds(r, ts)
        p = np.where(keep, p, np.nan); age = np.where(keep, age, np.nan)
        ok = (age == age) & (age <= max_s)
        dl = dl_near(sym, GRID)
        pdv = np.where(ok, p, np.where(keep, dl, np.nan)); badd = np.where(ok, thr, 0.0)
        out = (p, pdv, badd)
    else:
        t = xx.src_table(src)
        if t is None: out = (np.full(n, np.nan),) * 2 + (np.zeros(n),)
        else:
            x = t.reindex(GRID); out = (x.pe.values.astype(float), x.pd.values.astype(float), np.zeros(n))
    _arr[src] = out; return out

def leg_candidates(leg): return STABLE_SRC.get(leg) or xx.candidates(leg)

def build(legs, i0, c, N):
    """Matrices for a position starting at GRID[i0]: previous tick + N ticks, then 3 retry/grace ticks."""
    need = i0 - c + c * np.arange(N + 1); rix = i0 + c * (N - 1) + c * np.arange(1, G + 1)
    if need[0] < 0 or rix[-1] >= len(GRID): return None
    srcs, PE, PD, RE, RD, BA = [], [], [], [], [], []
    for leg in legs:
        got = None
        for src in leg_candidates(leg):
            pe, pdv, badd = src_arrays(src)
            if not np.isnan(pe[need]).any(): got = src; break
        if got is None: return None
        srcs.append(got); PE.append(pe[need]); PD.append(pdv[need]); RE.append(pe[rix]); RD.append(pdv[rix])
        BA.append(np.concatenate([badd[need[1:]], badd[rix]]))
    M = np.column_stack(PE); D = np.column_stack(PD); rPe = np.column_stack(RE); rPd = np.column_stack(RD)
    rPe = np.where(np.isnan(rPe), rPd, rPe)
    return dict(Pe=M[1:], p0=M[0], Pd=D[1:], pd0=D[0], rPe=rPe, rPd=rPd, sources=srcs, badd=BA[2])

# ------------------------------------------------------------------ position families
def episode_days():
    return {ep: pd.Timestamp(v[0]).normalize() for ep, v in he.EPISODES.items()}

def starts(fam, c, N):
    """(meta, start date) for a family; every position's last tick is <= DATA_END."""
    span = pd.Timedelta(days=(N - 1) * c)
    if fam == 'S1–S7':
        for k, (a, b, lab) in ex.stress_windows().items():
            for s0 in pd.date_range(a, b, freq='D'):
                if s0 + span <= sc.DATA_END: yield dict(window=k), s0
    elif fam == 'Jul–Out 2026':
        for s0 in pd.date_range('2026-07-01', '2026-10-31', freq='D'):
            if s0 + span <= sc.DATA_END: yield dict(window='Jul–Out 2026'), s0
    elif fam == 'Episódios':
        for ep, d in episode_days().items():                 # the move happens between tick d and tick d + 1 day
            for s0 in pd.date_range(d + pd.Timedelta(days=1) - span, d, freq='D'):
                if s0 + span <= sc.DATA_END: yield dict(window=ep), s0
    elif fam == '5 anos':
        for s0 in pd.date_range('2022-03-31', sc.DATA_END, freq='D'):
            if s0 + span <= sc.DATA_END: yield dict(window='5 anos'), s0
FAMS = ('S1–S7', 'Jul–Out 2026', 'Episódios', '5 anos')

def protection_possible(m, dd=THR):
    """True if rule 9 can switch on for some leg in the position (decision price <= 75% of the entry price)."""
    PdA = np.vstack([m['Pd'], m['rPd']])
    for i in range(PdA.shape[1]):
        col = PdA[:, i]; ok = ~np.isnan(col)
        if not ok.any(): continue
        e = col[ok][0]
        if (col[ok] <= e * (1 - dd)).any(): return True
    return False

COLS = ['basket', 'family', 'window', 'start', 'cadence_d', 'N', 'split', 'protected', 'run', 'cands', 'k', 'n_chunks',
        'pending_chunks', 'unbought_pct', 'max_cycle_pct', 'n_prot_fills', 'prot_spent_pct', 'prot_mean_drop_pct',
        'r9_block_cycles', 'r9_block_leg_cycles', 'fills_in_grace', 'idle_banda', 'idle_sem_preco', 'idle_regra9', 'band_cycles', 'value_end', 'src3']

def _row(base, run, cands, r):
    return dict(base, run=run, cands=cands, k=(r.k_soft if r.k_soft is not None else -1), n_chunks=int(r.n.sum()),
                pending_chunks=r.pending_chunks, unbought_pct=round(100 * r.unbought_usd / C, 4), max_cycle_pct=round(r.max_cycle_pct, 4),
                n_prot_fills=r.n_prot_fills, prot_spent_pct=round(r.prot_spent_pct, 4),
                prot_mean_drop_pct=(round(r.prot_mean_drop_pct, 4) if r.prot_mean_drop_pct == r.prot_mean_drop_pct else np.nan),
                r9_block_cycles=r.r9_block_cycles, r9_block_leg_cycles=r.r9_block_leg_cycles, fills_in_grace=r.fills_in_grace,
                idle_banda=r.idle_counts['banda'], idle_sem_preco=r.idle_counts['sem preço'], idle_regra9=r.idle_counts['regra 9'],
                band_cycles=r.band_cycles, value_end=round(r.value_end, 4))

def runs_position(bname, m, w, N, base, cands=None, band=BAND):
    """Every distinct k among the candidates (soft), the rigid mode and the same position without rule 9."""
    stable = bname in STABLE_B
    sb = dict(stable_idx=2, band=band, band_add=m['badd']) if stable else {}
    kw = dict(n=None, min_fill=MINFILL, L=L, Pd=m['Pd'], pd0=m['pd0'], rPe=m['rPe'], rPd=m['rPd'], **sb)
    n = choose_n(w, C, N, MINFILL); rows = []
    cands = cands or CAND_ORDER
    if not base['protected']:
        r = run_discrete(m['Pe'], w, dd=THR, mode='soft', k_soft=10, **kw)
        rows.append(_row(base, 'todas', '*', r)); return rows
    ks = {}
    for cn in cands: ks.setdefault(CANDS[cn](N, n), []).append(cn)
    for k, cn in sorted(ks.items()):
        r = run_discrete(m['Pe'], w, dd=THR, mode='soft', k_soft=k, **kw)
        rows.append(_row(base, 'suave', '|'.join(cn), r))
    r = run_discrete(m['Pe'], w, dd=THR, mode='rigid', **kw); rows.append(_row(base, 'rígido', '', r))
    r = run_discrete(m['Pe'], w, dd=None, mode='soft', **kw); rows.append(_row(base, 'sem regra 9', '', r))
    return rows

def runs_for(task):
    bname, c = task; legs = BASKETS[bname]; rows = []
    for N in [N for (cc, N) in COMBOS if cc == c]:
        for fam in FAMS:
            for meta, s0 in starts(fam, c, N):
                m = build(legs, GIX[s0], c, N)
                if m is None: continue
                prot = protection_possible(m)
                for sp in SPLITS:
                    base = dict(basket=bname, family=fam, window=meta['window'], start=s0.date().isoformat(), cadence_d=c, N=N, split=sp,
                                protected=prot, src3=m['sources'][2])
                    rows += runs_position(bname, m, np.asarray(SPLITS[sp]), N, base)
    return pd.DataFrame(rows, columns=COLS)

def run_all(baskets=None):
    from multiprocessing import Pool
    baskets = list(baskets or BASKETS)
    tasks = [(b, c) for b in baskets for c in (1, 3, 7)]          # the long daily tasks first
    with Pool(2) as p:
        out = p.map(runs_for, tasks, chunksize=1)
    for b in baskets:
        d = pd.concat([o for (bb, c), o in zip(tasks, out) if bb == b], ignore_index=True)
        d.to_csv(os.path.join(R32, f'ksoft_{b}.csv.gz'), index=False, compression=GZ)

# ------------------------------------------------------------------ §B4 the stable basket by band, with the chosen k
BANDS = (0.01, 0.02, 0.05, 0.10)
def band_runs_for(task):
    bname, c = task; legs = BASKETS[bname]; rows = []
    for N in [N for (cc, N) in COMBOS if cc == c]:
        for fam in FAMS:
            for meta, s0 in starts(fam, c, N):
                m = build(legs, GIX[s0], c, N)
                if m is None: continue
                for sp in SPLITS:
                    w = np.asarray(SPLITS[sp])
                    for band in BANDS:
                        r = run_discrete(m['Pe'], w, n=None, min_fill=MINFILL, L=L, Pd=m['Pd'], pd0=m['pd0'], rPe=m['rPe'], rPd=m['rPd'],
                                         dd=THR, mode='soft', k_soft=k_rec, stable_idx=2, band=band, band_add=m['badd'])
                        rows.append(dict(basket=bname, family=fam, window=meta['window'], start=s0.date().isoformat(), cadence_d=c, N=N, split=sp,
                                         band_pct=band * 100, k=r.k_soft, pending_chunks=r.pending_chunks, pend_stable=int(r.n[2] - r.done[2]),
                                         unbought_pct=round(100 * r.unbought_usd / C, 6), idle_banda=r.idle_counts['banda'],
                                         idle_sem_preco=r.idle_counts['sem preço'], band_cycles=r.band_cycles, src3=m['sources'][2]))
    return pd.DataFrame(rows)

def run_bands():
    from multiprocessing import Pool
    tasks = [(b, c) for b in STABLE_B for c in CADS]
    with Pool(2) as p:
        out = p.map(band_runs_for, tasks, chunksize=1)
    pd.concat(out, ignore_index=True).to_csv(os.path.join(R32, 'banda_cesto_stable.csv.gz'), index=False, compression=GZ)

# ------------------------------------------------------------------ §B1 the Base USDT/USD and DAI/USD feeds
def feed_params():
    reg = {t['symbol']: t for t in json.load(open(os.path.join(V32, 'executor_registry_base_v32.json')))['tokens']}
    reg31 = {t['symbol']: t for t in json.load(open(os.path.join(ROOT, 'data', 'series', 'v31', 'executor_registry_base_v31.json')))['tokens']}
    rows = []
    for sym, key, t in (('USDT', 'USDT_base', reg['USDT']), ('DAI', 'DAI_base', reg['DAI']), ('USDC', 'USDC_base', reg31['USDC'])):
        d = stable_rounds(key) if key != 'USDC_base' else e3._rounds('USDC_base')
        d = d[d.updatedAt > 0].sort_values('updatedAt')
        hb = float(t['directory_heartbeat_s']); thr = float(t['directory_threshold_pct']); max_s = float(t['maxStaleness'])
        gap = np.diff(d.updatedAt.values); step = np.abs(np.diff(d.price.values) / d.price.values[:-1]) * 100
        dev = step[gap < 0.9 * hb]
        first = pd.to_datetime(d.updatedAt.min(), unit='s')
        idx = pd.date_range(first.ceil('h'), '2026-11-06 23:00', freq='h'); p, age = e3.sample_rounds(d, e3.to_epoch(idx))
        rows.append(dict(token=sym, feed=f'{sym}/USD · Base', directory_threshold_pct=thr, directory_heartbeat_s=hb, max_staleness_s=max_s,
                         rounds=len(d), first_round=str(first.date()), median_gap_h=float(np.median(gap) / 3600),
                         heartbeat_rounds_pct=float((gap >= 0.9 * hb).mean() * 100), deviation_rounds=int(len(dev)),
                         dev_step_median_pct=float(np.median(dev)) if len(dev) else np.nan,
                         hours=len(idx), median_age_h=float(np.nanmedian(age) / 3600), max_age_h=float(np.nanmax(age) / 3600),
                         hours_over_max_staleness=int((age > max_s).sum()), min_price=float(np.nanmin(p)), max_price=float(np.nanmax(p)),
                         description_onchain=t.get('description_onchain'), directory_path=t.get('directory_path')))
    return pd.DataFrame(rows)

# ------------------------------------------------------------------ §B2 the Architect's band rule on USDT and DAI
def _candle_open(sym, idx):
    d = pd.read_csv(os.path.join(T7.ST, f'candles_{sym}.csv'))
    s = pd.Series(d.open.values, index=pd.to_datetime(d.ts, unit='s')); s = s[~s.index.duplicated()].sort_index()
    return s.reindex(idx).values

def _decide(p, age, pdl, band, thr, max_s):
    """1 = out of band (does not buy), 0 = buys, -1 = no price (the leg skips). Q: quorum alone; P: v3.1 base (feed if
    its round is <= 600 s old, else quorum); A: the Architect's rule."""
    def from_q(): return np.where(np.isnan(pdl), -1, (np.abs(pdl - 1) > band).astype(int))
    q = from_q()
    fp = (age == age) & (age <= 600) & (p == p)
    P = np.where(fp, (np.abs(p - 1) > band).astype(int), q)
    fa = (age == age) & (age <= max_s) & (p == p) & (thr < band)
    A = np.where(fa, (np.abs(p - 1) + thr > band).astype(int), q)
    return q, P, A, fa

PTM = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
def _my(t): return f'{PTM[t.month - 1]} {t.year}'

def band_rule_v32():
    reg = {t['symbol']: t for t in json.load(open(os.path.join(V32, 'executor_registry_base_v32.json')))['tokens']}
    cfg = json.load(open(os.path.join(T7.ST, 'stable_feeds.json')))
    ev = pd.read_csv(os.path.join(ROOT, 'results', 'v3', 't7_events.csv'), parse_dates=['start', 'recovered_at'])
    ev = ev[(ev.hourly_confirmed != False) & ev.keeper_series.str.startswith('Chainlink (Ethereum)') & (ev.confirmed == True) & ev.symbol.isin(['USDT', 'DAI'])]
    scopes = []
    for sym in ('USDT', 'DAI'):
        rb = stable_rounds(f'{sym}_base'); first = pd.to_datetime(rb.updatedAt.min(), unit='s').ceil('h')
        scopes.append((f'{sym} · Base · {_my(first)} – Nov 2026', sym, f'{sym}_base', pd.date_range(first, '2026-11-06 23:00', freq='h'),
                       float(reg[sym]['directory_threshold_pct']) / 100, float(reg[sym]['maxStaleness'])))
        thr_e, max_e = float(cfg[sym]['threshold']) / 100, float(cfg[sym]['heartbeat']) * 90000 / 86400
        scopes.append((f'{sym} · Ethereum · Jan 2021 – Nov 2026', sym, f'{sym}_eth', pd.date_range('2021-01-01', '2026-11-06 23:00', freq='h'), thr_e, max_e))
        for _, e in ev[ev.symbol == sym].iterrows():
            a = e.start.floor('h') - pd.Timedelta(days=3); b = (e.recovered_at if pd.notna(e.recovered_at) else e.start + pd.Timedelta(days=10)) + pd.Timedelta(days=3)
            b = min(b, a + pd.Timedelta(days=45))
            scopes.append((f'{sym} · {_my(e.start)} · descolamento de {e.max_drop_pct:.1f}% (Ethereum)'.replace('.', ','), sym, f'{sym}_eth',
                           pd.date_range(a, b.floor('h'), freq='h'), thr_e, max_e))
    rows = []
    for lab, sym, src, idx, thr, max_s in scopes:
        p, age = e3.sample_rounds(stable_rounds(src), e3.to_epoch(idx))
        pdl = dl_near(sym, idx); cnd = _candle_open(sym, idx)
        for band in BANDS:
            q, P, A, fa = _decide(p, age, pdl, band, thr, max_s)
            tr = np.where(np.isnan(cnd), -9, (np.abs(cnd - 1) > band).astype(int)); has = tr != -9
            def fo(x): return int(((x == 1) & (tr == 0)).sum())
            def mi(x): return int(((x == 0) & (tr == 1)).sum())
            rows.append(dict(scope=lab, token=sym, feed=STABLE_LABEL[src], threshold_pct=thr * 100, max_staleness_s=max_s, band_pct=band * 100,
                             hours=len(idx), hours_with_2nd_series=int(has.sum()), feed_decides_arch=int(fa.sum()),
                             changed_vs_quorum=int((A != q).sum()), stricter_vs_quorum=int(((A == 1) & (q != 1)).sum()), looser_vs_quorum=int(((q == 1) & (A != 1)).sum()),
                             changed_vs_v31=int((A != P).sum()),
                             out_quorum=int((q == 1).sum()), out_v31=int((P == 1).sum()), out_arch=int((A == 1).sum()),
                             skip_quorum=int((q == -1).sum()), skip_v31=int((P == -1).sum()), skip_arch=int((A == -1).sum()),
                             false_out_quorum=fo(q), false_out_v31=fo(P), false_out_arch=fo(A),
                             missed_out_quorum=mi(q), missed_out_v31=mi(P), missed_out_arch=mi(A), true_out=int((tr == 1).sum()),
                             eliminated_vs_quorum=int(((q == 1) & (tr == 0) & (A != 1)).sum()), created_vs_quorum=int(((A == 1) & (tr == 0) & (q != 1)).sum()),
                             first_out_arch=str(idx[np.argmax(A == 1)]) if (A == 1).any() else '', min_feed=float(np.nanmin(p)), min_quorum=float(np.nanmin(pdl))))
    return pd.DataFrame(rows)

# ------------------------------------------------------------------ §B3 the >10% warning when the leg is USDT or DAI
def warning_check():
    w = pd.read_csv(os.path.join(ROOT, 'results', 'v31', 'aviso_banda.csv'))
    ev = pd.read_csv(os.path.join(ROOT, 'results', 'v3', 't7_events.csv'), parse_dates=['start'])
    daily = pd.read_csv(os.path.join(T7.ST, 'dl_daily_all_usd.csv')); u0 = pd.to_datetime(daily.date.min(), unit='s').normalize()
    ok = ev[(ev.hourly_confirmed != False) & (ev.confirmed != False) & (ev.start >= u0)]
    rows = []
    for _, r in w.iterrows():
        X = r.band_pct; e = ok[ok.max_drop_pct > X]
        rec = dict(band_pct=X, N_stables=r.N_stables, R_stables=r.R_stables, days=r.days, text=r.text, problems=r.problems if r.problems == r.problems else '')
        for sym in ('USDT', 'DAI'):
            es = e[e.symbol == sym]
            rec[f'{sym}_in_N'] = bool(len(es)); rec[f'{sym}_in_R'] = bool(es.recovered.any()) if len(es) else False
        rec['text_depends_on_leg'] = False                       # N, R and D come from the whole universe, never from the leg
        rows.append(rec)
    out = pd.DataFrame(rows)
    leg = ok[ok.symbol.isin(['USDT', 'DAI'])][['symbol', 'start', 'max_drop_pct', 'recovered', 'days_to_recover', 'keeper_series']]
    return out, leg

def run_b():
    feed_params().to_csv(os.path.join(R32, 'feeds_usdt_dai_base.csv'), index=False)
    band_rule_v32().to_csv(os.path.join(R32, 'banda_regra_usdt_dai.csv'), index=False)
    w, leg = warning_check()
    w.to_csv(os.path.join(R32, 'aviso_usdt_dai.csv'), index=False); leg.to_csv(os.path.join(R32, 'aviso_eventos_usdt_dai.csv'), index=False)

if __name__ == '__main__':
    import time; t = time.time()
    run_all(sys.argv[1:] or None); print('A', time.time() - t, flush=True)
    run_bands(); print('B4', time.time() - t, flush=True)
    run_b(); print('B', time.time() - t, flush=True)
